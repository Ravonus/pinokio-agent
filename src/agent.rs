use std::io::{BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::llm::complete_runtime;
use crate::model::{
    AgentMessage, AgentSpec, ChildRuntimePolicy, ChildSpawnRequest, ExecutionKind, HookRequest,
    ManagerMessage, SocketChannelRequest, TaskRequest,
};
use crate::playwright::read_web_page_title;
use crate::transport::{recv_json_line, send_json_line};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMode {
    Standard,
    Micro,
}

enum ManagerConnectTarget<'a> {
    Unix(&'a Path),
    Tcp(&'a str),
    Stdio,
}

pub fn run_agent(
    socket_path: Option<&Path>,
    tcp_addr: Option<&str>,
    stdio: bool,
    expected_agent_id: Option<&str>,
) -> Result<()> {
    let connect = resolve_connect_target(socket_path, tcp_addr, stdio)?;
    run_with_mode(connect, expected_agent_id, AgentMode::Standard)
}

pub fn run_micro_agent(
    socket_path: Option<&Path>,
    tcp_addr: Option<&str>,
    stdio: bool,
    expected_agent_id: Option<&str>,
) -> Result<()> {
    let connect = resolve_connect_target(socket_path, tcp_addr, stdio)?;
    run_with_mode(connect, expected_agent_id, AgentMode::Micro)
}

fn run_with_mode(
    connect: ManagerConnectTarget<'_>,
    expected_agent_id: Option<&str>,
    mode: AgentMode,
) -> Result<()> {
    let (reader_stream, writer_stream) = connect_to_manager(connect, Duration::from_secs(5))?;
    let mut reader = BufReader::new(reader_stream);
    let mut writer = BufWriter::new(writer_stream);

    let message: ManagerMessage = recv_json_line(&mut reader)?;
    let (request, spec, llm, child_policy) = match message {
        ManagerMessage::Run {
            request,
            spec,
            llm,
            child_policy,
        } => (request, spec, llm, child_policy),
        _ => {
            anyhow::bail!("agent expected run message as first protocol payload");
        }
    };

    if let Some(expected) = expected_agent_id {
        if spec.id != expected {
            let payload = AgentMessage::Error {
                agent_id: spec.id.clone(),
                error: format!("agent id mismatch. expected={}", expected),
            };
            send_json_line(&mut writer, &payload)?;
            return Ok(());
        }
    }

    let response = match spec.execution {
        ExecutionKind::PlaywrightRead => run_playwright_read(&request, &spec),
        ExecutionKind::PluginCommand => run_plugin_with_optional_extensions(
            &request,
            &spec,
            &child_policy,
            mode,
            &mut reader,
            &mut writer,
        ),
        ExecutionKind::ConnectionCommand => run_connection_with_optional_extensions(
            &request,
            &spec,
            &child_policy,
            mode,
            &mut reader,
            &mut writer,
        ),
        ExecutionKind::Noop => {
            if let Some(profile) = llm.as_ref() {
                run_llm_task(&request, &spec, profile)
            } else {
                AgentMessage::Result {
                    agent_id: spec.id.clone(),
                    summary: format!(
                        "noop {} agent on {} completed",
                        spec.action.as_str(),
                        spec.resource
                    ),
                    data: json!({
                        "execution": "noop",
                        "resource": spec.resource,
                        "action": spec.action,
                        "mode": if mode == AgentMode::Micro { "micro" } else { "standard" }
                    }),
                }
            }
        }
    };

    send_json_line(&mut writer, &response)?;
    Ok(())
}

fn resolve_connect_target<'a>(
    socket_path: Option<&'a Path>,
    tcp_addr: Option<&'a str>,
    stdio: bool,
) -> Result<ManagerConnectTarget<'a>> {
    match (socket_path, tcp_addr, stdio) {
        (None, None, true) => Ok(ManagerConnectTarget::Stdio),
        (Some(path), None, false) => Ok(ManagerConnectTarget::Unix(path)),
        (None, Some(addr), false) => Ok(ManagerConnectTarget::Tcp(addr)),
        (Some(_), Some(_), false) => anyhow::bail!("provide only one of --socket or --tcp"),
        (Some(_), Some(_), true) => anyhow::bail!("--stdio cannot be combined with --socket/--tcp"),
        (Some(_), None, true) | (None, Some(_), true) => {
            anyhow::bail!("--stdio cannot be combined with --socket/--tcp")
        }
        (None, None, false) => {
            anyhow::bail!("missing manager connection target (--socket or --tcp or --stdio)")
        }
    }
}

