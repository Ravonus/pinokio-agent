use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{AppConfig, OrchestratorServiceConfig};
use crate::credentials;
use crate::hooks::emit_hook_event;
use crate::model::{AgentSpec, ExecutionKind, IsolationMode};

#[derive(Debug, Clone, Serialize)]
pub struct SetupReport {
    pub ok: bool,
    pub playwright_ready: bool,
    pub containers_ready: bool,
    pub selected_backend: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedServiceStatus {
    pub name: String,
    pub enabled: bool,
    pub image: String,
    pub container_name: String,
    pub exists: bool,
    pub running: bool,
    pub health: Option<String>,
    pub host_ports: Vec<String>,
    pub internal_port: Option<u16>,
    pub networks: Vec<String>,
    pub aliases: Vec<String>,
}

pub fn setup_for_user(config: &AppConfig) -> Result<SetupReport> {
    emit_hook_event(&config.hooks, "setup.started", &serde_json::json!({}))?;
    let mut notes = Vec::new();
    ensure_playwright_base(config, &mut notes)?;
    ensure_containers_base(config, &mut notes)?;
    ensure_auth_and_marketplace_base(config, &mut notes)?;
    ensure_llm_credentials_base(config, &mut notes)?;
    let report = SetupReport {
        ok: true,
        playwright_ready: true,
        containers_ready: true,
        selected_backend: selected_backend_hint(config),
        notes,
    };
    emit_hook_event(
        &config.hooks,
        "setup.completed",
        &serde_json::json!({ "report": &report }),
    )?;
    Ok(report)
}

pub fn prepare_for_plan(config: &AppConfig, plan: &[AgentSpec]) -> Result<()> {
    emit_hook_event(
        &config.hooks,
        "setup.plan_prepare.started",
        &serde_json::json!({ "agent_count": plan.len() }),
    )?;
    let needs_playwright = plan
        .iter()
        .any(|spec| spec.execution == ExecutionKind::PlaywrightRead);
    let needs_containers = plan
        .iter()
        .any(|spec| spec.isolation == IsolationMode::Container);

    let mut notes = Vec::new();
    if needs_playwright {
        ensure_playwright_base(config, &mut notes)?;
    }
    if needs_containers {
        ensure_containers_base(config, &mut notes)?;
    }

    emit_hook_event(
        &config.hooks,
        "setup.plan_prepare.completed",
        &serde_json::json!({ "agent_count": plan.len() }),
    )?;
    Ok(())
}

fn ensure_playwright_base(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    ensure_cmd_available("node", &["--version"], "node")?;

    if config.playwright.auto_install_node_deps && !playwright_dependency_present()? {
        run_shell(&config.playwright.node_setup_command)
            .with_context(|| "failed to auto-install Playwright node dependencies".to_string())?;
        notes.push("installed node dependencies automatically".to_string());
    }

    if config.playwright.auto_install_chromium {
        run_shell(&config.playwright.install_command)
            .with_context(|| "failed to auto-install Chromium".to_string())?;
        notes.push("ensured Chromium install for Playwright".to_string());
    }

    Ok(())
}

fn ensure_containers_base(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    if !config.orchestrator.enabled {
        anyhow::bail!("container orchestrator is disabled; enable it to run containerized agents");
    }

    ensure_cmd_available("docker", &["version"], "docker")?;
    let backend = config.orchestrator.backend.to_lowercase();
    match backend.as_str() {
        "docker" => {}
        "swarm" => ensure_swarm_active_or_init(config, notes)?,
        "auto" => {
            if swarm_is_active()? {
                notes.push("swarm detected; will use swarm backend".to_string());
            } else {
                notes.push("swarm not active; will use docker backend".to_string());
            }
        }
        other => anyhow::bail!("unsupported orchestrator backend '{}'", other),
    }

    ensure_orchestrator_networks(config, notes)?;
    ensure_orchestrator_services(config, notes, None)?;
    ensure_local_runtime_images(config, notes)?;
    Ok(())
}

pub fn service_statuses(config: &AppConfig) -> Result<Vec<ManagedServiceStatus>> {
    let mut out = Vec::new();
    for (name, service) in iter_services(config) {
        out.push(read_managed_service_status(config, &name, &service)?);
    }
    Ok(out)
}

pub fn ensure_services(
    config: &AppConfig,
    selected: Option<&[String]>,
) -> Result<Vec<ManagedServiceStatus>> {
    let mut notes = Vec::new();
    ensure_orchestrator_networks(config, &mut notes)?;
    ensure_orchestrator_services(config, &mut notes, selected)?;
    service_statuses(config)
}

fn ensure_auth_and_marketplace_base(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    if config.auth.enabled {
        notes.push(format!(
            "auth enabled (provider={}, required={})",
            config.auth.provider, config.auth.required
        ));
        if config.auth.provider.eq_ignore_ascii_case("command")
            && config.auth.login_command.is_none()
        {
            anyhow::bail!("auth.provider=command requires auth.login_command");
        }
    }

    if config.marketplace.enabled {
        if config.marketplace.endpoint.is_none() {
            anyhow::bail!("marketplace.enabled=true requires marketplace.endpoint");
        }
        notes.push("marketplace tracking enabled".to_string());
    }

    Ok(())
}

fn ensure_llm_credentials_base(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    let statuses = credentials::statuses(config)?;
    let ready = statuses.iter().filter(|s| s.token_present).count();
    notes.push(format!("credentials ready: {}/{}", ready, statuses.len()));
    Ok(())
}

fn ensure_local_runtime_images(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    let mut images = HashSet::new();
    images.insert(config.orchestrator.default_image.clone());
    images.insert(config.manager.default_container_image.clone());
    for image in config.orchestrator.resource_images.values() {
        images.insert(image.clone());
    }

    for image in images {
        if !is_local_runtime_image_tag(&image) {
            continue;
        }
        let exists = local_image_exists(&image)?;
        if exists && !local_runtime_image_needs_rebuild(&image)? {
            continue;
        }
        build_local_runtime_image(config, &image)?;
        if exists {
            notes.push(format!("rebuilt local runtime image {}", image));
        } else {
            notes.push(format!("built local runtime image {}", image));
        }
    }

    Ok(())
}

fn is_local_runtime_image_tag(image: &str) -> bool {
    image.contains("pinokio-agent-micro") && image.ends_with(":local")
}

fn ensure_orchestrator_networks(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    let networks = config.orchestrator.container_networks();
    if networks.is_empty() {
        return Ok(());
    }

    for network in networks {
        if docker_network_exists(&network)? {
            continue;
        }
        if !config.orchestrator.auto_create_networks {
            anyhow::bail!(
                "required docker network '{}' is missing (auto_create_networks=false)",
                network
            );
        }
        create_docker_network(&network)?;
        notes.push(format!("created docker network {}", network));
    }
    Ok(())
}

fn docker_network_exists(network: &str) -> Result<bool> {
    let status = Command::new("docker")
        .args(["network", "inspect", network])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed checking docker network {}", network))?;
    Ok(status.success())
}

fn create_docker_network(network: &str) -> Result<()> {
    let status = Command::new("docker")
        .args(["network", "create", "--driver", "bridge", network])
        .status()
        .with_context(|| format!("failed creating docker network {}", network))?;
    if !status.success() {
        anyhow::bail!(
            "failed to create docker network {} (status: {})",
            network,
            status
        );
    }
    Ok(())
}

fn ensure_orchestrator_services(
    config: &AppConfig,
    notes: &mut Vec<String>,
    selected: Option<&[String]>,
) -> Result<()> {
    if !config.orchestrator.enabled || config.orchestrator.services.is_empty() {
        return Ok(());
    }

    let selected_set: HashSet<String> = selected
        .map(|items| {
            items
                .iter()
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if !selected_set.is_empty() {
        for requested in &selected_set {
            let known = config
                .orchestrator
                .services
                .keys()
                .any(|name| name.eq_ignore_ascii_case(requested));
            if !known {
                anyhow::bail!("unknown managed service '{}'", requested);
            }
        }
    }

    for (name, service) in iter_services(config) {
        if !selected_set.is_empty() && !selected_set.contains(&name.to_ascii_lowercase()) {
            continue;
        }
        if !service.enabled {
            notes.push(format!("managed service {} is disabled", name));
            continue;
        }
        ensure_orchestrator_service(config, &name, &service)?;
        notes.push(format!("managed service {} is ready", name));
    }

    Ok(())
}

fn ensure_orchestrator_service(
    config: &AppConfig,
    name: &str,
    service: &OrchestratorServiceConfig,
) -> Result<()> {
    let image = service.image.trim();
    if image.is_empty() {
        anyhow::bail!("managed service '{}' has empty image", name);
    }

    if config.orchestrator.auto_pull_images && !local_image_exists(image)? {
        let status = Command::new("docker")
            .arg("pull")
            .arg(image)
            .status()
            .with_context(|| format!("failed to pull managed service image {}", image))?;
        if !status.success() {
            anyhow::bail!(
                "failed to pull managed service image {} (status: {})",
                image,
                status
            );
        }
    }

    let container_name = config.orchestrator.service_container_name(name, service);
    if let Some((running, _)) = inspect_container_running_health(&container_name)? {
        if running {
            ensure_service_networks(config, service, &container_name)?;
            wait_for_service_readiness(&container_name, service)?;
            return Ok(());
        }

        remove_container(&container_name)?;
    }

    let mut args: Vec<String> = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        container_name.clone(),
        "--label".to_string(),
        format!("io.pinokio.managed_service={}", name),
    ];

    let restart = service.restart.trim();
    if !restart.is_empty() {
        args.push("--restart".to_string());
        args.push(restart.to_string());
    }

    let networks = config.orchestrator.container_networks();
    let primary_network = networks.first().cloned();
    let secondary_networks: Vec<String> = networks.into_iter().skip(1).collect();

    if let Some(network) = &primary_network {
        args.push("--network".to_string());
        args.push(network.clone());
        for alias in &service.network_aliases {
            let trimmed = alias.trim();
            if trimmed.is_empty() {
                continue;
            }
            args.push("--network-alias".to_string());
            args.push(trimmed.to_string());
        }
    }

    for port in &service.ports {
        let trimmed = port.trim();
        if trimmed.is_empty() {
            continue;
        }
        args.push("-p".to_string());
        args.push(trimmed.to_string());
    }

    for mount in &service.mounts {
        let trimmed = mount.trim();
        if trimmed.is_empty() {
            continue;
        }
        args.push("-v".to_string());
        args.push(normalize_service_mount(trimmed));
    }

    let mut env_entries: Vec<(&String, &String)> = service.env.iter().collect();
    env_entries.sort_by(|a, b| a.0.cmp(b.0));
    for (key, value) in env_entries {
        args.push("-e".to_string());
        args.push(format!("{}={}", key, value));
    }

    args.push(image.to_string());
    for arg in &service.command {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }
        args.push(trimmed.to_string());
    }

    let output = Command::new("docker")
        .args(&args)
        .output()
        .with_context(|| format!("failed to run docker for managed service {}", name))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "failed to start managed service {}: {}",
            name,
            stderr.trim()
        );
    }

    ensure_service_secondary_networks(service, &container_name, &secondary_networks)?;
    wait_for_service_readiness(&container_name, service)?;
    Ok(())
}

