use std::env;
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use std::{
    collections::{HashMap, HashSet, VecDeque},
};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tempfile::Builder;
use uuid::Uuid;

use crate::bootstrap::prepare_for_plan;
use crate::config::AppConfig;
use crate::hooks::{emit_hook_event, HookRunOptions};
use crate::llm::resolve_profile;
use crate::marketplace::track_task_event;
use crate::model::{
    AgentMessage, AgentResult, AgentSpec, ChildRuntimePolicy, ChildSpawnRequest, ExecutionKind,
    HookRequest, IsolationMode, ManagerMessage, SocketChannelOp, SocketChannelRequest,
    TaskReport, TaskRequest,
};
use crate::policy::plan_agents;
use crate::runtime::{missing_connector_auth, spawn_agent, AgentConnect};
use crate::transport::{recv_json_line, send_json_line};
use crate::ui_pages::publish_agent_pages;
use crate::{auth, hooks};
use crate::package_ledger::record_task_report;

pub fn run_task(config: &AppConfig, request: TaskRequest) -> Result<TaskReport> {
    let mut request = request;
    // Caller metadata is manager-internal and must not be accepted from external task entrypoints.
    request.caller_task_id = None;
    request.caller_agent_id = None;
    request.caller_resource = None;

    emit_hook_event(
        &config.hooks,
        "task.auth.check.started",
        &json!({ "task": &request }),
    )?;
    if let Err(err) = auth::ensure_task_auth(&config.auth) {
        let _ = emit_hook_event(
            &config.hooks,
            "task.auth.check.failed",
            &json!({ "task": &request, "error": err.to_string() }),
        );
        return Err(err);
    }
    emit_hook_event(
        &config.hooks,
        "task.auth.check.passed",
        &json!({ "task": &request }),
    )?;
    let mut socket_bus = SocketBus::new(config);
    seed_plugin_discovery_channels(config, &mut socket_bus);
    let report = run_task_internal(config, request.clone(), 0, &mut socket_bus)?;
    emit_hook_event(
        &config.hooks,
        "task.completed",
        &json!({ "task": &request, "report": &report }),
    )?;
    match record_task_report(config, &request, &report) {
        Ok(Some(summary)) => {
            let _ = emit_hook_event(
                &config.hooks,
                "task.package_ledger.recorded",
                &json!({ "task": &request, "summary": summary }),
            );
        }
        Ok(None) => {}
        Err(err) => {
            eprintln!("package ledger sync skipped: {}", err);
            let _ = emit_hook_event(
                &config.hooks,
                "task.package_ledger.failed",
                &json!({ "task": &request, "error": err.to_string() }),
            );
        }
    }
    if let Err(err) = track_task_event(&config.marketplace, &request, &report) {
        eprintln!("marketplace tracking skipped: {}", err);
        let _ = emit_hook_event(
            &config.hooks,
            "task.marketplace.failed",
            &json!({ "task": &request, "error": err.to_string() }),
        );
    } else {
        emit_hook_event(
            &config.hooks,
            "task.marketplace.sent",
            &json!({ "task": &request }),
        )?;
    }
    Ok(report)
}

fn run_task_internal(
    config: &AppConfig,
    request: TaskRequest,
    depth: usize,
    socket_bus: &mut SocketBus,
) -> Result<TaskReport> {
    let plan = plan_agents(config, &request)?;
    prepare_for_plan(config, &plan)?;
    let task_context = json!({
        "task": &request,
        "planned_agents": &plan,
        "spawn_depth": depth,
    });
    emit_hook_event(&config.hooks, "task.pre", &task_context)?;
    emit_hook_event(&config.hooks, "task.plan.ready", &task_context)?;

    let current_exe = env::current_exe().context("failed to resolve current executable")?;
    let working_dir = prepare_socket_working_dir(config, &plan)?;
    fs::set_permissions(working_dir.path(), fs::Permissions::from_mode(0o755))
        .context("failed to set socket temp directory permissions")?;

    let mut results = Vec::new();

    for spec in &plan {
        let missing_auth = missing_connector_auth(config, spec);
        if !missing_auth.is_empty() {
            anyhow::bail!(
                "connector auth missing for agent {}: {}",
                spec.id,
                missing_auth.join(", ")
            );
        }

        let transports = container_transport_candidates(spec);
        let attempt_total = transports.len();
        let mut last_error: Option<anyhow::Error> = None;
        let mut completed_result: Option<AgentResult> = None;

        for (attempt_idx, transport) in transports.iter().copied().enumerate() {
            let attempt = attempt_idx + 1;
            emit_hook_event(
                &config.hooks,
                "agent.channel.prepare",
                &json!({
                    "task_id": request.id,
                    "spec": spec,
                    "transport": transport.as_str(),
                    "attempt": attempt,
                    "attempt_total": attempt_total,
                }),
            )?;

            let channel = match prepare_agent_channel(config, working_dir.path(), spec, transport) {
                Ok(channel) => channel,
                Err(err) => {
                    last_error = Some(err.context(format!(
                        "failed preparing channel for {} (transport={})",
                        spec.id,
                        transport.as_str()
                    )));
                    maybe_emit_transport_retry(
                        config,
                        &request.id,
                        spec,
                        attempt,
                        attempt_total,
                        transport,
                    );
                    continue;
                }
            };

            emit_hook_event(
                &config.hooks,
                "agent.pre_spawn",
                &json!({
                    "spec": spec,
                    "transport": transport.as_str(),
                    "attempt": attempt,
                    "attempt_total": attempt_total,
                }),
            )?;
            let mut child = match spawn_agent(&current_exe, config, spec, &channel.connect) {
                Ok(child) => child,
                Err(err) => {
                    last_error = Some(err.context(format!(
                        "failed spawning agent {} (transport={})",
                        spec.id,
                        transport.as_str()
                    )));
                    maybe_emit_transport_retry(
                        config,
                        &request.id,
                        spec,
                        attempt,
                        attempt_total,
                        transport,
                    );
                    continue;
                }
            };
            emit_hook_event(
                &config.hooks,
                "agent.spawned",
                &json!({
                    "task_id": request.id,
                    "spec": spec,
                    "transport": transport.as_str(),
                    "attempt": attempt,
                    "attempt_total": attempt_total,
                }),
            )?;

            let (reader_stream, writer_stream) =
                match accept_agent_stream(channel.listener, &spec.id, &mut child) {
                    Ok(streams) => streams,
                    Err(err) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        last_error = Some(err.context(format!(
                            "agent {} failed to connect (transport={})",
                            spec.id,
                            transport.as_str()
                        )));
                        maybe_emit_transport_retry(
                            config,
                            &request.id,
                            spec,
                            attempt,
                            attempt_total,
                            transport,
                        );
                        continue;
                    }
                };
            emit_hook_event(
                &config.hooks,
                "agent.connected",
                &json!({
                    "task_id": request.id,
                    "spec": spec,
                    "transport": transport.as_str(),
                    "attempt": attempt,
                    "attempt_total": attempt_total,
                }),
            )?;
            let mut reader = BufReader::new(reader_stream);
            let mut writer = BufWriter::new(writer_stream);

            let llm = if spec.execution == ExecutionKind::Noop {
                Some(resolve_profile(config, &spec.llm_profile).with_context(|| {
                    format!(
                        "failed to resolve llm profile {} for agent {}",
                        spec.llm_profile, spec.id
                    )
                })?)
            } else {
                None
            };

            let message = ManagerMessage::Run {
                request: request.clone(),
                spec: spec.clone(),
                llm,
                child_policy: child_policy_for_agent(config, spec, depth),
            };
            send_json_line(&mut writer, &message)?;
            emit_hook_event(
                &config.hooks,
                "agent.run.dispatched",
                &json!({ "task_id": request.id, "spec": spec }),
            )?;

            let mut agent_result = match collect_agent_response(
                config,
                &request,
                spec,
                depth,
                socket_bus,
                &mut reader,
                &mut writer,
            ) {
                Ok(result) => result,
                Err(err) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    last_error = Some(err);
                    break;
                }
            };
            let ui_publish = publish_agent_pages(&config.ui, &request, &mut agent_result);
            if !ui_publish.published.is_empty() {
                let _ = emit_hook_event(
                    &config.hooks,
                    "agent.ui_page.published",
                    &json!({
                        "task_id": request.id,
                        "agent_id": spec.id,
                        "pages": ui_publish.published,
                    }),
                );
            }
            if !ui_publish.errors.is_empty() {
                let _ = emit_hook_event(
                    &config.hooks,
                    "agent.ui_page.publish_failed",
                    &json!({
                        "task_id": request.id,
                        "agent_id": spec.id,
                        "errors": ui_publish.errors,
                    }),
                );
            }

            let status = child
                .wait()
                .with_context(|| format!("failed waiting for {}", spec.id))?;
            if !status.success() {
                last_error = Some(anyhow::anyhow!(
                    "agent {} exited with status {}",
                    spec.id,
                    status
                ));
                break;
            }

            emit_hook_event(&config.hooks, "agent.post", &agent_result)?;
            emit_hook_event(
                &config.hooks,
                "agent.completed",
                &json!({ "task_id": request.id, "spec": spec, "result": &agent_result }),
            )?;
            completed_result = Some(agent_result);
            break;
        }

        if let Some(result) = completed_result {
            results.push(result);
            continue;
        }

        if let Some(err) = last_error {
            return Err(err);
        }
        anyhow::bail!("agent {} failed before execution", spec.id);
    }

    let report = TaskReport {
        task_id: request.id.clone(),
        task_summary: request.summary.clone(),
        agents: results,
    };
    emit_hook_event(&config.hooks, "task.post", &report)?;
    Ok(report)
}

