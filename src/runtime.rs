use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};
use uuid::Uuid;

use crate::auth::auth_env_pairs;
use crate::config::{AppConfig, ConnectorConfig, OrchestratorServiceConfig};
use crate::hooks::emit_hook_event;
use crate::model::{AgentSpec, IsolationMode};
use crate::oauth_cli::{container_oauth_runtime_mount, container_session_mounts};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerBackend {
    Docker,
    Swarm,
}

const CONTAINER_HOST_DOCUMENTS_PATH: &str = "/host/Documents";
const CONTAINER_HOST_DESKTOP_PATH: &str = "/host/Desktop";

#[derive(Debug, Clone)]
pub enum AgentConnect {
    UnixSocket(PathBuf),
    TcpAddress(String),
    Stdio,
}

pub fn spawn_agent(
    current_exe: &Path,
    config: &AppConfig,
    spec: &AgentSpec,
    connect: &AgentConnect,
) -> Result<Child> {
    emit_hook_event(
        &config.hooks,
        "runtime.spawn.select",
        &serde_json::json!({
            "agent_id": spec.id,
            "resource": spec.resource,
            "isolation": spec.isolation,
        }),
    )?;
    match spec.isolation {
        IsolationMode::Host => spawn_host_agent(current_exe, config, spec, connect),
        IsolationMode::Container => {
            if !config.manager.enable_container_agents {
                return spawn_host_agent(current_exe, config, spec, connect);
            }
            spawn_container_agent(current_exe, config, spec, connect)
        }
    }
}

pub fn missing_connector_auth(config: &AppConfig, spec: &AgentSpec) -> Vec<String> {
    let mut required: Vec<String> = Vec::new();
    if let Some(connector_name) = &spec.connector {
        if let Some(connector) = config.connectors.get(connector_name) {
            required.extend(connector.auth_env.iter().cloned());
        }
    }
    if let Some(connection_name) = &spec.connection {
        if let Some(connection) = config.connections.get(connection_name) {
            required.extend(connection.auth_env.iter().cloned());
        }
    }
    required.sort();
    required.dedup();
    required
        .into_iter()
        .filter(|key| env::var(key).is_err())
        .collect()
}

fn spawn_host_agent(
    current_exe: &Path,
    config: &AppConfig,
    spec: &AgentSpec,
    connect: &AgentConnect,
) -> Result<Child> {
    emit_hook_event(
        &config.hooks,
        "runtime.spawn.host",
        &serde_json::json!({ "agent_id": spec.id }),
    )?;
    let mut cmd = Command::new(current_exe);
    cmd.arg("agent");
    apply_connect_args(&mut cmd, connect);
    if matches!(connect, AgentConnect::Stdio) {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
    }
    cmd.arg("--agent-id").arg(&spec.id);

    for (key, value) in collect_agent_env(config, spec, IsolationMode::Host) {
        cmd.env(key, value);
    }

    cmd.spawn()
        .with_context(|| format!("failed to spawn host agent {}", spec.id))
}

fn spawn_container_agent(
    current_exe: &Path,
    config: &AppConfig,
    spec: &AgentSpec,
    connect: &AgentConnect,
) -> Result<Child> {
    emit_hook_event(
        &config.hooks,
        "runtime.spawn.container",
        &serde_json::json!({ "agent_id": spec.id }),
    )?;
    if !config.orchestrator.enabled {
        anyhow::bail!(
            "container orchestrator is disabled; host fallback is not allowed for container agents ({})",
            spec.id
        );
    }

    let backend = resolve_backend(config)?;
    match backend {
        ContainerBackend::Docker => spawn_container_docker(current_exe, config, spec, connect),
        ContainerBackend::Swarm => spawn_container_swarm(current_exe, config, spec, connect),
    }
}