fn wait_for_service_readiness(
    container_name: &str,
    service: &OrchestratorServiceConfig,
) -> Result<()> {
    let timeout = service.ready_timeout_secs.max(5);
    let started = std::time::Instant::now();
    let check_cmd = service
        .healthcheck_cmd
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    if check_cmd.is_none() {
        return Ok(());
    }

    let health_cmd = check_cmd.unwrap_or_default();
    loop {
        if started.elapsed().as_secs() > timeout {
            anyhow::bail!(
                "managed service {} did not become ready within {}s",
                container_name,
                timeout
            );
        }

        if let Some((running, _)) = inspect_container_running_health(container_name)? {
            if !running {
                anyhow::bail!("managed service {} is not running", container_name);
            }
        } else {
            anyhow::bail!(
                "managed service {} disappeared while waiting",
                container_name
            );
        }

        let status = Command::new("docker")
            .args(["exec", container_name, "sh", "-lc", health_cmd])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .with_context(|| {
                format!(
                    "failed healthcheck command for managed service {}",
                    container_name
                )
            })?;
        if status.success() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(800));
    }
}

fn ensure_service_networks(
    config: &AppConfig,
    service: &OrchestratorServiceConfig,
    container_name: &str,
) -> Result<()> {
    let networks = config.orchestrator.container_networks();
    if networks.len() <= 1 {
        return Ok(());
    }
    let secondary_networks: Vec<String> = networks.into_iter().skip(1).collect();
    ensure_service_secondary_networks(service, container_name, &secondary_networks)
}