fn maybe_emit_transport_retry(
    config: &AppConfig,
    task_id: &str,
    spec: &AgentSpec,
    attempt: usize,
    attempt_total: usize,
    transport: ContainerTransport,
) {
    if spec.isolation != IsolationMode::Container || attempt >= attempt_total {
        return;
    }
    let _ = emit_hook_event(
        &config.hooks,
        "agent.transport.retry",
        &json!({
            "task_id": task_id,
            "spec": spec,
            "transport": transport.as_str(),
            "attempt": attempt,
            "attempt_total": attempt_total,
        }),
    );
}

fn prepare_socket_working_dir(config: &AppConfig, plan: &[AgentSpec]) -> Result<tempfile::TempDir> {
    if should_use_workspace_socket_dir(config, plan) {
        let cwd = env::current_dir().context("failed to resolve workspace path")?;
        let root = cwd.join(".pka");
        fs::create_dir_all(&root).with_context(|| {
            format!(
                "failed to create workspace socket directory {}",
                root.display()
            )
        })?;
        return Builder::new()
            .prefix("pka-")
            .tempdir_in(&root)
            .context("failed to create workspace socket temp directory");
    }

    Builder::new()
        .prefix("pka-")
        .tempdir_in("/tmp")
        .context("failed to create temp directory for sockets")
}

fn should_use_workspace_socket_dir(config: &AppConfig, plan: &[AgentSpec]) -> bool {
    if !cfg!(target_os = "macos") || !config.orchestrator.mount_workspace {
        return false;
    }
    plan.iter().any(|spec| {
        spec.isolation == IsolationMode::Container
            && container_transport_candidates(spec).contains(&ContainerTransport::Socket)
    })
}

struct AgentChannel {
    connect: AgentConnect,
    listener: AgentListener,
}

enum AgentListener {
    Unix(UnixListener),
    Tcp(TcpListener),
    Stdio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerTransport {
    Socket,
    Tcp,
    Stdio,
}

impl ContainerTransport {
    fn as_str(self) -> &'static str {
        match self {
            Self::Socket => "socket",
            Self::Tcp => "tcp",
            Self::Stdio => "stdio",
        }
    }
}

fn prepare_agent_channel(
    config: &AppConfig,
    base_dir: &Path,
    spec: &AgentSpec,
    transport: ContainerTransport,
) -> Result<AgentChannel> {
    if spec.isolation == IsolationMode::Container {
        match transport {
            ContainerTransport::Stdio => {
                return Ok(AgentChannel {
                    connect: AgentConnect::Stdio,
                    listener: AgentListener::Stdio,
                });
            }
            ContainerTransport::Tcp => {
                let listener = TcpListener::bind("0.0.0.0:0")
                    .with_context(|| format!("failed to bind TCP listener for {}", spec.id))?;
                let port = listener
                    .local_addr()
                    .context("failed to read TCP listener address")?
                    .port();
                let host = resolve_container_tcp_host(config, spec);
                return Ok(AgentChannel {
                    connect: AgentConnect::TcpAddress(format!("{}:{}", host, port)),
                    listener: AgentListener::Tcp(listener),
                });
            }
            ContainerTransport::Socket => {}
        }
    }

    let socket_path = socket_path_for_agent(base_dir.to_path_buf(), &spec.id);
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("failed to bind {}", socket_path.display()))?;
    Ok(AgentChannel {
        connect: AgentConnect::UnixSocket(socket_path),
        listener: AgentListener::Unix(listener),
    })
}