fn connect_to_manager(
    connect: ManagerConnectTarget<'_>,
    max_wait: Duration,
) -> Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    match connect {
        ManagerConnectTarget::Unix(path) => {
            let stream = connect_unix_with_retry(path, max_wait)
                .with_context(|| format!("failed to connect to {}", path.display()))?;
            let reader_stream = stream
                .try_clone()
                .context("failed to clone unix stream for reading")?;
            Ok((Box::new(reader_stream), Box::new(stream)))
        }
        ManagerConnectTarget::Tcp(addr) => {
            let stream = connect_tcp_with_retry(addr, max_wait)
                .with_context(|| format!("failed to connect to {}", addr))?;
            let reader_stream = stream
                .try_clone()
                .context("failed to clone tcp stream for reading")?;
            Ok((Box::new(reader_stream), Box::new(stream)))
        }
        ManagerConnectTarget::Stdio => {
            Ok((Box::new(std::io::stdin()), Box::new(std::io::stdout())))
        }
    }
}

fn connect_unix_with_retry(socket_path: &Path, max_wait: Duration) -> Result<UnixStream> {
    let start = Instant::now();
    loop {
        match UnixStream::connect(socket_path) {
            Ok(stream) => return Ok(stream),
            Err(err) if should_retry_connect(&err) && start.elapsed() < max_wait => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(err.into()),
        }
    }
}

fn connect_tcp_with_retry(addr: &str, max_wait: Duration) -> Result<TcpStream> {
    let addresses = resolve_tcp_addresses(addr)?;
    if addresses.is_empty() {
        anyhow::bail!("no resolved socket addresses for {}", addr);
    }

    let start = Instant::now();
    let per_attempt_timeout = Duration::from_millis(800);
    let mut last_error: Option<std::io::Error> = None;
    loop {
        for target in &addresses {
            match TcpStream::connect_timeout(target, per_attempt_timeout) {
                Ok(stream) => return Ok(stream),
                Err(err) => {
                    last_error = Some(err);
                }
            }
        }

        if start.elapsed() >= max_wait {
            break;
        }
        thread::sleep(Duration::from_millis(80));
    }

    if let Some(err) = last_error {
        return Err(err.into());
    }
    anyhow::bail!("failed to connect to {}", addr)
}

fn resolve_tcp_addresses(addr: &str) -> Result<Vec<SocketAddr>> {
    let mut out: Vec<SocketAddr> = addr
        .to_socket_addrs()
        .with_context(|| format!("failed resolving tcp address {}", addr))?
        .collect();
    // Prefer IPv4 first to avoid slow IPv6 fallbacks in containerized macOS routes.
    out.sort_by_key(|socket| if socket.is_ipv4() { 0 } else { 1 });
    Ok(out)
}

fn should_retry_connect(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::AddrNotAvailable
            | std::io::ErrorKind::NetworkUnreachable
            | std::io::ErrorKind::HostUnreachable
    )
}

fn run_playwright_read(request: &TaskRequest, spec: &AgentSpec) -> AgentMessage {
    if let Some(target) = request.target.as_deref() {
        match read_web_page_title(target) {
            Ok(data) => AgentMessage::Result {
                agent_id: spec.id.clone(),
                summary: format!("read web title from {}", target),
                data,
            },
            Err(err) => AgentMessage::Error {
                agent_id: spec.id.clone(),
                error: err.to_string(),
            },
        }
    } else {
        AgentMessage::Error {
            agent_id: spec.id.clone(),
            error: "playwright read requires a target URL".to_string(),
        }
    }
}

fn run_plugin_with_optional_extensions(
    request: &TaskRequest,
    spec: &AgentSpec,
    child_policy: &ChildRuntimePolicy,
    mode: AgentMode,
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
) -> AgentMessage {
    let Some(command) = spec.plugin_command.as_deref() else {
        return AgentMessage::Error {
            agent_id: spec.id.clone(),
            error: "plugin command missing in agent spec".to_string(),
        };
    };

    run_command_with_optional_extensions(
        request,
        spec,
        child_policy,
        mode,
        reader,
        writer,
        "plugin",
        spec.plugin.as_deref().unwrap_or("unnamed"),
        command,
        vec![
            (
                "PINOKIO_PLUGIN_REQUEST_JSON".to_string(),
                serde_json::to_string(request).unwrap_or_else(|_| "{}".to_string()),
            ),
            (
                "PINOKIO_PLUGIN_SPEC_JSON".to_string(),
                serde_json::to_string(spec).unwrap_or_else(|_| "{}".to_string()),
            ),
        ],
    )
}