fn spawn_container_docker(
    current_exe: &Path,
    config: &AppConfig,
    spec: &AgentSpec,
    connect: &AgentConnect,
) -> Result<Child> {
    let image = resolve_container_image(config, spec);
    maybe_pull_image(config, &image)?;
    emit_hook_event(
        &config.hooks,
        "runtime.spawn.container.docker",
        &serde_json::json!({ "agent_id": spec.id, "image": image }),
    )?;
    let connect_arg = container_connect_arg(config, connect)?;
    let env_pairs = collect_agent_env(config, spec, IsolationMode::Container);
    let (primary_network, secondary_networks) = resolve_agent_networks(config, spec);
    let using_host_network = primary_network
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("host"))
        .unwrap_or(false);
    let container_name = format!("pka-{}-{}", spec.action.as_str(), short_runtime_id());

    let mut cmd = Command::new("docker");
    cmd.arg("run").arg("--rm").arg("-i");
    cmd.arg("--name").arg(&container_name);

    if let Some(network) = &primary_network {
        cmd.arg("--network").arg(network);
    }
    if !using_host_network && should_apply_runtime_dns() {
        for dns in &config.orchestrator.dns_servers {
            cmd.arg("--dns").arg(dns);
        }
    }
    let mut mounts = config.orchestrator.mounts.clone();
    mounts.extend(container_session_mounts());
    if let Some(oauth_runtime_mount) = container_oauth_runtime_mount() {
        mounts.push(oauth_runtime_mount);
    }
    if let Some(host_documents_mount) = host_documents_mount() {
        mounts.push(host_documents_mount);
    }
    if let Some(host_desktop_mount) = host_desktop_mount() {
        mounts.push(host_desktop_mount);
    }
    mounts.sort();
    mounts.dedup();
    for mount in &mounts {
        cmd.arg("-v").arg(normalize_mount(mount));
    }
    if let Some(workspace_mount) = workspace_mount(config)? {
        cmd.arg("-v").arg(workspace_mount);
        cmd.arg("-w").arg(&config.orchestrator.workspace_mount_path);
    }
    if should_inject_host_binary(config) {
        let host_exe = current_exe
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid current executable path"))?;
        cmd.arg("-v").arg(format!(
            "{}:{}:ro",
            host_exe, config.orchestrator.agent_entrypoint
        ));
    }
    for (key, value) in env_pairs {
        cmd.arg("-e").arg(format!("{}={}", key, value));
    }

    cmd.arg("--entrypoint")
        .arg(&config.orchestrator.agent_entrypoint)
        .arg(&image)
        .arg("micro");
    if connect_arg == ContainerConnectArg::Stdio {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
    }
    append_connect_args(&mut cmd, &connect_arg);
    cmd.arg("--agent-id").arg(&spec.id);

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "failed to spawn docker container agent {} using image {}",
            spec.id, image
        )
    })?;

    if !using_host_network {
        if let Err(err) = attach_secondary_networks(&container_name, &secondary_networks) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    }

    Ok(child)
}

fn spawn_container_swarm(
    current_exe: &Path,
    config: &AppConfig,
    spec: &AgentSpec,
    connect: &AgentConnect,
) -> Result<Child> {
    let image = resolve_container_image(config, spec);
    maybe_pull_image(config, &image)?;
    emit_hook_event(
        &config.hooks,
        "runtime.spawn.container.swarm",
        &serde_json::json!({ "agent_id": spec.id, "image": image }),
    )?;
    let connect_arg = container_connect_arg(config, connect)?;
    if connect_arg == ContainerConnectArg::Stdio {
        anyhow::bail!(
            "stdio container transport is not supported with swarm backend; set PINOKIO_CONTAINER_TRANSPORT=tcp|socket or use docker backend"
        );
    }
    let env_pairs = collect_agent_env(config, spec, IsolationMode::Container);
    let (mut primary_network, mut secondary_networks) = resolve_agent_networks(config, spec);
    let using_host_network = primary_network
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("host"))
        .unwrap_or(false);
    if using_host_network {
        let managed_networks = config.orchestrator.container_networks();
        primary_network = managed_networks.first().cloned();
        secondary_networks = managed_networks.into_iter().skip(1).collect();
        emit_hook_event(
            &config.hooks,
            "runtime.spawn.container.swarm.network.remapped",
            &serde_json::json!({
                "agent_id": spec.id,
                "requested_network": "host",
                "effective_network": primary_network,
            }),
        )?;
    }
    let (primary_network, secondary_networks) =
        filter_swarm_networks(config, &spec.id, primary_network, secondary_networks)?;

    let service_name = format!("pka-{}-{}", spec.action.as_str(), short_runtime_id());

    let mut create_args: Vec<String> = vec![
        "service".to_string(),
        "create".to_string(),
        "--name".to_string(),
        service_name.clone(),
        "--restart-condition".to_string(),
        "none".to_string(),
    ];

    if let Some(network) = primary_network {
        create_args.push("--network".to_string());
        create_args.push(network);
    }
    for network in secondary_networks {
        create_args.push("--network".to_string());
        create_args.push(network);
    }
    if should_apply_runtime_dns() {
        for dns in &config.orchestrator.dns_servers {
            create_args.push("--dns".to_string());
            create_args.push(dns.clone());
        }
    }

    let mut mounts = config.orchestrator.mounts.clone();
    mounts.extend(container_session_mounts());
    if let Some(oauth_runtime_mount) = container_oauth_runtime_mount() {
        mounts.push(oauth_runtime_mount);
    }
    if let Some(host_documents_mount) = host_documents_mount() {
        mounts.push(host_documents_mount);
    }
    if let Some(host_desktop_mount) = host_desktop_mount() {
        mounts.push(host_desktop_mount);
    }
    mounts.sort();
    mounts.dedup();
    for mount in &mounts {
        if let Some((src, dst, readonly)) = parse_bind_mount(&normalize_mount(mount)) {
            create_args.push("--mount".to_string());
            create_args.push(format!(
                "type=bind,src={},dst={}{}",
                src,
                dst,
                if readonly { ",readonly" } else { "" }
            ));
        }
    }
    if let Some((src, dst)) = workspace_mount_pair(config)? {
        create_args.push("--mount".to_string());
        create_args.push(format!("type=bind,src={},dst={}", src, dst));
        create_args.push("--workdir".to_string());
        create_args.push(dst);
    }
    if should_inject_host_binary(config) {
        let host_exe = current_exe
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid current executable path"))?;
        create_args.push("--mount".to_string());
        create_args.push(format!(
            "type=bind,src={},dst={},readonly",
            host_exe, config.orchestrator.agent_entrypoint
        ));
    }
    for (key, value) in &env_pairs {
        create_args.push("--env".to_string());
        create_args.push(format!("{}={}", key, value));
    }

    create_args.push("--entrypoint".to_string());
    create_args.push(config.orchestrator.agent_entrypoint.clone());
    create_args.push(image);
    create_args.push("micro".to_string());
    append_connect_vec_args(&mut create_args, &connect_arg);
    create_args.push("--agent-id".to_string());
    create_args.push(spec.id.clone());

    let create_cmd = format!("docker {}", join_shell_escaped(&create_args));
    let poll_secs = (config.orchestrator.swarm_poll_interval_ms.max(100) as f64) / 1000.0;
    let script = format!(
        "set -e; name={name}; cleanup() {{ docker service rm \"$name\" >/dev/null 2>&1 || true; }}; trap cleanup EXIT INT TERM; {create_cmd} >/dev/null; while true; do state=$(docker service ps --no-trunc --format '{{{{.CurrentState}}}}|{{{{.Error}}}}' \"$name\" | head -n1 || true); s=$(echo \"$state\" | cut -d'|' -f1); e=$(echo \"$state\" | cut -d'|' -f2-); if echo \"$s\" | grep -Eiq 'Complete|Shutdown'; then break; fi; if echo \"$s\" | grep -Eiq 'Failed|Rejected|Error'; then echo \"swarm task failed: $state\" >&2; exit 1; fi; if [ -n \"$e\" ]; then echo \"swarm task error: $e\" >&2; exit 1; fi; sleep {poll_secs}; done",
        name = shell_quote(&service_name),
        create_cmd = create_cmd,
        poll_secs = poll_secs
    );

    Command::new("sh")
        .arg("-c")
        .arg(script)
        .spawn()
        .with_context(|| format!("failed to spawn swarm agent service {}", service_name))
}