fn ensure_service_secondary_networks(
    service: &OrchestratorServiceConfig,
    container_name: &str,
    networks: &[String],
) -> Result<()> {
    for network in networks {
        connect_service_to_network(container_name, network, &service.network_aliases)?;
    }
    Ok(())
}

fn connect_service_to_network(
    container_name: &str,
    network: &str,
    aliases: &[String],
) -> Result<()> {
    const CONNECT_RETRIES: usize = 20;
    const CONNECT_DELAY_MS: u64 = 100;

    for attempt in 0..CONNECT_RETRIES {
        let mut args: Vec<String> = vec!["network".to_string(), "connect".to_string()];
        for alias in aliases {
            let trimmed = alias.trim();
            if trimmed.is_empty() {
                continue;
            }
            args.push("--alias".to_string());
            args.push(trimmed.to_string());
        }
        args.push(network.to_string());
        args.push(container_name.to_string());

        let output = Command::new("docker")
            .args(&args)
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
            thread::sleep(Duration::from_millis(CONNECT_DELAY_MS));
            continue;
        }

        anyhow::bail!(
            "failed to attach service container {} to network {}: {}",
            container_name,
            network,
            stderr.trim()
        );
    }

    anyhow::bail!(
        "failed to attach service container {} to network {} after {} retries",
        container_name,
        network,
        CONNECT_RETRIES
    );
}