fn accept_agent_stream(
    listener: AgentListener,
    spec_id: &str,
    child: &mut std::process::Child,
) -> Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    const AGENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
    const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(25);
    let start = Instant::now();

    match listener {
        AgentListener::Unix(listener) => {
            listener
                .set_nonblocking(true)
                .context("failed to set unix listener nonblocking")?;
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream
                            .set_nonblocking(false)
                            .context("failed to set unix stream blocking mode")?;
                        let reader_stream = stream
                            .try_clone()
                            .context("failed to clone unix stream for manager read")?;
                        return Ok((Box::new(reader_stream), Box::new(stream)));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        check_child_and_timeout(spec_id, child, start, AGENT_CONNECT_TIMEOUT)?;
                        thread::sleep(ACCEPT_RETRY_DELAY);
                    }
                    Err(err) => {
                        return Err(err)
                            .with_context(|| format!("agent {} did not connect", spec_id))
                    }
                }
            }
        }
        AgentListener::Tcp(listener) => {
            listener
                .set_nonblocking(true)
                .context("failed to set tcp listener nonblocking")?;
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream
                            .set_nonblocking(false)
                            .context("failed to set tcp stream blocking mode")?;
                        let reader_stream = stream
                            .try_clone()
                            .context("failed to clone tcp stream for manager read")?;
                        return Ok((Box::new(reader_stream), Box::new(stream)));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        check_child_and_timeout(spec_id, child, start, AGENT_CONNECT_TIMEOUT)?;
                        thread::sleep(ACCEPT_RETRY_DELAY);
                    }
                    Err(err) => {
                        return Err(err).with_context(|| {
                            format!("agent {} did not connect over TCP", spec_id)
                        });
                    }
                }
            }
        }
        AgentListener::Stdio => {
            let reader = child
                .stdout
                .take()
                .ok_or_else(|| anyhow::anyhow!("agent {} stdout was not piped", spec_id))?;
            let writer = child
                .stdin
                .take()
                .ok_or_else(|| anyhow::anyhow!("agent {} stdin was not piped", spec_id))?;
            Ok((Box::new(reader), Box::new(writer)))
        }
    }
}

fn check_child_and_timeout(
    spec_id: &str,
    child: &mut std::process::Child,
    start: Instant,
    timeout: Duration,
) -> Result<()> {
    if let Some(status) = child
        .try_wait()
        .with_context(|| format!("failed to check status for {}", spec_id))?
    {
        anyhow::bail!(
            "agent {} exited before connecting (status: {})",
            spec_id,
            status
        );
    }

    if start.elapsed() > timeout {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!("agent {} did not connect within {:?}", spec_id, timeout);
    }
    Ok(())
}

fn container_transport(spec: &AgentSpec) -> ContainerTransport {
    if spec.isolation != IsolationMode::Container {
        return ContainerTransport::Socket;
    }
    if let Some(override_transport) = forced_container_transport() {
        return override_transport;
    }
    #[cfg(target_os = "macos")]
    {
        // macOS host reachability from containers can vary by runtime (Docker Desktop/Colima/OrbStack).
        // stdio avoids host networking for manager<->agent control channel.
        return ContainerTransport::Stdio;
    }
    #[cfg(not(target_os = "macos"))]
    {
        ContainerTransport::Socket
    }
}