fn filter_swarm_networks(
    config: &AppConfig,
    agent_id: &str,
    primary_network: Option<String>,
    secondary_networks: Vec<String>,
) -> Result<(Option<String>, Vec<String>)> {
    let mut requested = Vec::new();
    if let Some(primary) = primary_network {
        requested.push(primary);
    }
    requested.extend(secondary_networks);

    let mut accepted = Vec::new();
    for network in requested {
        match docker_network_scope(&network)? {
            Some(scope) if scope.eq_ignore_ascii_case("swarm") => {
                accepted.push(network);
            }
            Some(scope) => {
                emit_hook_event(
                    &config.hooks,
                    "runtime.spawn.container.swarm.network.skipped",
                    &serde_json::json!({
                        "agent_id": agent_id,
                        "network": network,
                        "scope": scope,
                        "reason": "network_is_not_swarm_scope",
                    }),
                )?;
            }
            None => {
                if config.orchestrator.auto_create_networks {
                    create_swarm_overlay_network(&network)?;
                    emit_hook_event(
                        &config.hooks,
                        "runtime.spawn.container.swarm.network.created",
                        &serde_json::json!({
                            "agent_id": agent_id,
                            "network": network,
                            "driver": "overlay",
                        }),
                    )?;
                    accepted.push(network);
                } else {
                    emit_hook_event(
                        &config.hooks,
                        "runtime.spawn.container.swarm.network.skipped",
                        &serde_json::json!({
                            "agent_id": agent_id,
                            "network": network,
                            "reason": "network_missing_and_auto_create_disabled",
                        }),
                    )?;
                }
            }
        }
    }

    let primary = accepted.first().cloned();
    let secondary = accepted.into_iter().skip(1).collect();
    Ok((primary, secondary))
}

fn collect_agent_env(
    config: &AppConfig,
    spec: &AgentSpec,
    isolation: IsolationMode,
) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    collect_connector_env(&mut pairs, config, spec);
    collect_connection_env(&mut pairs, config, spec);
    collect_service_env(&mut pairs, config, spec);
    collect_playwright_env(&mut pairs, config, isolation);
    collect_skill_env(&mut pairs, spec);
    collect_socket_bus_env(&mut pairs, config, spec, isolation);
    collect_explorer_scope_env(&mut pairs, isolation);
    pairs.extend(auth_env_pairs(&config.auth));
    if isolation == IsolationMode::Container {
        pairs.push(("PINOKIO_CHILD_MODE".to_string(), "1".to_string()));
        pairs.push((
            "PINOKIO_CHILD_HOME".to_string(),
            "/var/lib/pinokio-oauth".to_string(),
        ));
        pairs.push((
            "PINOKIO_CONTAINER_PACKAGE_INSTALLS_ENABLED".to_string(),
            if config.manager.container_package_installs_enabled {
                "1".to_string()
            } else {
                "0".to_string()
            },
        ));
        if let Some(ledger_path) = resolve_package_ledger_path(config, isolation) {
            pairs.push(("PINOKIO_PACKAGE_LEDGER_PATH".to_string(), ledger_path));
        }
        for key in [
            "PINOKIO_OAUTH_INSTALL_TIMEOUT_SECS",
            "PINOKIO_LLM_COMMAND_TIMEOUT_SECS",
            "PINOKIO_CHAT_LLM_TIMEOUT_MS",
            "PINOKIO_STRICT_EGRESS_PROBE",
        ] {
            if let Ok(value) = env::var(key) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    pairs.push((key.to_string(), trimmed.to_string()));
                }
            }
        }
    }
    pairs
}