fn run_connection_with_optional_extensions(
    request: &TaskRequest,
    spec: &AgentSpec,
    child_policy: &ChildRuntimePolicy,
    mode: AgentMode,
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
) -> AgentMessage {
    let Some(command) = spec.connection_command.as_deref() else {
        return AgentMessage::Error {
            agent_id: spec.id.clone(),
            error: "connection command missing in agent spec".to_string(),
        };
    };

    run_command_with_optional_extensions(
        request,
        spec,
        child_policy,
        mode,
        reader,
        writer,
        "connection",
        spec.connection.as_deref().unwrap_or("unnamed"),
        command,
        vec![
            (
                "PINOKIO_CONNECTION_NAME".to_string(),
                spec.connection
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
            ),
            (
                "PINOKIO_CONNECTION_REQUEST_JSON".to_string(),
                serde_json::to_string(request).unwrap_or_else(|_| "{}".to_string()),
            ),
            (
                "PINOKIO_CONNECTION_SPEC_JSON".to_string(),
                serde_json::to_string(spec).unwrap_or_else(|_| "{}".to_string()),
            ),
        ],
    )
}

fn run_command_with_optional_extensions(
    _request: &TaskRequest,
    spec: &AgentSpec,
    child_policy: &ChildRuntimePolicy,
    mode: AgentMode,
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
    kind: &str,
    name: &str,
    command: &str,
    envs: Vec<(String, String)>,
) -> AgentMessage {
    let output = match run_command(command, &envs) {
        Ok(out) => out,
        Err(err) => {
            return AgentMessage::Error {
                agent_id: spec.id.clone(),
                error: err,
            }
        }
    };

    let raw_data = match parse_json_output_value(&output) {
        Some(value) => value,
        None => json!({ "raw": output }),
    };

    let (mut data, mut spawn_request, hook_request, socket_requests) =
        match extract_extension_requests(raw_data, kind.to_string()) {
            Ok(value) => value,
            Err(err) => {
                return AgentMessage::Error {
                    agent_id: spec.id.clone(),
                    error: err.to_string(),
                }
            }
        };

    if let Some(hook_request) = hook_request {
        let hook_result = if !spec.allow_hook_requests {
            json!({
                "approved": false,
                "error": "hook_request is not allowed for this agent spec",
            })
        } else if mode != AgentMode::Micro && child_policy.require_container_parent {
            json!({
                "approved": false,
                "error": "hook_request requires container parent agent mode by manager policy",
            })
        } else {
            match request_hook_extension(reader, writer, spec, child_policy, hook_request) {
                Ok(result) => result,
                Err(err) => {
                    return AgentMessage::Error {
                        agent_id: spec.id.clone(),
                        error: err.to_string(),
                    }
                }
            }
        };
        insert_extension_result(&mut data, "hook_result", hook_result);
    }

    let mut socket_results_for_spawn = Vec::new();
    if !socket_requests.is_empty() {
        let mut socket_results = Vec::new();
        for socket_request in socket_requests {
            let socket_result = match request_socket_channel(
                reader,
                writer,
                spec,
                child_policy,
                socket_request,
            ) {
                Ok(result) => result,
                Err(err) => {
                    return AgentMessage::Error {
                        agent_id: spec.id.clone(),
                        error: err.to_string(),
                    }
                }
            };
            socket_results.push(socket_result);
        }
        if socket_results.len() == 1 {
            insert_extension_result(&mut data, "socket_result", socket_results[0].clone());
        }
        insert_extension_result(&mut data, "socket_results", json!(socket_results));
        socket_results_for_spawn = socket_results;
    }

    if let Some(mut spawn_request) = spawn_request.take() {
        if let Err(err) = inject_socket_results_into_spawn_target(
            &mut spawn_request,
            &socket_results_for_spawn,
        ) {
            return AgentMessage::Error {
                agent_id: spec.id.clone(),
                error: err.to_string(),
            };
        }
        let spawn_result = if !spec.allow_spawn_child {
            return AgentMessage::Error {
                agent_id: spec.id.clone(),
                error: "spawn_child is not allowed for this agent spec".to_string(),
            };
        } else if mode != AgentMode::Micro && child_policy.require_container_parent {
            return AgentMessage::Error {
                agent_id: spec.id.clone(),
                error: "spawn_child requires container parent agent mode by manager policy"
                    .to_string(),
            };
        } else {
            match request_child_spawn(reader, writer, spec, child_policy, spawn_request) {
                Ok(result) => result,
                Err(err) => {
                    return AgentMessage::Error {
                        agent_id: spec.id.clone(),
                        error: err.to_string(),
                    }
                }
            }
        };
        insert_extension_result(&mut data, "spawn_child_result", spawn_result);
    }

    AgentMessage::Result {
        agent_id: spec.id.clone(),
        summary: format!("{} {} executed", kind, name),
        data,
    }
}