fn inspect_container_running_health(
    container_name: &str,
) -> Result<Option<(bool, Option<String>)>> {
    let output = Command::new("docker")
        .args([
            "inspect",
            "--format",
            "{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}",
            container_name,
        ])
        .output()
        .with_context(|| format!("failed to inspect container {}", container_name))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("no such object") {
            return Ok(None);
        }
        anyhow::bail!(
            "failed to inspect container {}: {}",
            container_name,
            stderr.trim()
        );
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = value.splitn(2, '|');
    let running = parts
        .next()
        .map(|entry| entry.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let health = parts
        .next()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.to_string());
    Ok(Some((running, health)))
}

fn remove_container(container_name: &str) -> Result<()> {
    let status = Command::new("docker")
        .args(["rm", "-f", container_name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to remove container {}", container_name))?;
    if !status.success() {
        anyhow::bail!(
            "failed to remove stale managed service container {}",
            container_name
        );
    }
    Ok(())
}

fn normalize_service_mount(value: &str) -> String {
    if cfg!(target_os = "macos") && value.starts_with("/tmp:/tmp") {
        return value.replacen("/tmp:/tmp", "/private/tmp:/tmp", 1);
    }
    value.to_string()
}

fn iter_services(config: &AppConfig) -> Vec<(String, OrchestratorServiceConfig)> {
    let mut services: Vec<(String, OrchestratorServiceConfig)> = config
        .orchestrator
        .services
        .iter()
        .map(|(name, service)| (name.clone(), service.clone()))
        .collect();
    services.sort_by(|a, b| a.0.cmp(&b.0));
    services
}

fn read_managed_service_status(
    config: &AppConfig,
    name: &str,
    service: &OrchestratorServiceConfig,
) -> Result<ManagedServiceStatus> {
    let container_name = config.orchestrator.service_container_name(name, service);
    let inspect = inspect_container_running_health(&container_name)?;
    let (exists, running, health) = match inspect {
        Some((running, health)) => (true, running, health),
        None => (false, false, None),
    };
    Ok(ManagedServiceStatus {
        name: name.to_string(),
        enabled: service.enabled,
        image: service.image.clone(),
        container_name,
        exists,
        running,
        health,
        host_ports: service.ports.clone(),
        internal_port: service.internal_port,
        networks: config.orchestrator.container_networks(),
        aliases: service.network_aliases.clone(),
    })
}

fn build_local_runtime_image(config: &AppConfig, image: &str) -> Result<()> {
    let runtime_dockerfile_allowed = runtime_dockerfile_allowed();
    let runtime_dockerfile = Path::new("Dockerfile.micro-runtime");
    if runtime_dockerfile_allowed && runtime_dockerfile.exists() {
        match ensure_linux_runtime_binary(config) {
            Ok(()) => {
                if docker_build_with_retry(
                    ["build", "-t", image, "-f", "Dockerfile.micro-runtime", "."],
                    "Dockerfile.micro-runtime",
                )? {
                    return Ok(());
                }
            }
            Err(err) => {
                eprintln!(
                    "runtime Dockerfile prebuild failed ({}); falling back to Dockerfile.micro",
                    err
                );
            }
        }
    }

    let build_dockerfile = Path::new("Dockerfile.micro");
    if build_dockerfile.exists() {
        if docker_build_with_retry(
            ["build", "-t", image, "-f", "Dockerfile.micro", "."],
            "Dockerfile.micro",
        )? {
            return Ok(());
        }
    }

    if runtime_dockerfile_allowed {
        anyhow::bail!(
            "failed to build local runtime image {} (tried Dockerfile.micro-runtime then Dockerfile.micro)",
            image
        )
    } else {
        anyhow::bail!(
            "failed to build local runtime image {} (runtime Dockerfile skipped on this host architecture, Dockerfile.micro failed)",
            image
        )
    }
}

fn docker_build_with_retry<const N: usize>(args: [&str; N], label: &str) -> Result<bool> {
    let attempts = local_image_build_attempts();
    for attempt in 1..=attempts {
        let status = Command::new("docker")
            .args(args)
            .status()
            .with_context(|| format!("failed to run docker build for {}", label))?;
        if status.success() {
            return Ok(true);
        }
        if attempt < attempts {
            let sleep_ms = 2000 * attempt as u64;
            eprintln!(
                "docker build {} failed (attempt {}/{}, status: {}). retrying in {}ms",
                label, attempt, attempts, status, sleep_ms
            );
            thread::sleep(Duration::from_millis(sleep_ms));
        }
    }
    Ok(false)
}

fn local_image_build_attempts() -> u32 {
    if let Ok(value) = env::var("PINOKIO_DOCKER_BUILD_ATTEMPTS") {
        if let Ok(parsed) = value.trim().parse::<u32>() {
            return parsed.clamp(1, 5);
        }
    }
    2
}

fn runtime_dockerfile_allowed() -> bool {
    if let Ok(explicit) = env::var("PINOKIO_USE_RUNTIME_DOCKERFILE") {
        let value = explicit.trim().to_ascii_lowercase();
        if value == "1" || value == "true" || value == "yes" {
            return true;
        }
        if value == "0" || value == "false" || value == "no" {
            return false;
        }
    }

    true
}

fn ensure_linux_runtime_binary(config: &AppConfig) -> Result<()> {
    if let Ok(()) = ensure_linux_runtime_binary_in_container(config) {
        return Ok(());
    }

    let target = linux_runtime_target()
        .ok_or_else(|| anyhow::anyhow!("unsupported host architecture {}", env::consts::ARCH))?;
    ensure_rust_target_installed(target);

    let status = Command::new("cargo")
        .args(["zigbuild", "--release", "--target", target])
        .status();
    if let Ok(status) = status {
        if status.success() {
            stage_runtime_binary(target)?;
            return Ok(());
        }
    }

    let status = Command::new("cargo")
        .args(["build", "--release", "--target", target])
        .status()
        .context("failed to build linux runtime binary for container image")?;
    if !status.success() {
        anyhow::bail!("linux runtime binary build failed with status {}", status);
    }
    stage_runtime_binary(target)?;
    Ok(())
}

fn ensure_linux_runtime_binary_in_container(config: &AppConfig) -> Result<()> {
    let workspace = env::current_dir().context("failed to resolve current working directory")?;
    let workspace_str = workspace
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid workspace path"))?;
    let workspace_mount = if cfg!(target_os = "macos") && workspace_str.starts_with("/tmp/") {
        workspace_str.replacen("/tmp/", "/private/tmp/", 1)
    } else {
        workspace_str.to_string()
    };

    let cargo_home_host = resolve_host_cargo_home();

    if let Some(path) = cargo_home_host.as_ref() {
        let offline_status =
            run_linux_runtime_container_build(config, &workspace_mount, Some(path), true)
                .context("failed to run offline linux runtime build in rust container")?;
        if offline_status.success() {
            return stage_runtime_binary_from_source(Path::new(
                "target/linux-container/release/pinokio-agent",
            ));
        }
    }

    let online_status = run_linux_runtime_container_build(
        config,
        &workspace_mount,
        cargo_home_host.as_ref(),
        false,
    )
    .context("failed to run online linux runtime build in rust container")?;
    if !online_status.success() {
        anyhow::bail!(
            "linux runtime container build failed with status {}",
            online_status
        );
    }

    stage_runtime_binary_from_source(Path::new("target/linux-container/release/pinokio-agent"))
}

fn run_linux_runtime_container_build(
    config: &AppConfig,
    workspace_mount: &str,
    cargo_home_host: Option<&PathBuf>,
    offline: bool,
) -> Result<std::process::ExitStatus> {
    let mut cmd = Command::new("docker");
    cmd.arg("run").arg("--rm");

    let using_host_network = if let Some(network) = &config.orchestrator.network {
        cmd.arg("--network").arg(network);
        false
    } else {
        cmd.arg("--network").arg("host");
        true
    };

    if !using_host_network {
        for dns in &config.orchestrator.dns_servers {
            cmd.arg("--dns").arg(dns);
        }
    }

    if let Ok(uid_output) = Command::new("id").arg("-u").output() {
        if let Ok(gid_output) = Command::new("id").arg("-g").output() {
            if uid_output.status.success() && gid_output.status.success() {
                let uid = String::from_utf8_lossy(&uid_output.stdout)
                    .trim()
                    .to_string();
                let gid = String::from_utf8_lossy(&gid_output.stdout)
                    .trim()
                    .to_string();
                if !uid.is_empty() && !gid.is_empty() {
                    cmd.arg("--user").arg(format!("{}:{}", uid, gid));
                }
            }
        }
    }

    cmd.arg("-v")
        .arg(format!("{}:/src", workspace_mount))
        .arg("-w")
        .arg("/src")
        .arg("-e")
        .arg("CARGO_TARGET_DIR=/src/target/linux-container")
        .arg("-e")
        .arg("CARGO_NET_RETRY=10")
        .arg("-e")
        .arg("CARGO_HTTP_TIMEOUT=120")
        .arg("-e")
        .arg("CARGO_HTTP_MULTIPLEXING=false");

    if let Some(cargo_home) = cargo_home_host {
        if let Some(value) = cargo_home.to_str() {
            cmd.arg("-v").arg(format!("{}:/cargo-home", value));
            cmd.arg("-e").arg("CARGO_HOME=/cargo-home");
        }
    }

    if offline {
        cmd.arg("-e").arg("CARGO_NET_OFFLINE=true");
    }

    cmd.arg("rust:1.93-bookworm")
        .arg("sh")
        .arg("-lc")
        .arg("/usr/local/cargo/bin/cargo build --release --locked");

    cmd.status()
        .context("failed to invoke rust container runtime build")
}

fn resolve_host_cargo_home() -> Option<PathBuf> {
    if let Ok(explicit) = env::var("CARGO_HOME") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.exists() {
                return Some(path);
            }
        }
    }

    if let Ok(home) = env::var("HOME") {
        let path = PathBuf::from(home).join(".cargo");
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn ensure_rust_target_installed(target: &str) {
    let status = Command::new("rustup")
        .args(["target", "add", target])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(s) if s.success() => {}
        _ => eprintln!(
            "warning: could not pre-install rust target {} (will try build anyway)",
            target
        ),
    }
}

fn linux_runtime_target() -> Option<&'static str> {
    match env::consts::ARCH {
        "x86_64" => Some("x86_64-unknown-linux-musl"),
        "aarch64" => Some("aarch64-unknown-linux-musl"),
        _ => None,
    }
}