fn collect_explorer_scope_env(out: &mut Vec<(String, String)>, isolation: IsolationMode) {
    if isolation != IsolationMode::Container {
        return;
    }
    if let Ok(explicit) = env::var("PINOKIO_EXPLORER_SCOPE") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            out.push(("PINOKIO_EXPLORER_SCOPE".to_string(), trimmed.to_string()));
            out.push((
                "PINOKIO_HOST_DOCUMENTS_SCOPE".to_string(),
                trimmed.to_string(),
            ));
            out.push((
                "PINOKIO_HOST_DESKTOP_SCOPE".to_string(),
                trimmed.to_string(),
            ));
            return;
        }
    }
    if host_documents_mount().is_some() {
        out.push((
            "PINOKIO_EXPLORER_SCOPE".to_string(),
            CONTAINER_HOST_DOCUMENTS_PATH.to_string(),
        ));
        out.push((
            "PINOKIO_HOST_DOCUMENTS_SCOPE".to_string(),
            CONTAINER_HOST_DOCUMENTS_PATH.to_string(),
        ));
    }
    if host_desktop_mount().is_some() {
        out.push((
            "PINOKIO_HOST_DESKTOP_SCOPE".to_string(),
            CONTAINER_HOST_DESKTOP_PATH.to_string(),
        ));
    }
}

fn collect_skill_env(out: &mut Vec<(String, String)>, spec: &AgentSpec) {
    let skills_json = serde_json::to_string(&spec.skills).unwrap_or_else(|_| "[]".to_string());
    out.push(("PINOKIO_SKILLS_JSON".to_string(), skills_json));

    let separator = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    let paths = spec
        .skills
        .iter()
        .map(|skill| skill.path.trim())
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    if !paths.is_empty() {
        out.push(("PINOKIO_SKILL_PATHS".to_string(), paths.join(separator)));
    }
}

fn collect_socket_bus_env(
    out: &mut Vec<(String, String)>,
    config: &AppConfig,
    spec: &AgentSpec,
    isolation: IsolationMode,
) {
    out.push(("PINOKIO_SOCKET_GLOBAL_CHANNEL".to_string(), "global".to_string()));
    out.push((
        "PINOKIO_SOCKET_PLUGINS_INDEX_CHANNEL".to_string(),
        "plugins:index".to_string(),
    ));
    out.push((
        "PINOKIO_SOCKET_PLUGIN_META_CHANNEL_TEMPLATE".to_string(),
        "plugin:{manifest_id}:meta".to_string(),
    ));
    out.push((
        "PINOKIO_SOCKET_PLUGIN_README_CHANNEL_TEMPLATE".to_string(),
        "plugin:{manifest_id}:readme".to_string(),
    ));
    out.push((
        "PINOKIO_SOCKET_PLUGIN_DISCOVERY_HINT".to_string(),
        "Use socket read on plugins:index, then read plugin:{manifest_id}:meta or plugin:{manifest_id}:readme.".to_string(),
    ));
    out.push((
        "PINOKIO_SOCKET_PERSONAL_CHANNEL".to_string(),
        format!("agent:{}", spec.id),
    ));
    out.push((
        "PINOKIO_SOCKET_AGENT_ID".to_string(),
        spec.id.clone(),
    ));
    out.push((
        "PINOKIO_SOCKET_RESOURCE".to_string(),
        spec.resource.clone(),
    ));

    if let Some(dir) = resolve_socket_bus_dir(config, isolation) {
        out.push(("PINOKIO_SOCKET_BUS_DIR".to_string(), dir));
    }
}

fn resolve_socket_bus_dir(config: &AppConfig, isolation: IsolationMode) -> Option<String> {
    if let Ok(explicit) = env::var("PINOKIO_SOCKET_BUS_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if isolation == IsolationMode::Container && config.orchestrator.mount_workspace {
        let path = PathBuf::from(&config.orchestrator.workspace_mount_path)
            .join(".pka")
            .join("socket-bus");
        return path.to_str().map(|value| value.to_string());
    }

    let cwd = env::current_dir().ok()?;
    let path = cwd.join(".pka").join("socket-bus");
    path.to_str().map(|value| value.to_string())
}

fn resolve_package_ledger_path(config: &AppConfig, isolation: IsolationMode) -> Option<String> {
    if let Ok(explicit) = env::var("PINOKIO_PACKAGE_LEDGER_PATH") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if isolation == IsolationMode::Container && config.orchestrator.mount_workspace {
        let path = PathBuf::from(&config.orchestrator.workspace_mount_path)
            .join(".pka")
            .join("package-ledger.json");
        return path.to_str().map(|value| value.to_string());
    }

    let cwd = env::current_dir().ok()?;
    let path = cwd.join(".pka").join("package-ledger.json");
    path.to_str().map(|value| value.to_string())
}