fn container_transport_candidates(spec: &AgentSpec) -> Vec<ContainerTransport> {
    if spec.isolation != IsolationMode::Container {
        return vec![ContainerTransport::Socket];
    }
    if let Some(override_transport) = forced_container_transport() {
        return vec![override_transport];
    }

    let mut out = vec![container_transport(spec)];
    for candidate in [
        ContainerTransport::Socket,
        ContainerTransport::Tcp,
        ContainerTransport::Stdio,
    ] {
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

fn forced_container_transport() -> Option<ContainerTransport> {
    let raw = env::var("PINOKIO_CONTAINER_TRANSPORT").ok()?;
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "tcp" => Some(ContainerTransport::Tcp),
        "socket" | "unix" => Some(ContainerTransport::Socket),
        "stdio" | "pipe" => Some(ContainerTransport::Stdio),
        _ => None,
    }
}

fn resolve_container_tcp_host(config: &AppConfig, spec: &AgentSpec) -> String {
    if let Ok(explicit) = env::var("PINOKIO_CONTAINER_HOST") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let _ = config;
    let _ = spec;
    "host.docker.internal".to_string()
}

#[derive(Debug, Clone, serde::Serialize)]
struct SocketEnvelope {
    seq: u64,
    channel: String,
    sender_agent_id: String,
    sender_resource: String,
    payload: serde_json::Value,
}

struct SocketBus {
    next_seq: u64,
    max_channel_messages: usize,
    channels: HashMap<String, VecDeque<SocketEnvelope>>,
    storage_dir: PathBuf,
}

impl SocketBus {
    fn new(config: &AppConfig) -> Self {
        let max_channel_messages = config.manager.socket_bus_max_channel_messages.clamp(16, 4096);
        let storage_dir = resolve_socket_bus_storage_dir();
        Self {
            next_seq: 1,
            max_channel_messages,
            channels: HashMap::new(),
            storage_dir,
        }
    }

    fn publish(
        &mut self,
        channel: &str,
        sender_agent_id: &str,
        sender_resource: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        let envelope = SocketEnvelope {
            seq,
            channel: channel.to_string(),
            sender_agent_id: sender_agent_id.to_string(),
            sender_resource: sender_resource.to_string(),
            payload,
        };
        let (persisted, channel_depth) = {
            let queue = self.channels.entry(channel.to_string()).or_default();
            queue.push_back(envelope);
            while queue.len() > self.max_channel_messages {
                let _ = queue.pop_front();
            }
            (queue.back().cloned(), queue.len())
        };
        self.persist_message(channel, persisted.as_ref());
        json!({
            "ok": true,
            "op": "publish",
            "channel": channel,
            "seq": seq,
            "channel_depth": channel_depth,
            "storage_dir": self.storage_dir.display().to_string(),
        })
    }

    fn read(
        &self,
        channel: &str,
        max_messages: usize,
        since_seq: Option<u64>,
        sender_filter: Option<&str>,
    ) -> serde_json::Value {
        let queue = self
            .channels
            .get(channel)
            .map(|q| q.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        let mut out = Vec::new();
        for message in queue {
            if let Some(seq) = since_seq {
                if message.seq <= seq {
                    continue;
                }
            }
            if let Some(filter) = sender_filter {
                if message.sender_agent_id != filter {
                    continue;
                }
            }
            out.push(message.clone());
            if out.len() >= max_messages {
                break;
            }
        }
        json!({
            "ok": true,
            "op": "read",
            "channel": channel,
            "messages": out,
            "channel_depth": self.channels.get(channel).map(|q| q.len()).unwrap_or(0),
            "storage_dir": self.storage_dir.display().to_string(),
        })
    }

    fn consume(
        &mut self,
        channel: &str,
        max_messages: usize,
        since_seq: Option<u64>,
        sender_filter: Option<&str>,
    ) -> serde_json::Value {
        let Some(queue) = self.channels.get_mut(channel) else {
            return json!({
                "ok": true,
                "op": "consume",
                "channel": channel,
                "messages": [],
                "channel_depth": 0,
            });
        };

        let mut consumed = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(message) = queue.pop_front() {
            let mut should_take = true;
            if let Some(seq) = since_seq {
                if message.seq <= seq {
                    should_take = false;
                }
            }
            if let Some(filter) = sender_filter {
                if message.sender_agent_id != filter {
                    should_take = false;
                }
            }
            if should_take && consumed.len() < max_messages {
                consumed.push(message);
            } else {
                retained.push_back(message);
            }
        }
        *queue = retained;
        json!({
            "ok": true,
            "op": "consume",
            "channel": channel,
            "messages": consumed,
            "channel_depth": queue.len(),
            "storage_dir": self.storage_dir.display().to_string(),
        })
    }

    fn persist_message(&self, channel: &str, message: Option<&SocketEnvelope>) {
        let Some(message) = message else {
            return;
        };
        if !self.storage_dir.exists() {
            let _ = fs::create_dir_all(&self.storage_dir);
        }
        let file_name = format!("{}.jsonl", sanitize_channel_file_name(channel));
        let path = self.storage_dir.join(file_name);
        let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        else {
            return;
        };
        let Ok(line) = serde_json::to_string(message) else {
            return;
        };
        let _ = writeln!(file, "{}", line);
    }
}

const SOCKET_CHANNEL_GLOBAL: &str = "global";
const SOCKET_CHANNEL_PLUGINS_INDEX: &str = "plugins:index";
const PLUGIN_README_MAX_BYTES: usize = 256 * 1024;
const PLUGIN_README_PREVIEW_CHARS: usize = 420;

#[derive(Debug, Clone)]
struct PluginDiscoveryEntry {
    manifest_id: String,
    name: String,
    version: String,
    description: String,
    manifest_path: Option<PathBuf>,
    runtime_mode: Option<String>,
    requires_container: Option<bool>,
    unsafe_host_access: Option<bool>,
    plugins: Vec<String>,
    resources: Vec<String>,
    services: Vec<String>,
    skills: Vec<String>,
    readme_path: Option<PathBuf>,
    readme_content: String,
    readme_truncated: bool,
}

fn seed_plugin_discovery_channels(config: &AppConfig, socket_bus: &mut SocketBus) {
    let entries = collect_plugin_discovery_entries(config);
    if entries.is_empty() {
        return;
    }

    let mut index_rows = Vec::new();
    for entry in entries {
        let token = sanitize_channel_token(&entry.manifest_id);
        let meta_channel = format!("plugin:{}:meta", token);
        let readme_channel = format!("plugin:{}:readme", token);
        let readme_source = entry
            .readme_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "generated".to_string());
        let readme_preview = truncate_chars(&entry.readme_content, PLUGIN_README_PREVIEW_CHARS);
        let manifest_path = entry
            .manifest_path
            .as_ref()
            .map(|path| path.display().to_string());

        socket_bus.publish(
            &meta_channel,
            "manager",
            "system:plugins",
            json!({
                "schema": "pinokio.plugin.meta/v1",
                "manifest_id": entry.manifest_id,
                "name": entry.name,
                "version": entry.version,
                "description": entry.description,
                "manifest_path": manifest_path,
                "runtime_mode": entry.runtime_mode,
                "requires_container": entry.requires_container,
                "unsafe_host_access": entry.unsafe_host_access,
                "plugins": entry.plugins,
                "resources": entry.resources,
                "services": entry.services,
                "skills": entry.skills,
                "readme_channel": readme_channel,
                "readme_source": readme_source,
                "readme_preview": readme_preview,
            }),
        );

        socket_bus.publish(
            &readme_channel,
            "manager",
            "system:plugins",
            json!({
                "schema": "pinokio.plugin.readme/v1",
                "manifest_id": entry.manifest_id,
                "name": entry.name,
                "version": entry.version,
                "description": entry.description,
                "content_format": "markdown",
                "content": entry.readme_content,
                "source_path": entry.readme_path.as_ref().map(|path| path.display().to_string()),
                "truncated": entry.readme_truncated,
            }),
        );

        index_rows.push(json!({
            "manifest_id": entry.manifest_id,
            "name": entry.name,
            "version": entry.version,
            "description": entry.description,
            "runtime_mode": entry.runtime_mode,
            "requires_container": entry.requires_container,
            "unsafe_host_access": entry.unsafe_host_access,
            "plugins": entry.plugins,
            "resources": entry.resources,
            "services": entry.services,
            "skills": entry.skills,
            "meta_channel": meta_channel,
            "readme_channel": readme_channel,
        }));
    }

    socket_bus.publish(
        SOCKET_CHANNEL_PLUGINS_INDEX,
        "manager",
        "system:plugins",
        json!({
            "schema": "pinokio.plugins.index/v1",
            "count": index_rows.len(),
            "plugins": index_rows,
            "query": {
                "catalog_channel": SOCKET_CHANNEL_PLUGINS_INDEX,
                "meta_channel_template": "plugin:{manifest_id}:meta",
                "readme_channel_template": "plugin:{manifest_id}:readme",
            },
        }),
    );

    socket_bus.publish(
        SOCKET_CHANNEL_GLOBAL,
        "manager",
        "system:plugins",
        json!({
            "schema": "pinokio.plugins.announce/v1",
            "catalog_channel": SOCKET_CHANNEL_PLUGINS_INDEX,
            "message": "Plugin catalog and README channels are ready.",
        }),
    );
}

fn collect_plugin_discovery_entries(config: &AppConfig) -> Vec<PluginDiscoveryEntry> {
    let mut out = Vec::new();
    let mut managed_plugin_names = HashSet::new();

    let mut installed = config
        .plugin_registry
        .installed_manifests
        .iter()
        .collect::<Vec<_>>();
    installed.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    for (manifest_id, installed_manifest) in installed {
        let manifest_path = resolve_discovery_manifest_path(&installed_manifest.manifest_path);
        let manifest_doc = manifest_path
            .as_deref()
            .and_then(load_manifest_document_for_discovery);

        let name = manifest_doc
            .as_ref()
            .and_then(|doc| doc.get("name"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| {
                let value = installed_manifest.name.trim();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            })
            .unwrap_or_else(|| manifest_id.to_string());

        let version = manifest_doc
            .as_ref()
            .and_then(|doc| doc.get("version"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| {
                let value = installed_manifest.version.trim();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            })
            .unwrap_or_else(|| "unknown".to_string());

        let description = manifest_doc
            .as_ref()
            .and_then(|doc| doc.get("description"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| "No description provided.".to_string());

        let mut plugins =
            manifest_object_name_array(manifest_doc.as_ref(), &["plugins"], "name");
        if plugins.is_empty() {
            plugins = installed_manifest.plugins.clone();
        }
        plugins = sorted_unique_strings(plugins);
        for plugin in &plugins {
            managed_plugin_names.insert(plugin.clone());
        }

        let resources = sorted_unique_strings(manifest_string_array(
            manifest_doc.as_ref(),
            &["extends", "resources"],
        ));
        let services = if !installed_manifest.services.is_empty() {
            sorted_unique_strings(installed_manifest.services.clone())
        } else {
            sorted_unique_strings(manifest_object_name_array(
                manifest_doc.as_ref(),
                &["services"],
                "name",
            ))
        };
        let skills = if !installed_manifest.skills.is_empty() {
            sorted_unique_strings(installed_manifest.skills.clone())
        } else {
            sorted_unique_strings(manifest_object_name_array(
                manifest_doc.as_ref(),
                &["skills"],
                "name",
            ))
        };

        let runtime_mode = manifest_doc
            .as_ref()
            .and_then(|doc| doc.get("runtime"))
            .and_then(|runtime| runtime.get("mode"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let requires_container = manifest_doc
            .as_ref()
            .and_then(|doc| doc.get("runtime"))
            .and_then(|runtime| runtime.get("requires_container"))
            .and_then(|value| value.as_bool());
        let unsafe_host_access = manifest_doc
            .as_ref()
            .and_then(|doc| doc.get("runtime"))
            .and_then(|runtime| runtime.get("unsafe_host_access"))
            .and_then(|value| value.as_bool());

        let readme_path = resolve_plugin_readme_path(manifest_path.as_deref(), manifest_doc.as_ref());
        let (mut readme_content, mut readme_truncated) = readme_path
            .as_deref()
            .and_then(|path| load_text_file_with_limit(path, PLUGIN_README_MAX_BYTES))
            .unwrap_or_else(|| (String::new(), false));

        let mut entry = PluginDiscoveryEntry {
            manifest_id: manifest_id.to_string(),
            name,
            version,
            description,
            manifest_path,
            runtime_mode,
            requires_container,
            unsafe_host_access,
            plugins,
            resources,
            services,
            skills,
            readme_path,
            readme_content: String::new(),
            readme_truncated,
        };

        if readme_content.trim().is_empty() {
            readme_content = build_generated_plugin_readme(config, &entry);
            readme_truncated = false;
            entry.readme_path = None;
        }
        entry.readme_content = readme_content;
        entry.readme_truncated = readme_truncated;

        out.push(entry);
    }

    let mut config_only_plugins = config.plugins.keys().cloned().collect::<Vec<_>>();
    config_only_plugins.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    for plugin_name in config_only_plugins {
        if managed_plugin_names.contains(&plugin_name) {
            continue;
        }
        let Some(plugin) = config.plugins.get(&plugin_name) else {
            continue;
        };
        let mut entry = PluginDiscoveryEntry {
            manifest_id: format!("config.{}", plugin_name),
            name: plugin_name.clone(),
            version: "config".to_string(),
            description: "Config-defined plugin without a manifest document.".to_string(),
            manifest_path: None,
            runtime_mode: Some(if plugin.host_only {
                "host".to_string()
            } else {
                "container".to_string()
            }),
            requires_container: Some(!plugin.host_only),
            unsafe_host_access: Some(plugin.host_only),
            plugins: vec![plugin_name.clone()],
            resources: vec![format!("plugin:{}", plugin_name)],
            services: Vec::new(),
            skills: Vec::new(),
            readme_path: None,
            readme_content: String::new(),
            readme_truncated: false,
        };
        entry.readme_content = build_generated_plugin_readme(config, &entry);
        out.push(entry);
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn build_generated_plugin_readme(config: &AppConfig, entry: &PluginDiscoveryEntry) -> String {
    let mut lines = Vec::new();
    lines.push(format!("# {}", entry.name));
    lines.push(String::new());
    lines.push(entry.description.clone());
    lines.push(String::new());
    lines.push(format!("- Manifest ID: `{}`", entry.manifest_id));
    lines.push(format!("- Version: `{}`", entry.version));
    if let Some(mode) = &entry.runtime_mode {
        lines.push(format!("- Runtime mode: `{}`", mode));
    }
    if let Some(value) = entry.requires_container {
        lines.push(format!("- Requires container: `{}`", value));
    }
    if let Some(value) = entry.unsafe_host_access {
        lines.push(format!("- Unsafe host access: `{}`", value));
    }
    lines.push(String::new());
    lines.push("## Components".to_string());
    if entry.plugins.is_empty() {
        lines.push("- Plugins: none".to_string());
    } else {
        lines.push(format!("- Plugins: {}", entry.plugins.join(", ")));
    }
    if entry.resources.is_empty() {
        lines.push("- Resources: none".to_string());
    } else {
        lines.push(format!("- Resources: {}", entry.resources.join(", ")));
    }
    if entry.services.is_empty() {
        lines.push("- Services: none".to_string());
    } else {
        lines.push(format!("- Services: {}", entry.services.join(", ")));
    }
    if entry.skills.is_empty() {
        lines.push("- Skills: none".to_string());
    } else {
        lines.push(format!("- Skills: {}", entry.skills.join(", ")));
    }

    if !entry.plugins.is_empty() {
        lines.push(String::new());
        lines.push("## Plugin Commands".to_string());
        for plugin_name in &entry.plugins {
            if let Some(plugin) = config.plugins.get(plugin_name) {
                let actions = if plugin.allowed_actions.is_empty() {
                    "all".to_string()
                } else {
                    plugin.allowed_actions.join(",")
                };
                let deps = if plugin.dependencies.is_empty() {
                    "none".to_string()
                } else {
                    plugin.dependencies.join(",")
                };
                lines.push(format!(
                    "- `{}`: command=`{}`, actions=`{}`, dependencies=`{}`",
                    plugin_name, plugin.command, actions, deps
                ));
            } else {
                lines.push(format!("- `{}`: config entry unavailable", plugin_name));
            }
        }
    }

    lines.push(String::new());
    lines.push("## Socket Discovery".to_string());
    lines.push(format!(
        "- Read catalog channel: `{}`",
        SOCKET_CHANNEL_PLUGINS_INDEX
    ));
    lines.push("- Read plugin metadata channel: `plugin:{manifest_id}:meta`".to_string());
    lines.push("- Read plugin README channel: `plugin:{manifest_id}:readme`".to_string());

    lines.join("\n")
}

fn resolve_discovery_manifest_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "~" || trimmed.starts_with("~/") {
        return expand_home_for_discovery(trimmed);
    }
    let initial = PathBuf::from(trimmed);
    if initial.is_absolute() {
        if initial.exists() {
            return Some(initial);
        }
        if let Some(candidate) = resolve_manifest_by_filename_fallback(&initial) {
            return Some(candidate);
        }
        return Some(initial);
    }

    let mut candidates = Vec::new();
    candidates.push(initial.clone());
    if let Some(stripped) = trimmed.strip_prefix("./") {
        candidates.push(PathBuf::from(stripped));
    }
    if let Some(stripped) = trimmed.strip_prefix("../") {
        candidates.push(PathBuf::from(stripped));
    }

    if let Ok(cwd) = env::current_dir() {
        let snapshot = candidates.clone();
        for candidate in snapshot {
            candidates.push(cwd.join(candidate));
        }
        candidates.push(cwd.join(&initial));
    }

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(cwd) = env::current_dir() {
        return Some(cwd.join(&initial));
    }
    Some(initial)
}

fn resolve_manifest_by_filename_fallback(original: &Path) -> Option<PathBuf> {
    let file_name = original.file_name()?;
    let cwd = env::current_dir().ok()?;
    let candidates = [
        cwd.join("plugins").join("manifests").join(file_name),
        cwd.join("plugin-manifests").join(file_name),
        cwd.join("plugins").join(file_name),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn expand_home_for_discovery(raw: &str) -> Option<PathBuf> {
    let home = env::var("HOME").ok()?;
    if raw == "~" {
        return Some(PathBuf::from(home));
    }
    Some(Path::new(&home).join(raw.trim_start_matches("~/")))
}

fn load_manifest_document_for_discovery(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "json" => serde_json::from_str::<Value>(&raw).ok(),
        "yaml" | "yml" => serde_yaml::from_str::<Value>(&raw).ok(),
        _ => None,
    }
}

fn resolve_plugin_readme_path(manifest_path: Option<&Path>, manifest_doc: Option<&Value>) -> Option<PathBuf> {
    if let Some(raw) = manifest_doc
        .and_then(|doc| doc.get("readme"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if let Some(path) = resolve_manifest_relative_path(manifest_path, raw) {
            if path.exists() {
                return Some(path);
            }
        }
    }

    let Some(manifest_path) = manifest_path else {
        return None;
    };
    let Some(manifest_dir) = manifest_path.parent() else {
        return None;
    };
    let candidates = [
        manifest_dir.join("README.md"),
        manifest_dir.join("readme.md"),
        manifest_dir.join("../README.md"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_manifest_relative_path(manifest_path: Option<&Path>, raw: &str) -> Option<PathBuf> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if value == "~" || value.starts_with("~/") {
        return expand_home_for_discovery(value);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Some(path);
    }
    if let Some(base) = manifest_path.and_then(|path| path.parent()) {
        return Some(base.join(path));
    }
    Some(path)
}

fn load_text_file_with_limit(path: &Path, max_bytes: usize) -> Option<(String, bool)> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return Some((String::new(), false));
    }
    let truncated = bytes.len() > max_bytes;
    let slice = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes
    };
    let mut text = String::from_utf8_lossy(slice).to_string();
    if truncated {
        text.push_str("\n\n---\nTruncated due to size limit.\n");
    }
    Some((text, truncated))
}

fn manifest_value_at_path<'a>(manifest_doc: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    let mut current = manifest_doc?;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn manifest_string_array(manifest_doc: Option<&Value>, path: &[&str]) -> Vec<String> {
    manifest_value_at_path(manifest_doc, path)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn manifest_object_name_array(manifest_doc: Option<&Value>, path: &[&str], key: &str) -> Vec<String> {
    manifest_value_at_path(manifest_doc, path)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.get(key))
                .filter_map(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn sorted_unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.to_string();
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    out
}

fn sanitize_channel_token(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "plugin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = String::new();
    for ch in value.chars().take(max_chars) {
        out.push(ch);
    }
    out.push('…');
    out
}

fn resolve_socket_bus_storage_dir() -> PathBuf {
    if let Ok(explicit) = env::var("PINOKIO_SOCKET_BUS_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(cwd) = env::current_dir() {
        return cwd.join(".pka").join("socket-bus");
    }
    PathBuf::from("/tmp").join("pinokio-socket-bus")
}

fn sanitize_channel_file_name(channel: &str) -> String {
    let mut out = String::new();
    for ch in channel.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "channel".to_string()
    } else {
        trimmed.to_string()
    }
}

fn canonical_channel_name(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("channel is required");
    }
    if trimmed.eq_ignore_ascii_case("global") {
        return Ok("global".to_string());
    }
    Ok(trimmed.to_string())
}

fn socket_op_name(op: SocketChannelOp) -> &'static str {
    match op {
        SocketChannelOp::Publish => "publish",
        SocketChannelOp::Read => "read",
        SocketChannelOp::Consume => "consume",
    }
}

fn personal_channel_target(channel: &str) -> Option<String> {
    let target = channel.strip_prefix("agent:")?.trim();
    if target.is_empty() {
        return None;
    }
    Some(target.to_string())
}

fn handle_socket_request(
    config: &AppConfig,
    parent_spec: &AgentSpec,
    depth: usize,
    agent_id: &str,
    request: SocketChannelRequest,
    socket_bus: &mut SocketBus,
) -> ManagerMessage {
    if agent_id != parent_spec.id {
        return ManagerMessage::SocketResponse {
            approved: false,
            data: None,
            error: Some("socket request agent_id mismatch".to_string()),
        };
    }
    if !config.manager.socket_bus_enabled {
        return ManagerMessage::SocketResponse {
            approved: false,
            data: None,
            error: Some("socket bus is disabled by manager policy".to_string()),
        };
    }
    if config.manager.socket_bus_container_only && parent_spec.isolation != IsolationMode::Container
    {
        return ManagerMessage::SocketResponse {
            approved: false,
            data: None,
            error: Some(
                "socket bus is allowed only for container micro agents by manager policy"
                    .to_string(),
            ),
        };
    }

    let channel = match canonical_channel_name(&request.channel) {
        Ok(channel) => channel,
        Err(err) => {
            return ManagerMessage::SocketResponse {
                approved: false,
                data: None,
                error: Some(err.to_string()),
            }
        }
    };

    if let Some(target_agent_id) = personal_channel_target(&channel) {
        let is_self = target_agent_id.eq_ignore_ascii_case(agent_id);
        if (request.op == SocketChannelOp::Read || request.op == SocketChannelOp::Consume)
            && !is_self
        {
            return ManagerMessage::SocketResponse {
                approved: false,
                data: None,
                error: Some(format!(
                    "personal channel '{}' can only be consumed by '{}'",
                    channel, target_agent_id
                )),
            };
        }
    }

    let max_messages = request.max_messages.unwrap_or(20).clamp(1, 500);
    let sender_filter = request
        .sender_filter
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let data = match request.op {
        SocketChannelOp::Publish => {
            let Some(payload) = request.payload else {
                return ManagerMessage::SocketResponse {
                    approved: false,
                    data: None,
                    error: Some("publish operation requires payload".to_string()),
                };
            };
            socket_bus.publish(&channel, &parent_spec.id, &parent_spec.resource, payload)
        }
        SocketChannelOp::Read => {
            socket_bus.read(&channel, max_messages, request.since_seq, sender_filter)
        }
        SocketChannelOp::Consume => {
            socket_bus.consume(&channel, max_messages, request.since_seq, sender_filter)
        }
    };

    let _ = emit_hook_event(
        &config.hooks,
        "agent.socket.responded",
        &json!({
            "agent_id": agent_id,
            "channel": channel,
            "op": socket_op_name(request.op),
            "depth": depth,
        }),
    );

    ManagerMessage::SocketResponse {
        approved: true,
        data: Some(data),
        error: None,
    }
}

fn collect_agent_response(
    config: &AppConfig,
    request: &TaskRequest,
    spec: &AgentSpec,
    depth: usize,
    socket_bus: &mut SocketBus,
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
) -> Result<AgentResult> {
    loop {
        let response: AgentMessage = recv_json_line(reader)?;
        let event_kind = match &response {
            AgentMessage::Result { .. } => "result",
            AgentMessage::Error { .. } => "error",
            AgentMessage::SpawnChildRequest { .. } => "spawn_child_request",
            AgentMessage::HookRequest { .. } => "hook_request",
            AgentMessage::SocketRequest { .. } => "socket_request",
        };
        emit_hook_event(
            &config.hooks,
            "agent.message.received",
            &json!({
                "task_id": request.id,
                "agent_id": spec.id,
                "kind": event_kind,
                "depth": depth,
            }),
        )?;
        match response {
            AgentMessage::Result { summary, data, .. } => {
                emit_hook_event(
                    &config.hooks,
                    "agent.result.received",
                    &json!({
                        "task_id": request.id,
                        "agent_id": spec.id,
                        "summary": &summary,
                    }),
                )?;
                return Ok(AgentResult {
                    spec: spec.clone(),
                    summary,
                    data,
                });
            }
            AgentMessage::Error { error, .. } => {
                let _ = emit_hook_event(
                    &config.hooks,
                    "agent.error.received",
                    &json!({
                        "task_id": request.id,
                        "agent_id": spec.id,
                        "error": &error,
                    }),
                );
                anyhow::bail!("agent {} failed: {}", spec.id, error);
            }
            AgentMessage::SpawnChildRequest {
                agent_id,
                reason,
                request: child_request,
            } => {
                emit_hook_event(
                    &config.hooks,
                    "agent.child_spawn.requested",
                    &json!({
                        "task_id": request.id,
                        "agent_id": agent_id,
                        "reason": &reason,
                        "depth": depth,
                    }),
                )?;
                let spawn_response = handle_child_spawn_request(
                    config,
                    request,
                    spec,
                    depth,
                    socket_bus,
                    &agent_id,
                    &reason,
                    child_request,
                );
                send_json_line(writer, &spawn_response)?;
            }
            AgentMessage::HookRequest {
                agent_id,
                request: hook_request,
            } => {
                emit_hook_event(
                    &config.hooks,
                    "agent.hook_extension.requested",
                    &json!({
                        "task_id": request.id,
                        "agent_id": agent_id,
                        "hook_name": &hook_request.name,
                        "depth": depth,
                    }),
                )?;
                let response =
                    handle_hook_extension_request(config, spec, depth, &agent_id, hook_request);
                send_json_line(writer, &response)?;
            }
            AgentMessage::SocketRequest {
                agent_id,
                request: socket_request,
            } => {
                emit_hook_event(
                    &config.hooks,
                    "agent.socket.requested",
                    &json!({
                        "task_id": request.id,
                        "agent_id": agent_id,
                        "channel": socket_request.channel,
                        "op": socket_op_name(socket_request.op),
                        "depth": depth,
                    }),
                )?;
                let response = handle_socket_request(
                    config,
                    spec,
                    depth,
                    &agent_id,
                    socket_request,
                    socket_bus,
                );
                send_json_line(writer, &response)?;
            }
        }
    }
}

fn handle_child_spawn_request(
    config: &AppConfig,
    parent_request: &TaskRequest,
    parent_spec: &AgentSpec,
    depth: usize,
    socket_bus: &mut SocketBus,
    agent_id: &str,
    reason: &str,
    child_request: ChildSpawnRequest,
) -> ManagerMessage {
    let _ = emit_hook_event(
        &config.hooks,
        "child_spawn.request.validate",
        &json!({
            "agent_id": agent_id,
            "parent_agent_id": parent_spec.id,
            "depth": depth,
            "resource": child_request.resource,
            "action": child_request.action,
        }),
    );
    if agent_id != parent_spec.id {
        let _ = emit_hook_event(
            &config.hooks,
            "child_spawn.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "agent_id_mismatch",
            }),
        );
        return ManagerMessage::SpawnChildResponse {
            approved: false,
            report: None,
            error: Some("spawn request agent_id mismatch".to_string()),
        };
    }

    let policy = &config.manager;
    if !policy.child_spawn_enabled {
        let _ = emit_hook_event(
            &config.hooks,
            "child_spawn.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "policy_disabled",
            }),
        );
        return ManagerMessage::SpawnChildResponse {
            approved: false,
            report: None,
            error: Some("child spawning disabled by manager policy".to_string()),
        };
    }
    if policy.child_spawn_container_only && parent_spec.isolation != IsolationMode::Container {
        let _ = emit_hook_event(
            &config.hooks,
            "child_spawn.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "container_only",
            }),
        );
        return ManagerMessage::SpawnChildResponse {
            approved: false,
            report: None,
            error: Some("child spawning allowed only for container micro agents".to_string()),
        };
    }
    if depth >= policy.child_spawn_max_depth as usize {
        let _ = emit_hook_event(
            &config.hooks,
            "child_spawn.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "depth_limit",
                "max_depth": policy.child_spawn_max_depth,
            }),
        );
        return ManagerMessage::SpawnChildResponse {
            approved: false,
            report: None,
            error: Some(format!(
                "child spawn depth limit reached (max={})",
                policy.child_spawn_max_depth
            )),
        };
    }
    if is_unsafe_host_resource(&child_request.resource) {
        if !policy.unsafe_host_communication_enabled {
            let _ = emit_hook_event(
                &config.hooks,
                "child_spawn.denied",
                &json!({
                    "agent_id": agent_id,
                    "reason": "unsafe_host_disabled",
                }),
            );
            return ManagerMessage::SpawnChildResponse {
                approved: false,
                report: None,
                error: Some("unsafe host communication is disabled by manager policy".to_string()),
            };
        }
        if parent_spec.isolation != IsolationMode::Container {
            let _ = emit_hook_event(
                &config.hooks,
                "child_spawn.denied",
                &json!({
                    "agent_id": agent_id,
                    "reason": "unsafe_host_requires_container_parent",
                }),
            );
            return ManagerMessage::SpawnChildResponse {
                approved: false,
                report: None,
                error: Some(
                    "unsafe host communication requires a container parent agent".to_string(),
                ),
            };
        }
    }
    if let Err(err) = validate_child_spawn_permissions(parent_spec, &child_request) {
        let _ = emit_hook_event(
            &config.hooks,
            "child_spawn.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "permission_denied",
                "error": err.to_string(),
            }),
        );
        return ManagerMessage::SpawnChildResponse {
            approved: false,
            report: None,
            error: Some(err.to_string()),
        };
    }

    let task = TaskRequest {
        id: Uuid::new_v4().to_string(),
        summary: format!(
            "{} [spawned by {} at depth {}: {}]",
            child_request.summary,
            parent_request.id,
            depth + 1,
            reason
        ),
        resource: child_request.resource,
        action: child_request.action,
        target: child_request.target,
        runtime: child_request.runtime,
        container_image: child_request.container_image,
        container_network: child_request.container_network,
        llm_profile: child_request
            .llm_profile
            .or_else(|| Some(parent_spec.llm_profile.clone())),
        caller_task_id: Some(parent_request.id.clone()),
        caller_agent_id: Some(parent_spec.id.clone()),
        caller_resource: Some(parent_spec.resource.clone()),
    };

    let _ = emit_hook_event(
        &config.hooks,
        "child_spawn.approved",
        &json!({
            "agent_id": agent_id,
            "depth": depth + 1,
            "task": &task,
        }),
    );

    match run_task_internal(config, task, depth + 1, socket_bus) {
        Ok(report) => ManagerMessage::SpawnChildResponse {
            approved: true,
            report: Some(report),
            error: None,
        },
        Err(err) => {
            let _ = emit_hook_event(
                &config.hooks,
                "child_spawn.execution_failed",
                &json!({
                    "agent_id": agent_id,
                    "error": err.to_string(),
                }),
            );
            ManagerMessage::SpawnChildResponse {
                approved: false,
                report: None,
                error: Some(err.to_string()),
            }
        }
    }
}