fn stage_runtime_binary(target: &str) -> Result<()> {
    let source = Path::new("target")
        .join(target)
        .join("release")
        .join("pinokio-agent");
    stage_runtime_binary_from_source(&source)
}

fn stage_runtime_binary_from_source(source: &Path) -> Result<()> {
    if !source.exists() {
        anyhow::bail!(
            "linux runtime binary missing after build: {}",
            source.display()
        );
    }

    let staged_dir = Path::new("target").join("linux-runtime");
    fs::create_dir_all(&staged_dir)
        .with_context(|| format!("failed to create {}", staged_dir.display()))?;
    let staged_bin = staged_dir.join("pinokio-agent");
    fs::copy(&source, &staged_bin).with_context(|| {
        format!(
            "failed to stage runtime binary from {} to {}",
            source.display(),
            staged_bin.display()
        )
    })?;
    Ok(())
}

fn ensure_swarm_active_or_init(config: &AppConfig, notes: &mut Vec<String>) -> Result<()> {
    if swarm_is_active()? {
        return Ok(());
    }
    if config.orchestrator.auto_init_swarm {
        let status = Command::new("docker")
            .arg("swarm")
            .arg("init")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("failed to run docker swarm init")?;
        if status.success() && swarm_is_active()? {
            notes.push("initialized docker swarm automatically".to_string());
            return Ok(());
        }
    }
    if config.orchestrator.allow_backend_fallback {
        notes.push("swarm unavailable; will fallback to docker backend".to_string());
        return Ok(());
    }
    anyhow::bail!("docker swarm is not active and fallback is disabled")
}