fn collect_connector_env(out: &mut Vec<(String, String)>, config: &AppConfig, spec: &AgentSpec) {
    let Some(connector_name) = &spec.connector else {
        return;
    };
    let Some(connector) = config.connectors.get(connector_name) else {
        return;
    };
    pass_auth_env(out, connector);
}

fn pass_auth_env(out: &mut Vec<(String, String)>, connector: &ConnectorConfig) {
    for key in &connector.auth_env {
        if let Ok(value) = env::var(key) {
            out.push((key.clone(), value));
        }
    }
}

fn collect_connection_env(out: &mut Vec<(String, String)>, config: &AppConfig, spec: &AgentSpec) {
    let Some(connection_name) = &spec.connection else {
        return;
    };
    let Some(connection) = config.connections.get(connection_name) else {
        return;
    };
    for key in &connection.auth_env {
        if let Ok(value) = env::var(key) {
            out.push((key.clone(), value));
        }
    }
}

fn collect_service_env(out: &mut Vec<(String, String)>, config: &AppConfig, spec: &AgentSpec) {
    let mut services: Vec<(&String, &OrchestratorServiceConfig)> =
        config.orchestrator.services.iter().collect();
    services.sort_by(|a, b| a.0.cmp(b.0));

    for (name, service) in services {
        if !service.enabled || !service.expose_to_agents {
            continue;
        }
        if !service_matches_resource(service, &spec.resource) {
            continue;
        }

        let container_name = config.orchestrator.service_container_name(name, service);
        let host = service
            .network_aliases
            .first()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| name.to_string());
        let internal_port = service.internal_port.unwrap_or(0);

        let mut key = String::new();
        for ch in name.chars() {
            if ch.is_ascii_alphanumeric() {
                key.push(ch.to_ascii_uppercase());
            } else {
                key.push('_');
            }
        }
        if key.is_empty() {
            key = "SERVICE".to_string();
        }

        out.push((format!("PINOKIO_SERVICE_{}_NAME", key), name.to_string()));
        out.push((
            format!("PINOKIO_SERVICE_{}_CONTAINER", key),
            container_name.clone(),
        ));
        out.push((format!("PINOKIO_SERVICE_{}_HOST", key), host.clone()));
        if internal_port > 0 {
            out.push((
                format!("PINOKIO_SERVICE_{}_PORT", key),
                internal_port.to_string(),
            ));
        }

        let mut env_entries: Vec<(&String, &String)> = service.agent_env.iter().collect();
        env_entries.sort_by(|a, b| a.0.cmp(b.0));
        for (env_key, env_value) in env_entries {
            out.push((
                env_key.clone(),
                render_service_env_value(
                    env_value,
                    name,
                    &container_name,
                    &host,
                    service.internal_port,
                ),
            ));
        }
    }
}

fn service_matches_resource(service: &OrchestratorServiceConfig, resource: &str) -> bool {
    if service.expose_resources.is_empty() {
        return true;
    }

    let resource_lower = resource.to_ascii_lowercase();
    service.expose_resources.iter().any(|pattern| {
        let normalized = pattern.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return false;
        }
        if normalized == "*" {
            return true;
        }
        if let Some(prefix) = normalized.strip_suffix('*') {
            return resource_lower.starts_with(prefix);
        }
        resource_lower == normalized
    })
}

fn render_service_env_value(
    template: &str,
    name: &str,
    container_name: &str,
    host: &str,
    internal_port: Option<u16>,
) -> String {
    let mut out = template
        .replace("{service}", name)
        .replace("{container}", container_name)
        .replace("{host}", host);
    if let Some(port) = internal_port {
        out = out.replace("{port}", &port.to_string());
    }
    out
}

fn collect_playwright_env(
    out: &mut Vec<(String, String)>,
    config: &AppConfig,
    isolation: IsolationMode,
) {
    let pw = &config.playwright;
    let service_cmd = match isolation {
        IsolationMode::Host => Some(pw.host_service_command.clone()),
        IsolationMode::Container => pw
            .container_service_command
            .clone()
            .or_else(|| Some(pw.host_service_command.clone())),
    };

    out.push((
        "PINOKIO_PLAYWRIGHT_MANAGED_BY_RUST".to_string(),
        bool_env_value(pw.managed_by_rust).to_string(),
    ));
    out.push((
        "PINOKIO_PLAYWRIGHT_AUTO_INSTALL_NODE_DEPS".to_string(),
        bool_env_value(pw.auto_install_node_deps).to_string(),
    ));
    out.push((
        "PINOKIO_PLAYWRIGHT_NODE_SETUP_COMMAND".to_string(),
        pw.node_setup_command.clone(),
    ));
    out.push((
        "PINOKIO_PLAYWRIGHT_AUTO_INSTALL_CHROMIUM".to_string(),
        bool_env_value(pw.auto_install_chromium).to_string(),
    ));
    out.push((
        "PINOKIO_PLAYWRIGHT_INSTALL_COMMAND".to_string(),
        pw.install_command.clone(),
    ));
    out.push((
        "PINOKIO_PLAYWRIGHT_REQUEST_TIMEOUT_MS".to_string(),
        pw.request_timeout_ms.to_string(),
    ));
    if let Some(service_cmd) = service_cmd {
        out.push((
            "PINOKIO_PLAYWRIGHT_SERVICE_COMMAND".to_string(),
            service_cmd,
        ));
    }
}