fn is_unsafe_host_resource(resource: &str) -> bool {
    resource
        .trim()
        .eq_ignore_ascii_case("plugin:unsafe_host_agent")
}

fn validate_child_spawn_permissions(
    parent_spec: &AgentSpec,
    child_request: &ChildSpawnRequest,
) -> Result<()> {
    if !parent_spec.permissions.spawn_child {
        anyhow::bail!("parent agent is not permitted to spawn child tasks");
    }
    if !parent_spec.permissions.allows_action(child_request.action) {
        anyhow::bail!(
            "parent agent permissions do not allow '{}' child action",
            child_request.action.as_str()
        );
    }
    Ok(())
}

fn handle_hook_extension_request(
    config: &AppConfig,
    parent_spec: &AgentSpec,
    depth: usize,
    agent_id: &str,
    request: HookRequest,
) -> ManagerMessage {
    let _ = emit_hook_event(
        &config.hooks,
        "hook_extension.request.validate",
        &json!({
            "agent_id": agent_id,
            "parent_agent_id": parent_spec.id,
            "hook_name": request.name,
            "depth": depth,
        }),
    );
    if agent_id != parent_spec.id {
        let _ = emit_hook_event(
            &config.hooks,
            "hook_extension.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "agent_id_mismatch",
            }),
        );
        return ManagerMessage::HookResponse {
            approved: false,
            data: None,
            error: Some("hook request agent_id mismatch".to_string()),
        };
    }

    let policy = &config.manager;
    if !policy.hook_extensions_enabled {
        let _ = emit_hook_event(
            &config.hooks,
            "hook_extension.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "policy_disabled",
            }),
        );
        return ManagerMessage::HookResponse {
            approved: false,
            data: None,
            error: Some("hook extensions disabled by manager policy".to_string()),
        };
    }
    if policy.hook_extensions_container_only && parent_spec.isolation != IsolationMode::Container {
        let _ = emit_hook_event(
            &config.hooks,
            "hook_extension.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "container_only",
            }),
        );
        return ManagerMessage::HookResponse {
            approved: false,
            data: None,
            error: Some("hook extensions allowed only for container micro agents".to_string()),
        };
    }
    if !parent_spec.allow_hook_requests {
        let _ = emit_hook_event(
            &config.hooks,
            "hook_extension.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "spec_disallowed",
            }),
        );
        return ManagerMessage::HookResponse {
            approved: false,
            data: None,
            error: Some("agent spec does not allow hook requests".to_string()),
        };
    }

    let hook_name = request.name.clone();
    let Some(extension) = config.hooks.extensions.get(&hook_name) else {
        let _ = emit_hook_event(
            &config.hooks,
            "hook_extension.denied",
            &json!({
                "agent_id": agent_id,
                "reason": "missing_extension",
                "hook_name": hook_name,
            }),
        );
        return ManagerMessage::HookResponse {
            approved: false,
            data: None,
            error: Some(format!("hook extension '{}' is not configured", hook_name)),
        };
    };

    let context = json!({
        "agent_id": agent_id,
        "depth": depth,
        "request": &request,
        "spec": parent_spec,
    });
    let stage = format!("extension:{}", hook_name);
    let options = HookRunOptions {
        timeout_ms: extension.timeout_ms.max(100),
        max_retries: extension.max_retries,
        fail_open: extension.fail_open,
    };

    match hooks::run_hooks_with_options(&stage, &extension.commands, &context, options) {
        Ok(()) => {
            let _ = emit_hook_event(
                &config.hooks,
                "hook_extension.approved",
                &json!({
                    "agent_id": agent_id,
                    "hook_name": hook_name,
                }),
            );
            ManagerMessage::HookResponse {
                approved: true,
                data: Some(json!({
                    "name": hook_name,
                    "status": "ok",
                })),
                error: None,
            }
        }
        Err(err) => {
            let _ = emit_hook_event(
                &config.hooks,
                "hook_extension.failed",
                &json!({
                    "agent_id": agent_id,
                    "hook_name": hook_name,
                    "error": err.to_string(),
                }),
            );
            ManagerMessage::HookResponse {
                approved: false,
                data: None,
                error: Some(err.to_string()),
            }
        }
    }
}