fn ensure_cmd_available(bin: &str, args: &[&str], label: &str) -> Result<()> {
    let status = Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("failed to run {}", bin))?;
    if !status.success() {
        anyhow::bail!("{} is not available", label);
    }
    Ok(())
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

fn local_runtime_image_needs_rebuild(image: &str) -> Result<bool> {
    let output = Command::new("docker")
        .arg("image")
        .arg("inspect")
        .arg("--format")
        .arg("{{.Architecture}}|{{ index .Config.Labels \"io.pinokio.protocol\" }}|{{ index .Config.Labels \"io.pinokio.build_flavor\" }}")
        .arg(image)
        .output()
        .with_context(|| format!("failed to inspect labels for image {}", image))?;
    if !output.status.success() {
        return Ok(true);
    }
    let inspect = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut fields = inspect.split('|');
    let arch = fields.next().unwrap_or("").trim();
    let protocol = fields.next().unwrap_or("").trim();
    let flavor = fields.next().unwrap_or("").trim();
    if protocol != "tcp-v2" {
        return Ok(true);
    }

    let expected_flavor = if runtime_dockerfile_allowed() {
        "runtime-copy"
    } else {
        "docker-build"
    };
    if flavor != expected_flavor {
        return Ok(true);
    }

    if let Some(expected_arch) = expected_docker_arch() {
        if !arch.is_empty() && arch != expected_arch {
            return Ok(true);
        }
    }

    Ok(false)
}