fn resolve_container_image(config: &AppConfig, spec: &AgentSpec) -> String {
    spec.container_image
        .clone()
        .unwrap_or_else(|| config.orchestrator.default_image.clone())
}

fn resolve_agent_networks(config: &AppConfig, spec: &AgentSpec) -> (Option<String>, Vec<String>) {
    if let Some(network) = spec
        .container_network
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if network.eq_ignore_ascii_case("managed") || network.eq_ignore_ascii_case("default") {
            let container_networks = config.orchestrator.container_networks();
            let primary_network = container_networks.first().cloned();
            let secondary_networks = container_networks.into_iter().skip(1).collect();
            return (primary_network, secondary_networks);
        }
        if network.eq_ignore_ascii_case("bridge") || network.eq_ignore_ascii_case("host") {
            return (Some(network.to_ascii_lowercase()), Vec::new());
        }
        return (Some(network.to_string()), Vec::new());
    }

    let container_networks = config.orchestrator.container_networks();
    let primary_network = container_networks.first().cloned();
    let secondary_networks = container_networks.into_iter().skip(1).collect();
    (primary_network, secondary_networks)
}

fn docker_network_scope(network: &str) -> Result<Option<String>> {
    let output = Command::new("docker")
        .args(["network", "inspect", "--format", "{{.Scope}}", network])
        .output()
        .with_context(|| format!("failed checking docker network scope for {}", network))?;
    if !output.status.success() {
        return Ok(None);
    }

    let scope = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if scope.is_empty() {
        return Ok(None);
    }
    Ok(Some(scope))
}

fn create_swarm_overlay_network(network: &str) -> Result<()> {
    let status = Command::new("docker")
        .args([
            "network",
            "create",
            "--driver",
            "overlay",
            "--attachable",
            network,
        ])
        .status()
        .with_context(|| format!("failed creating swarm overlay network {}", network))?;
    if !status.success() {
        anyhow::bail!(
            "failed to create swarm overlay network {} (status: {})",
            network,
            status
        );
    }
    Ok(())
}

fn maybe_pull_image(config: &AppConfig, image: &str) -> Result<()> {
    if !config.orchestrator.auto_pull_images {
        return Ok(());
    }
    if local_image_exists(image)? {
        return Ok(());
    }
    if was_image_pulled(image) {
        return Ok(());
    }
    let status = Command::new("docker")
        .arg("pull")
        .arg(image)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to pull container image {}", image))?;
    if !status.success() {
        anyhow::bail!(
            "failed to pull container image {} (status: {})",
            image,
            status
        );
    }
    emit_hook_event(
        &config.hooks,
        "runtime.image.pull.completed",
        &serde_json::json!({ "image": image }),
    )?;
    mark_image_pulled(image);
    Ok(())
}

fn resolve_backend(config: &AppConfig) -> Result<ContainerBackend> {
    ensure_docker_available()?;
    let backend = config.orchestrator.backend.to_lowercase();
    emit_hook_event(
        &config.hooks,
        "runtime.backend.resolve",
        &serde_json::json!({ "configured_backend": backend }),
    )?;
    match backend.as_str() {
        "docker" => Ok(ContainerBackend::Docker),
        "swarm" => resolve_swarm_or_fallback(config),
        "auto" => {
            if swarm_is_active()? {
                Ok(ContainerBackend::Swarm)
            } else {
                Ok(ContainerBackend::Docker)
            }
        }
        other => anyhow::bail!(
            "unsupported orchestrator backend '{}'. Use auto|docker|swarm",
            other
        ),
    }
}

fn resolve_swarm_or_fallback(config: &AppConfig) -> Result<ContainerBackend> {
    if swarm_is_active()? {
        return Ok(ContainerBackend::Swarm);
    }
    if config.orchestrator.auto_init_swarm {
        let init_status = Command::new("docker")
            .arg("swarm")
            .arg("init")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("failed to run docker swarm init")?;
        if init_status.success() && swarm_is_active()? {
            return Ok(ContainerBackend::Swarm);
        }
    }
    if config.orchestrator.allow_backend_fallback {
        return Ok(ContainerBackend::Docker);
    }
    anyhow::bail!("docker swarm is not active and backend fallback is disabled")
}

fn ensure_docker_available() -> Result<()> {
    let status = Command::new("docker")
        .arg("version")
        .arg("--format")
        .arg("{{.Server.Version}}")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("failed to execute docker version")?;
    if !status.success() {
        anyhow::bail!("docker is not available. Install/start Docker to run containerized agents");
    }
    Ok(())
}