fn child_policy_for_agent(
    config: &AppConfig,
    spec: &AgentSpec,
    depth: usize,
) -> ChildRuntimePolicy {
    let allow_spawn = config.manager.child_spawn_enabled
        && (!config.manager.child_spawn_container_only
            || spec.isolation == IsolationMode::Container)
        && depth < config.manager.child_spawn_max_depth as usize;

    ChildRuntimePolicy {
        allow_spawn,
        allow_hook_requests: config.manager.hook_extensions_enabled
            && (!config.manager.hook_extensions_container_only
                || spec.isolation == IsolationMode::Container)
            && spec.allow_hook_requests
            && depth <= config.manager.child_spawn_max_depth as usize,
        max_depth: config.manager.child_spawn_max_depth,
        require_container_parent: config.manager.child_spawn_container_only,
    }
}

fn socket_path_for_agent(base_dir: PathBuf, agent_id: &str) -> PathBuf {
    let short = agent_id
        .split('-')
        .next()
        .unwrap_or("agent")
        .chars()
        .take(12)
        .collect::<String>();
    base_dir.join(format!("{}-{}.sock", short, Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use crate::model::{AgentPermissions, AgentSpec, ChildSpawnRequest, CrudAction, ExecutionKind};

    use super::validate_child_spawn_permissions;

    fn mock_spec(permissions: AgentPermissions) -> AgentSpec {
        AgentSpec {
            id: "parent-1".to_string(),
            resource: "plugin:chat_worker_agent".to_string(),
            action: CrudAction::Read,
            isolation: crate::model::IsolationMode::Container,
            execution: ExecutionKind::PluginCommand,
            connector: None,
            connection: None,
            connection_command: None,
            plugin: Some("chat_worker_agent".to_string()),
            plugin_command: Some("node plugins/chat-worker-agent-plugin.mjs".to_string()),
            allow_spawn_child: permissions.spawn_child,
            allow_hook_requests: permissions.hook_extensions,
            permissions,
            skills: Vec::new(),
            container_image: None,
            container_network: None,
            llm_profile: "default".to_string(),
        }
    }

    #[test]
    fn child_spawn_permissions_allow_matching_action() {
        let parent = mock_spec(AgentPermissions {
            read: true,
            spawn_child: true,
            ..AgentPermissions::default()
        });
        let child = ChildSpawnRequest {
            summary: "read task".to_string(),
            resource: "plugin:db_read_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
        };

        let result = validate_child_spawn_permissions(&parent, &child);
        assert!(result.is_ok());
    }

    #[test]
    fn child_spawn_permissions_deny_escalated_action() {
        let parent = mock_spec(AgentPermissions {
            read: true,
            spawn_child: true,
            ..AgentPermissions::default()
        });
        let child = ChildSpawnRequest {
            summary: "delete task".to_string(),
            resource: "plugin:db_delete_agent".to_string(),
            action: CrudAction::Delete,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
        };

        let result = validate_child_spawn_permissions(&parent, &child);
        assert!(result.is_err());
    }
}
