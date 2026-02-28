use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{AppConfig, CredentialConfig};
use crate::model::LlmCredentialRuntime;
use crate::oauth_cli::ensure_cli_available_for_provider;

#[derive(Debug, Clone, Serialize)]
pub struct CredentialStatus {
    pub name: String,
    pub provider: String,
    pub mode: String,
    pub configured: bool,
    pub token_present: bool,
    pub source: Option<String>,
    pub session_path: String,
    pub login_supported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CredentialSession {
    provider: String,
    token: String,
    #[serde(default)]
    user: Option<String>,
    updated_at_unix: u64,
}

pub fn resolve_runtime_credential(
    config: &AppConfig,
    credential_name: Option<&str>,
    require_token: bool,
    context_label: &str,
) -> Result<Option<LlmCredentialRuntime>> {
    let Some(name) = credential_name else {
        if require_token {
            anyhow::bail!(
                "{} requires a credential. configure one with `pinokio-agent configure ...`",
                context_label
            );
        }
        return Ok(None);
    };

    let cfg = config
        .credentials
        .get(name)
        .with_context(|| format!("credential not found: {}", name))?;
    let token = resolve_token_value(name, cfg)?;
    if require_token && token.is_none() {
        anyhow::bail!(
            "credential '{}' has no token yet. run `pinokio-agent configure login --credential {}` or set its env vars",
            name,
            name
        );
    }

    if let Some((token, source)) = token {
        return Ok(Some(LlmCredentialRuntime {
            name: name.to_string(),
            provider: cfg.provider.clone(),
            mode: cfg.mode.clone(),
            token,
            source,
            env: cfg.env.clone(),
        }));
    }

    Ok(None)
}

pub fn store_token_for_credential(
    config: &AppConfig,
    name: &str,
    token: &str,
    user: Option<String>,
) -> Result<CredentialStatus> {
    let cfg = config
        .credentials
        .get(name)
        .with_context(|| format!("credential not found: {}", name))?;
    if token.trim().is_empty() {
        anyhow::bail!("token cannot be empty");
    }

    let session = CredentialSession {
        provider: cfg.provider.clone(),
        token: token.trim().to_string(),
        user,
        updated_at_unix: now_unix(),
    };
    write_session(name, cfg, &session)?;
    status_for_credential(name, cfg)
}

pub fn login_credential(config: &AppConfig, name: &str) -> Result<CredentialStatus> {
    let cfg = config
        .credentials
        .get(name)
        .with_context(|| format!("credential not found: {}", name))?;
    let Some(command) = cfg.login_command.as_deref() else {
        anyhow::bail!(
            "credential '{}' has no login_command. set one with `configure claude-code --oauth-command ...` or `configure codex --oauth-command ...`",
            name
        );
    };
    ensure_cli_available_for_provider(&cfg.provider).with_context(|| {
        format!(
            "failed to ensure oauth cli for credential '{}' (provider='{}')",
            name, cfg.provider
        )
    })?;
    let output = Command::new("sh")
        .arg("-c")
        .arg(command)
        .output()
        .with_context(|| format!("failed running credential login command: {}", command))?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exit status {}", output.status)
        };
        anyhow::bail!("credential login command failed: {}", detail);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if cfg.mode == "oauth_cli" {
        return status_for_credential(name, cfg);
    }

    if stdout.is_empty() {
        anyhow::bail!("credential login command returned empty output");
    }

    let (token, user) = if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
        parse_token_json(&value)?
    } else {
        (stdout, None)
    };
    store_token_for_credential(config, name, &token, user)
}

pub fn statuses(config: &AppConfig) -> Result<Vec<CredentialStatus>> {
    let mut out = Vec::new();
    for (name, cfg) in &config.credentials {
        out.push(status_for_credential(name, cfg)?);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn status_for_credential(name: &str, cfg: &CredentialConfig) -> Result<CredentialStatus> {
    let token = resolve_token_value(name, cfg)?;
    let session_path = session_path(name, cfg)?;
    Ok(CredentialStatus {
        name: name.to_string(),
        provider: cfg.provider.clone(),
        mode: cfg.mode.clone(),
        configured: !cfg.provider.trim().is_empty(),
        token_present: token.is_some(),
        source: token.map(|(_, source)| source),
        session_path: session_path.display().to_string(),
        login_supported: cfg.login_command.is_some(),
    })
}

fn resolve_token_value(name: &str, cfg: &CredentialConfig) -> Result<Option<(String, String)>> {
    for env_name in &cfg.env {
        if let Ok(value) = env::var(env_name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(Some((trimmed.to_string(), format!("env:{}", env_name))));
            }
        }
    }

    if let Some(session) = read_session(name, cfg)? {
        if !session.token.trim().is_empty() {
            return Ok(Some((
                session.token,
                format!("session:{}", session_path(name, cfg)?.display()),
            )));
        }
    }

    Ok(None)
}

fn parse_token_json(value: &Value) -> Result<(String, Option<String>)> {
    let Some(obj) = value.as_object() else {
        anyhow::bail!("login JSON must be an object");
    };
    let token = obj
        .get("token")
        .and_then(Value::as_str)
        .or_else(|| obj.get("access_token").and_then(Value::as_str))
        .or_else(|| obj.get("accessToken").and_then(Value::as_str))
        .or_else(|| obj.get("api_key").and_then(Value::as_str))
        .or_else(|| obj.get("apiKey").and_then(Value::as_str))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("login JSON must include token/access_token/accessToken/api_key/apiKey")
        })?;

    let user = obj
        .get("user")
        .and_then(Value::as_str)
        .or_else(|| obj.get("user_id").and_then(Value::as_str))
        .map(|s| s.to_string());
    Ok((token, user))
}

fn read_session(name: &str, cfg: &CredentialConfig) -> Result<Option<CredentialSession>> {
    let path = session_path(name, cfg)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed reading credential session {}", path.display()))?;
    let session: CredentialSession = serde_json::from_str(&raw)
        .with_context(|| format!("failed parsing credential session {}", path.display()))?;
    Ok(Some(session))
}

fn write_session(name: &str, cfg: &CredentialConfig, session: &CredentialSession) -> Result<()> {
    let path = session_path(name, cfg)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed creating credential session directory {}",
                parent.display()
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).ok();
        }
    }

    let payload =
        serde_json::to_string_pretty(session).context("failed serializing credential session")?;
    fs::write(&path, payload)
        .with_context(|| format!("failed writing credential session {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).ok();
    }
    Ok(())
}

fn session_path(name: &str, cfg: &CredentialConfig) -> Result<PathBuf> {
    if let Some(path) = cfg.session_file.as_deref() {
        return expand_home(path);
    }
    expand_home(&format!("~/.pinokio-agent/credentials/{}.json", name))
}

fn expand_home(raw: &str) -> Result<PathBuf> {
    if raw == "~" || raw.starts_with("~/") {
        let home = env::var("HOME").context("HOME is not set")?;
        if raw == "~" {
            return Ok(Path::new(&home).to_path_buf());
        }
        return Ok(Path::new(&home).join(raw.trim_start_matches("~/")));
    }
    Ok(PathBuf::from(raw))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