fn swarm_is_active() -> Result<bool> {
    let output = Command::new("docker")
        .arg("info")
        .arg("--format")
        .arg("{{.Swarm.LocalNodeState}}")
        .output()
        .context("failed to check docker swarm state")?;
    if !output.status.success() {
        return Ok(false);
    }
    let state = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase();
    Ok(state == "active")
}

fn parse_bind_mount(value: &str) -> Option<(String, String, bool)> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    let readonly = parts.get(2).map(|v| *v == "ro").unwrap_or(false);
    Some((parts[0].to_string(), parts[1].to_string(), readonly))
}

fn attach_secondary_networks(container_name: &str, secondary_networks: &[String]) -> Result<()> {
    for network in secondary_networks {
        connect_container_to_network(container_name, network)?;
    }
    Ok(())
}

fn connect_container_to_network(container_name: &str, network: &str) -> Result<()> {
    const CONNECT_RETRIES: usize = 20;
    const CONNECT_DELAY_MS: u64 = 100;

    for attempt in 0..CONNECT_RETRIES {
        let output = Command::new("docker")
            .args(["network", "connect", network, container_name])
            .output()
            .with_context(|| {
                format!(
                    "failed running docker network connect {} {}",
                    network, container_name
                )
            })?;
        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("already exists") || stderr.contains("already connected") {
            return Ok(());
        }
        if (stderr.contains("no such container") || stderr.contains("is not running"))
            && attempt + 1 < CONNECT_RETRIES
        {
            std::thread::sleep(std::time::Duration::from_millis(CONNECT_DELAY_MS));
            continue;
        }

        anyhow::bail!(
            "failed to attach container {} to network {}: {}",
            container_name,
            network,
            stderr.trim()
        );
    }

    anyhow::bail!(
        "failed to attach container {} to network {} after {} retries",
        container_name,
        network,
        CONNECT_RETRIES
    );
}

fn short_runtime_id() -> String {
    Uuid::new_v4()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
}

fn normalize_mount(value: &str) -> String {
    if cfg!(target_os = "macos") && value.starts_with("/tmp:/tmp") {
        return value.replacen("/tmp:/tmp", "/private/tmp:/tmp", 1);
    }
    value.to_string()
}

fn host_documents_mount() -> Option<String> {
    if !mount_host_documents_enabled() {
        return None;
    }
    let source = resolve_host_documents_dir()?;
    let source_str = source.to_str()?.trim().to_string();
    if source_str.is_empty() {
        return None;
    }
    Some(format!(
        "{}:{}",
        source_str, CONTAINER_HOST_DOCUMENTS_PATH
    ))
}

fn host_desktop_mount() -> Option<String> {
    if !mount_host_desktop_enabled() {
        return None;
    }
    let source = resolve_host_desktop_dir()?;
    let source_str = source.to_str()?.trim().to_string();
    if source_str.is_empty() {
        return None;
    }
    Some(format!("{}:{}", source_str, CONTAINER_HOST_DESKTOP_PATH))
}

fn mount_host_documents_enabled() -> bool {
    let raw = env::var("PINOKIO_MOUNT_HOST_DOCUMENTS").unwrap_or_else(|_| "1".to_string());
    let normalized = raw.trim().to_ascii_lowercase();
    !(normalized == "0"
        || normalized == "false"
        || normalized == "no"
        || normalized == "off")
}

fn mount_host_desktop_enabled() -> bool {
    let raw = env::var("PINOKIO_MOUNT_HOST_DESKTOP").unwrap_or_else(|_| "1".to_string());
    let normalized = raw.trim().to_ascii_lowercase();
    !(normalized == "0"
        || normalized == "false"
        || normalized == "no"
        || normalized == "off")
}

fn resolve_host_documents_dir() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("PINOKIO_HOST_DOCUMENTS_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = expand_runtime_home(trimmed);
            if path.is_dir() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = env::var("USERPROFILE") {
            let path = PathBuf::from(home).join("Documents");
            if path.is_dir() {
                return Some(path);
            }
        }
        return None;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = env::var("HOME").ok()?;
        let path = PathBuf::from(home).join("Documents");
        if path.is_dir() {
            return Some(path);
        }
        None
    }
}

fn resolve_host_desktop_dir() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("PINOKIO_HOST_DESKTOP_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = expand_runtime_home(trimmed);
            if path.is_dir() {
                return Some(path);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = env::var("USERPROFILE") {
            let path = PathBuf::from(home).join("Desktop");
            if path.is_dir() {
                return Some(path);
            }
        }
        return None;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = env::var("HOME").ok()?;
        let path = PathBuf::from(home).join("Desktop");
        if path.is_dir() {
            return Some(path);
        }
        None
    }
}

fn expand_runtime_home(raw: &str) -> PathBuf {
    if raw == "~" || raw.starts_with("~/") {
        if let Ok(home) = env::var("HOME") {
            if raw == "~" {
                return PathBuf::from(home);
            }
            return Path::new(&home).join(raw.trim_start_matches("~/"));
        }
    }
    PathBuf::from(raw)
}