fn run_command(command: &str, envs: &[(String, String)]) -> std::result::Result<String, String> {
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command);
    for (key, value) in envs {
        cmd.env(key, value);
    }

    let output = cmd
        .output()
        .map_err(|err| format!("failed running command: {}", err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("command failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_json_output_value(output: &str) -> Option<Value> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }

    let object_start = trimmed.find('{');
    let array_start = trimmed.find('[');
    let start = match (object_start, array_start) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };

    let candidates = [
        trimmed.len(),
        trimmed.rfind('}').map(|idx| idx + 1).unwrap_or(0),
        trimmed.rfind(']').map(|idx| idx + 1).unwrap_or(0),
    ];

    for end in candidates {
        if end <= start {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&trimmed[start..end]) {
            return Some(value);
        }
    }

    None
}

fn insert_extension_result(data: &mut Value, key: &str, value: Value) {
    if let Some(obj) = data.as_object_mut() {
        obj.insert(key.to_string(), value);
        return;
    }

    *data = json!({
        "result": data.clone(),
        key: value,
    });
}

fn extract_extension_requests(
    mut data: Value,
    context: String,
) -> Result<(
    Value,
    Option<ChildSpawnRequest>,
    Option<HookRequest>,
    Vec<SocketChannelRequest>,
)> {
    let spawn_payload = data
        .as_object_mut()
        .and_then(|obj| obj.remove("spawn_child"));
    let hook_payload = data
        .as_object_mut()
        .and_then(|obj| obj.remove("hook_request"));
    let socket_payload = data
        .as_object_mut()
        .and_then(|obj| obj.remove("socket_request"));
    let socket_payloads = data
        .as_object_mut()
        .and_then(|obj| obj.remove("socket_requests"));

    let spawn_request = match spawn_payload {
        Some(value) => Some(
            serde_json::from_value::<ChildSpawnRequest>(value)
                .with_context(|| format!("invalid spawn_child payload from {} command", context))?,
        ),
        None => None,
    };

    let hook_request =
        match hook_payload {
            Some(value) => Some(serde_json::from_value::<HookRequest>(value).with_context(
                || format!("invalid hook_request payload from {} command", context),
            )?),
            None => None,
        };

    let mut socket_requests = Vec::new();
    if let Some(value) = socket_payload {
        socket_requests.push(
            serde_json::from_value::<SocketChannelRequest>(value).with_context(|| {
                format!("invalid socket_request payload from {} command", context)
            })?,
        );
    }
    if let Some(value) = socket_payloads {
        let items = value.as_array().ok_or_else(|| {
            anyhow::anyhow!(
                "invalid socket_requests payload from {} command: expected array",
                context
            )
        })?;
        for item in items {
            socket_requests.push(
                serde_json::from_value::<SocketChannelRequest>(item.clone()).with_context(|| {
                    format!("invalid socket_requests item payload from {} command", context)
                })?,
            );
        }
    }

    Ok((data, spawn_request, hook_request, socket_requests))
}

fn request_child_spawn(
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
    spec: &AgentSpec,
    child_policy: &ChildRuntimePolicy,
    spawn_request: ChildSpawnRequest,
) -> Result<Value> {
    if !child_policy.allow_spawn {
        anyhow::bail!("manager policy denied child spawning for this micro agent");
    }

    let request = AgentMessage::SpawnChildRequest {
        agent_id: spec.id.clone(),
        reason: "command requested child spawn".to_string(),
        request: spawn_request,
    };
    send_json_line(writer, &request)?;

    let manager_response: ManagerMessage = recv_json_line(reader)?;
    match manager_response {
        ManagerMessage::SpawnChildResponse {
            approved,
            report,
            error,
        } => {
            if approved {
                Ok(json!({
                    "approved": true,
                    "report": report,
                }))
            } else {
                anyhow::bail!(
                    "manager denied child spawn: {}",
                    error.unwrap_or_else(|| "no reason provided".to_string())
                )
            }
        }
        _ => anyhow::bail!("unexpected manager response after spawn request"),
    }
}

fn request_hook_extension(
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
    spec: &AgentSpec,
    child_policy: &ChildRuntimePolicy,
    hook_request: HookRequest,
) -> Result<Value> {
    if !child_policy.allow_hook_requests {
        anyhow::bail!("manager policy denied hook extensions for this micro agent");
    }

    let request = AgentMessage::HookRequest {
        agent_id: spec.id.clone(),
        request: hook_request,
    };
    send_json_line(writer, &request)?;

    let manager_response: ManagerMessage = recv_json_line(reader)?;
    match manager_response {
        ManagerMessage::HookResponse {
            approved,
            data,
            error,
        } => {
            if approved {
                Ok(json!({
                    "approved": true,
                    "data": data,
                }))
            } else {
                anyhow::bail!(
                    "manager denied hook extension: {}",
                    error.unwrap_or_else(|| "no reason provided".to_string())
                )
            }
        }
        _ => anyhow::bail!("unexpected manager response after hook request"),
    }
}

fn request_socket_channel(
    reader: &mut BufReader<Box<dyn Read + Send>>,
    writer: &mut BufWriter<Box<dyn Write + Send>>,
    spec: &AgentSpec,
    _child_policy: &ChildRuntimePolicy,
    socket_request: SocketChannelRequest,
) -> Result<Value> {
    let request = AgentMessage::SocketRequest {
        agent_id: spec.id.clone(),
        request: socket_request,
    };
    send_json_line(writer, &request)?;

    let manager_response: ManagerMessage = recv_json_line(reader)?;
    match manager_response {
        ManagerMessage::SocketResponse {
            approved,
            data,
            error,
        } => {
            if approved {
                Ok(json!({
                    "approved": true,
                    "data": data,
                }))
            } else {
                anyhow::bail!(
                    "manager denied socket request: {}",
                    error.unwrap_or_else(|| "no reason provided".to_string())
                )
            }
        }
        _ => anyhow::bail!("unexpected manager response after socket request"),
    }
}

fn inject_socket_results_into_spawn_target(
    spawn_request: &mut ChildSpawnRequest,
    socket_results: &[Value],
) -> Result<()> {
    if socket_results.is_empty() {
        return Ok(());
    }

    let mut target_obj = match spawn_request.target.as_deref() {
        None => serde_json::Map::new(),
        Some(raw) => {
            let parsed: Value = serde_json::from_str(raw)
                .context("spawn_child target must be valid JSON when using socket requests")?;
            match parsed {
                Value::Object(obj) => obj,
                _ => {
                    anyhow::bail!(
                        "spawn_child target must be a JSON object when using socket requests"
                    );
                }
            }
        }
    };

    if !target_obj.contains_key("__socket_results") {
        target_obj.insert("__socket_results".to_string(), json!(socket_results));
    }
    if socket_results.len() == 1 && !target_obj.contains_key("__socket_result") {
        target_obj.insert("__socket_result".to_string(), socket_results[0].clone());
    }

    spawn_request.target = Some(serde_json::to_string(&target_obj)?);
    Ok(())
}

fn run_llm_task(
    request: &TaskRequest,
    spec: &AgentSpec,
    profile: &crate::model::LlmRuntimeProfile,
) -> AgentMessage {
    let prompt = format!(
        "Task: {}\nResource: {}\nAction: {}\nTarget: {}\n\nReturn a concise next-step plan and security notes.",
        request.summary,
        request.resource,
        spec.action.as_str(),
        request.target.clone().unwrap_or_else(|| "none".to_string())
    );

    match complete_runtime(profile, &prompt) {
        Ok(out) => AgentMessage::Result {
            agent_id: spec.id.clone(),
            summary: format!("llm {} completed for {}", profile.name, spec.id),
            data: json!({
                "execution": "llm",
                "profile": profile.name,
                "provider": out.provider,
                "model": out.model,
                "text": out.text,
            }),
        },
        Err(err) => AgentMessage::Error {
            agent_id: spec.id.clone(),
            error: format!("llm execution failed: {}", err),
        },
    }
}
