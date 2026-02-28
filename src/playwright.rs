use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use serde_json::{json, Value};

pub fn read_web_page_title(url: &str) -> Result<Value> {
    let runtime = PlaywrightRuntime::from_env()?;
    prepare_runtime(&runtime)?;
    run_with_retry(&runtime, url)
}

fn run_with_retry(runtime: &PlaywrightRuntime, url: &str) -> Result<Value> {
    match run_once(runtime, url) {
        Ok(value) => Ok(value),
        Err(err) => {
            if runtime.auto_install_chromium {
                install_chromium(runtime)?;
                run_once(runtime, url).with_context(|| {
                    format!("playwright retry failed after chromium install: {}", err)
                })
            } else {
                Err(err)
            }
        }
    }
}

fn run_once(runtime: &PlaywrightRuntime, url: &str) -> Result<Value> {
    let mut child = match &runtime.launch {
        PlaywrightLaunch::Shell(command) => Command::new("sh")
            .arg("-c")
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| {
                format!("failed to spawn playwright service via shell: {}", command)
            })?,
        PlaywrightLaunch::NodeScript(script) => Command::new("node")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to spawn playwright service script")?,
    };

    let payload = json!({
        "action": "read_title",
        "url": url,
        "timeout_ms": runtime.request_timeout_ms
    });

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .context("failed to send payload to playwright service")?;
        stdin
            .write_all(b"\n")
            .context("failed to send payload newline to playwright service")?;
    }

    let output = child
        .wait_with_output()
        .context("failed to wait for playwright service")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("playwright service failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8(output.stdout).context("playwright output was not utf-8")?;
    let parsed: Value =
        serde_json::from_str(stdout.trim()).context("invalid json from playwright service")?;
    Ok(parsed)
}

fn prepare_runtime(runtime: &PlaywrightRuntime) -> Result<()> {
    if !runtime.requires_local_node_assets() {
        return Ok(());
    }

    ensure_node_available()?;
    if runtime.auto_install_node_deps && !playwright_dependency_present()? {
        install_node_deps(runtime)?;
    }
    Ok(())
}

fn install_chromium(runtime: &PlaywrightRuntime) -> Result<()> {
    let install_cmd = runtime
        .install_command
        .as_deref()
        .unwrap_or("npx playwright install chromium");
    let status = Command::new("sh")
        .arg("-c")
        .arg(install_cmd)
        .status()
        .with_context(|| format!("failed to run chromium install command: {}", install_cmd))?;
    if !status.success() {
        anyhow::bail!(
            "chromium install command failed with status {}: {}",
            status,
            install_cmd
        );
    }
    Ok(())
}

fn install_node_deps(runtime: &PlaywrightRuntime) -> Result<()> {
    static NODE_SETUP_DONE: OnceLock<()> = OnceLock::new();
    if NODE_SETUP_DONE.get().is_some() {
        return Ok(());
    }

    let setup_cmd = runtime
        .node_setup_command
        .as_deref()
        .unwrap_or("npm install --omit=dev");
    let status = Command::new("sh")
        .arg("-c")
        .arg(setup_cmd)
        .status()
        .with_context(|| format!("failed to run node setup command: {}", setup_cmd))?;
    if !status.success() {
        anyhow::bail!(
            "node setup command failed with status {}: {}",
            status,
            setup_cmd
        );
    }
    let _ = NODE_SETUP_DONE.set(());
    Ok(())
}

fn ensure_node_available() -> Result<()> {
    let status = Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("failed to execute node --version")?;
    if !status.success() {
        anyhow::bail!("node is not available in PATH");
    }
    Ok(())
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

#[derive(Debug, Clone)]
enum PlaywrightLaunch {
    Shell(String),
    NodeScript(PathBuf),
}

#[derive(Debug, Clone)]
struct PlaywrightRuntime {
    launch: PlaywrightLaunch,
    auto_install_node_deps: bool,
    node_setup_command: Option<String>,
    auto_install_chromium: bool,
    install_command: Option<String>,
    request_timeout_ms: u64,
}

impl PlaywrightRuntime {
    fn from_env() -> Result<Self> {
        let managed_by_rust = env_bool("PINOKIO_PLAYWRIGHT_MANAGED_BY_RUST", true);
        let launch = if managed_by_rust {
            if let Ok(service_command) = env::var("PINOKIO_PLAYWRIGHT_SERVICE_COMMAND") {
                PlaywrightLaunch::Shell(service_command)
            } else {
                PlaywrightLaunch::NodeScript(resolve_worker_path()?)
            }
        } else {
            PlaywrightLaunch::NodeScript(resolve_worker_path()?)
        };

        let auto_install_node_deps = env_bool("PINOKIO_PLAYWRIGHT_AUTO_INSTALL_NODE_DEPS", true);
        let node_setup_command = env::var("PINOKIO_PLAYWRIGHT_NODE_SETUP_COMMAND").ok();
        let auto_install_chromium = env_bool("PINOKIO_PLAYWRIGHT_AUTO_INSTALL_CHROMIUM", false);
        let install_command = env::var("PINOKIO_PLAYWRIGHT_INSTALL_COMMAND").ok();
        let request_timeout_ms = env_u64("PINOKIO_PLAYWRIGHT_REQUEST_TIMEOUT_MS", 45000);

        Ok(Self {
            launch,
            auto_install_node_deps,
            node_setup_command,
            auto_install_chromium,
            install_command,
            request_timeout_ms,
        })
    }

    fn requires_local_node_assets(&self) -> bool {
        match &self.launch {
            PlaywrightLaunch::NodeScript(_) => true,
            PlaywrightLaunch::Shell(command) => {
                command.contains("workers/playwright-service.mjs") || command.starts_with("node ")
            }
        }
    }
}

fn resolve_worker_path() -> Result<PathBuf> {
    if let Ok(explicit) = env::var("PINOKIO_PLAYWRIGHT_WORKER") {
        return Ok(PathBuf::from(explicit));
    }

    let cwd_candidate = env::current_dir()
        .context("failed to get cwd")?
        .join("workers/playwright-service.mjs");
    if cwd_candidate.exists() {
        return Ok(cwd_candidate);
    }

    let exe_candidate = env::current_exe()
        .context("failed to get current executable path")?
        .parent()
        .map(|p| p.join("../workers/playwright-service.mjs"))
        .ok_or_else(|| anyhow::anyhow!("failed to resolve executable parent"))?;
    if exe_candidate.exists() {
        return Ok(exe_candidate);
    }

    anyhow::bail!(
        "could not find playwright service script. set PINOKIO_PLAYWRIGHT_WORKER or run from project root"
    )
}

fn env_bool(name: &str, default_value: bool) -> bool {
    env::var(name)
        .ok()
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(default_value)
}

fn env_u64(name: &str, default_value: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_value)
}