fn workspace_mount(config: &AppConfig) -> Result<Option<String>> {
    workspace_mount_pair(config).map(|pair| pair.map(|(src, dst)| format!("{}:{}", src, dst)))
}

fn workspace_mount_pair(config: &AppConfig) -> Result<Option<(String, String)>> {
    if !config.orchestrator.mount_workspace {
        return Ok(None);
    }
    let cwd = env::current_dir().context("failed to resolve current working directory")?;
    let raw = cwd
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid workspace path"))?;
    let src = if cfg!(target_os = "macos") && raw.starts_with("/tmp/") {
        raw.replacen("/tmp/", "/private/tmp/", 1)
    } else {
        raw.to_string()
    };
    Ok(Some((
        src,
        config.orchestrator.workspace_mount_path.clone(),
    )))
}

fn container_socket_path(config: &AppConfig, socket_path: &Path) -> Result<String> {
    if config.orchestrator.mount_workspace {
        let cwd = env::current_dir().context("failed to resolve workspace path")?;
        if let Ok(relative) = socket_path.strip_prefix(&cwd) {
            let container_path =
                PathBuf::from(&config.orchestrator.workspace_mount_path).join(relative);
            return container_path
                .to_str()
                .map(|p| p.to_string())
                .ok_or_else(|| anyhow::anyhow!("invalid container socket path"));
        }
    }

    let raw = socket_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid socket path"))?;
    if cfg!(target_os = "macos") && raw.starts_with("/private/tmp/") {
        return Ok(raw.replacen("/private/tmp/", "/tmp/", 1));
    }
    Ok(raw.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ContainerConnectArg {
    Socket(String),
    Tcp(String),
    Stdio,
}

fn container_connect_arg(
    config: &AppConfig,
    connect: &AgentConnect,
) -> Result<ContainerConnectArg> {
    match connect {
        AgentConnect::UnixSocket(path) => Ok(ContainerConnectArg::Socket(container_socket_path(
            config, path,
        )?)),
        AgentConnect::TcpAddress(addr) => Ok(ContainerConnectArg::Tcp(addr.clone())),
        AgentConnect::Stdio => Ok(ContainerConnectArg::Stdio),
    }
}

fn apply_connect_args(cmd: &mut Command, connect: &AgentConnect) {
    match connect {
        AgentConnect::UnixSocket(path) => {
            cmd.arg("--socket").arg(path);
        }
        AgentConnect::TcpAddress(addr) => {
            cmd.arg("--tcp").arg(addr);
        }
        AgentConnect::Stdio => {
            cmd.arg("--stdio");
        }
    }
}

fn append_connect_args(cmd: &mut Command, connect_arg: &ContainerConnectArg) {
    match connect_arg {
        ContainerConnectArg::Tcp(addr) => {
            cmd.arg("--tcp").arg(addr);
        }
        ContainerConnectArg::Socket(path) => {
            cmd.arg("--socket").arg(path);
        }
        ContainerConnectArg::Stdio => {
            cmd.arg("--stdio");
        }
    }
}

fn append_connect_vec_args(args: &mut Vec<String>, connect_arg: &ContainerConnectArg) {
    match connect_arg {
        ContainerConnectArg::Tcp(addr) => {
            args.push("--tcp".to_string());
            args.push(addr.clone());
        }
        ContainerConnectArg::Socket(path) => {
            args.push("--socket".to_string());
            args.push(path.clone());
        }
        ContainerConnectArg::Stdio => {
            args.push("--stdio".to_string());
        }
    }
}

fn join_shell_escaped(values: &[String]) -> String {
    values
        .iter()
        .map(|v| shell_quote(v))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn bool_env_value(value: bool) -> &'static str {
    if value {
        "1"
    } else {
        "0"
    }
}

fn should_apply_runtime_dns() -> bool {
    if let Ok(explicit) = env::var("PINOKIO_RUNTIME_DNS") {
        let value = explicit.trim().to_ascii_lowercase();
        if value == "1" || value == "true" || value == "yes" {
            return true;
        }
        if value == "0" || value == "false" || value == "no" {
            return false;
        }
    }
    !cfg!(target_os = "macos")
}

fn should_inject_host_binary(config: &AppConfig) -> bool {
    config.orchestrator.inject_host_binary && cfg!(target_os = "linux")
}

fn local_image_exists(image: &str) -> Result<bool> {
    let status = Command::new("docker")
        .arg("image")
        .arg("inspect")
        .arg(image)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to inspect local image {}", image))?;
    Ok(status.success())
}

fn was_image_pulled(image: &str) -> bool {
    let pulled = pulled_images();
    pulled
        .lock()
        .ok()
        .map(|set| set.contains(image))
        .unwrap_or(false)
}

fn mark_image_pulled(image: &str) {
    let pulled = pulled_images();
    if let Ok(mut set) = pulled.lock() {
        set.insert(image.to_string());
    }
}

fn pulled_images() -> &'static Mutex<HashSet<String>> {
    static IMAGES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IMAGES.get_or_init(|| Mutex::new(HashSet::new()))
}
