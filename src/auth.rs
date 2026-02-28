use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::AuthConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    pub provider: String,
    pub token: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub updated_at_unix: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub enabled: bool,
    pub required: bool,
    pub provider: String,
    pub authenticated: bool,
    pub user: Option<String>,
    pub session_path: String,
    pub message: String,
}

pub fn login(config: &AuthConfig) -> Result<AuthStatus> {
    if !config.enabled {
        return Ok(status(config, None, "auth is disabled"));
    }

    let provider = config.provider.to_lowercase();
    let session = match provider.as_str() {
        "none" => {
            return Ok(status(
                config,
                None,
                "provider=none, login is intentionally skipped",
            ))
        }
        "command" => login_via_command(config)?,
        other => anyhow::bail!(
            "unsupported auth provider '{}'. supported: none|command",
            other
        ),
    };

    save_session(config, &session)?;
    Ok(status(
        config,
        Some(&session),
        "login complete and session stored",
    ))
}

pub fn logout(config: &AuthConfig) -> Result<AuthStatus> {
    if let Some(command) = config.logout_command.as_deref() {
        let _ = Command::new("sh").arg("-c").arg(command).status();
    }

    let path = session_path(config)?;
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("failed to remove auth session {}", path.display()))?;
    }

    Ok(status(config, None, "logged out"))
}

pub fn ensure_task_auth(config: &AuthConfig) -> Result<()> {
    if !config.enabled || !config.required {
        return Ok(());
    }

    let session = load_session(config)?;
    if session.is_none() {
        anyhow::bail!(
            "auth is required but no session found. run `pinokio-agent login` or set {}",
            config.token_env
        );
    }

    Ok(())
}

pub fn auth_env_pairs(config: &AuthConfig) -> Vec<(String, String)> {
    match load_session(config) {
        Ok(Some(session)) => {
            let mut out = vec![(config.token_env.clone(), session.token)];
            if let Some(user) = session.user {
                out.push((config.user_env.clone(), user));
            }
            out
        }
        _ => Vec::new(),
    }
}

pub fn current_status(config: &AuthConfig) -> Result<AuthStatus> {
    let session = load_session(config)?;
    Ok(status(config, session.as_ref(), "auth status"))
}

fn login_via_command(config: &AuthConfig) -> Result<AuthSession> {
    let Some(command) = config.login_command.as_deref() else {
        anyhow::bail!("auth.provider=command requires auth.login_command");
    };

    let output = Command::new("sh")
        .arg("-c")
        .arg(command)
        .output()
        .with_context(|| format!("failed running auth login command: {}", command))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("auth login command failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        anyhow::bail!("auth login command returned empty output");
    }

    if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
        return session_from_json(value, &config.provider);
    }

    Ok(AuthSession {
        provider: config.provider.clone(),
        token: stdout,
        user: None,
        updated_at_unix: now_unix(),
    })
}

fn session_from_json(value: Value, provider: &str) -> Result<AuthSession> {
    let Some(obj) = value.as_object() else {
        anyhow::bail!("auth login json must be an object or plain token string");
    };

    let token = obj
        .get("token")
        .and_then(|v| v.as_str())
        .or_else(|| obj.get("access_token").and_then(|v| v.as_str()))
        .or_else(|| obj.get("accessToken").and_then(|v| v.as_str()))
        .or_else(|| obj.get("api_key").and_then(|v| v.as_str()))
        .or_else(|| obj.get("apiKey").and_then(|v| v.as_str()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "auth login json must include token/access_token/accessToken/api_key/apiKey"
            )
        })?;

    let user = obj
        .get("user")
        .and_then(|v| v.as_str())
        .or_else(|| obj.get("user_id").and_then(|v| v.as_str()))
        .map(|v| v.to_string());

    Ok(AuthSession {
        provider: provider.to_string(),
        token,
        user,
        updated_at_unix: now_unix(),
    })
}

fn load_session(config: &AuthConfig) -> Result<Option<AuthSession>> {
    if !config.enabled {
        return Ok(None);
    }

    if let Ok(token) = env::var(&config.token_env) {
        if !token.trim().is_empty() {
            let user = env::var(&config.user_env).ok();
            return Ok(Some(AuthSession {
                provider: "env".to_string(),
                token,
                user,
                updated_at_unix: now_unix(),
            }));
        }
    }

    let path = session_path(config)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed to read auth session {}", path.display()))?;
    let session: AuthSession = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse auth session {}", path.display()))?;
    if session.token.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(session))
}

fn save_session(config: &AuthConfig, session: &AuthSession) -> Result<()> {
    let path = session_path(config)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create auth dir {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).ok();
        }
    }

    let payload =
        serde_json::to_string_pretty(session).context("failed to serialize auth session")?;
    fs::write(&path, payload)
        .with_context(|| format!("failed to write auth session {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).ok();
    }

    Ok(())
}

fn session_path(config: &AuthConfig) -> Result<PathBuf> {
    expand_home(&config.session_file)
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

fn status(config: &AuthConfig, session: Option<&AuthSession>, message: &str) -> AuthStatus {
    AuthStatus {
        enabled: config.enabled,
        required: config.required,
        provider: config.provider.clone(),
        authenticated: session.is_some(),
        user: session.and_then(|s| s.user.clone()),
        session_path: config.session_file.clone(),
        message: message.to_string(),
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