fn expected_docker_arch() -> Option<&'static str> {
    match env::consts::ARCH {
        "x86_64" => Some("amd64"),
        "aarch64" => Some("arm64"),
        _ => None,
    }
}

fn playwright_dependency_present() -> Result<bool> {
    let cwd_candidate = env::current_dir()
        .context("failed to get cwd")?
        .join("node_modules/playwright/package.json");
    if cwd_candidate.exists() {
        return Ok(true);
    }

    let exe_candidate = env::current_exe()
        .context("failed to get current executable path")?
        .parent()
        .map(|p| p.join("../node_modules/playwright/package.json"))
        .ok_or_else(|| anyhow::anyhow!("failed to resolve executable parent"))?;
    Ok(exe_candidate.exists())
}

fn run_shell(command: &str) -> Result<()> {
    let status = Command::new("sh")
        .arg("-c")
        .arg(command)
        .status()
        .with_context(|| format!("failed to run shell command: {}", command))?;
    if !status.success() {
        anyhow::bail!("shell command failed [{}]: {}", status, command);
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

fn selected_backend_hint(config: &AppConfig) -> Option<String> {
    if !config.orchestrator.enabled {
        return None;
    }
    let backend = config.orchestrator.backend.to_lowercase();
    if backend == "auto" {
        Some("auto(docker|swarm)".to_string())
    } else {
        Some(backend)
    }
}
