use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use anyhow::{Context, Result};

#[derive(Debug, Clone, Copy)]
struct SessionMount {
    host_relative_path: &'static str,
    container_path: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct OAuthCliToolSpec {
    provider_keys: &'static [&'static str],
    display_name: &'static str,
    binary_name: &'static str,
    fallback_paths: &'static [&'static str],
    install_unix_shell: &'static str,
    child_install_unix_shell: &'static str,
    install_windows_ps: &'static str,
    install_hint: &'static str,
    session_mounts: &'static [SessionMount],
}

const CODEX_SESSION_MOUNTS: &[SessionMount] = &[SessionMount {
    host_relative_path: ".codex",
    container_path: "/root/.codex",
}];

const CLAUDE_SESSION_MOUNTS: &[SessionMount] = &[
    SessionMount {
        host_relative_path: ".claude",
        container_path: "/root/.claude",
    },
    SessionMount {
        host_relative_path: ".claude.json",
        container_path: "/root/.claude.json",
    },
];

const CODEX_SPEC: OAuthCliToolSpec = OAuthCliToolSpec {
    provider_keys: &["openai_codex", "codex"],
    display_name: "Codex",
    binary_name: "codex",
    fallback_paths: &[
        "/Applications/Codex.app/Contents/Resources/codex",
        "~/.local/bin/codex",
        "~/.npm-global/bin/codex",
        "~/bin/codex",
    ],
    install_unix_shell: "if ! command -v npm >/dev/null 2>&1; then echo 'npm is required to install Codex CLI' >&2; exit 1; fi; NPM_CONFIG_FETCH_RETRIES=1 NPM_CONFIG_FETCH_TIMEOUT=15000 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=5000 npm install -g --no-audit --no-fund --silent @openai/codex@latest",
    child_install_unix_shell: "if ! command -v npm >/dev/null 2>&1; then echo 'npm is required to install Codex CLI' >&2; exit 1; fi; mkdir -p \"$PINOKIO_CHILD_HOME/.npm-global\"; HOME=\"$PINOKIO_CHILD_HOME\" NPM_CONFIG_PREFIX=\"$PINOKIO_CHILD_HOME/.npm-global\" NPM_CONFIG_FETCH_RETRIES=1 NPM_CONFIG_FETCH_TIMEOUT=15000 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=5000 npm install -g --no-audit --no-fund --silent @openai/codex@latest",
    install_windows_ps: "npm install -g @openai/codex@latest",
    install_hint: "npm install -g @openai/codex@latest",
    session_mounts: CODEX_SESSION_MOUNTS,
};

const CLAUDE_SPEC: OAuthCliToolSpec = OAuthCliToolSpec {
    provider_keys: &["claude_code", "claude"],
    display_name: "Claude Code",
    binary_name: "claude",
    fallback_paths: &["~/.local/bin/claude", "~/.npm-global/bin/claude", "~/bin/claude"],
    install_unix_shell: "tmp_script=\"$(mktemp)\"; node -e 'const fs=require(\"fs\"); const https=require(\"https\"); const out=fs.createWriteStream(process.argv[1]); https.get(\"https://claude.ai/install.sh\", (res)=>{ if (res.statusCode !== 200) { console.error(`failed to download claude installer: ${res.statusCode}`); process.exit(1); } res.pipe(out); res.on(\"end\", ()=>out.end()); }).on(\"error\", (err)=>{ console.error(err.message); process.exit(1); });' \"$tmp_script\"; code=$?; if [ $code -ne 0 ]; then rm -f \"$tmp_script\"; exit $code; fi; sh \"$tmp_script\"; code=$?; rm -f \"$tmp_script\"; exit $code",
    child_install_unix_shell: "mkdir -p \"$PINOKIO_CHILD_HOME/.local/bin\"; tmp_script=\"$(mktemp)\"; node -e 'const fs=require(\"fs\"); const https=require(\"https\"); const out=fs.createWriteStream(process.argv[1]); https.get(\"https://claude.ai/install.sh\", (res)=>{ if (res.statusCode !== 200) { console.error(`failed to download claude installer: ${res.statusCode}`); process.exit(1); } res.pipe(out); res.on(\"end\", ()=>out.end()); }).on(\"error\", (err)=>{ console.error(err.message); process.exit(1); });' \"$tmp_script\"; code=$?; if [ $code -ne 0 ]; then rm -f \"$tmp_script\"; exit $code; fi; HOME=\"$PINOKIO_CHILD_HOME\" sh \"$tmp_script\"; code=$?; rm -f \"$tmp_script\"; exit $code",
    install_windows_ps: "irm https://claude.ai/install.ps1 | iex",
    install_hint: "curl -fsSL https://claude.ai/install.sh | bash",
    session_mounts: CLAUDE_SESSION_MOUNTS,
};

const ALL_OAUTH_CLI_SPECS: &[OAuthCliToolSpec] = &[CODEX_SPEC, CLAUDE_SPEC];
const PINOKIO_CHILD_HOME_DEFAULT: &str = "/var/lib/pinokio-oauth";

pub fn codex_command_layer_command() -> String {
    let run_body = "tmp=\"$(mktemp)\"; trap 'rm -f \"$tmp\"' EXIT; \"$PINOKIO_OAUTH_BIN\" --ask-for-approval never exec --ephemeral --skip-git-repo-check --output-last-message \"$tmp\" \"$PINOKIO_PROMPT\" >/dev/null; code=$?; if [ $code -ne 0 ]; then exit $code; fi; if [ ! -s \"$tmp\" ]; then echo 'Codex CLI returned empty output' >&2; exit 1; fi; cat \"$tmp\"";
    build_command_layer_wrapper(&CODEX_SPEC, run_body)
}

pub fn claude_code_command_layer_command() -> String {
    let run_body = "\"$PINOKIO_OAUTH_BIN\" --print \"$PINOKIO_PROMPT\"";
    build_command_layer_wrapper(&CLAUDE_SPEC, run_body)
}

pub fn ensure_cli_available_for_provider(provider: &str) -> Result<()> {
    let Some(spec) = spec_for_provider(provider) else {
        return Ok(());
    };

    if resolve_binary_path(spec)?.is_some() {
        return Ok(());
    }

    run_install(spec)?;

    if resolve_binary_path(spec)?.is_none() {
        anyhow::bail!(
            "{} CLI was not found after install. install manually with: {}",
            spec.display_name,
            spec.install_hint
        );
    }

    Ok(())
}

pub fn container_session_mounts() -> Vec<String> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };

    let mut mounts = BTreeSet::new();
    for spec in ALL_OAUTH_CLI_SPECS {
        for mapping in spec.session_mounts {
            let host_path = home.join(mapping.host_relative_path);
            if !host_path.exists() {
                continue;
            }
            mounts.insert(format!(
                "{}:{}",
                host_path.display(),
                mapping.container_path
            ));
        }
    }
    mounts.into_iter().collect()
}

pub fn container_oauth_runtime_mount() -> Option<String> {
    let home = home_dir()?;
    let host_root = home.join(".pinokio-agent").join("oauth-runtime");
    if fs::create_dir_all(&host_root).is_err() {
        return None;
    }
    Some(format!(
        "{}:{}",
        host_root.display(),
        PINOKIO_CHILD_HOME_DEFAULT
    ))
}

fn build_command_layer_wrapper(spec: &OAuthCliToolSpec, run_body: &str) -> String {
    let detect_expr = build_detect_expr(spec);
    let install_windows = shell_single_quote(spec.install_windows_ps);
    let install_unix = wrap_install_with_timeout(
        spec.install_unix_shell,
        &format!("{} CLI install timed out", spec.display_name),
    );
    let child_install_unix = wrap_install_with_timeout(
        spec.child_install_unix_shell,
        &format!(
            "{} CLI install timed out in container child runtime",
            spec.display_name
        ),
    );
    let not_found = shell_single_quote(&format!(
        "{} CLI not found. install manually with: {}",
        spec.display_name, spec.install_hint
    ));
    let child_mode_missing = shell_single_quote(&format!(
        "{} CLI install in container child runtime failed. This container must be able to install {} automatically or ship it preinstalled in the image.",
        spec.display_name, spec.binary_name
    ));

    format!(
        "PINOKIO_OAUTH_BIN=\"\"; \
PINOKIO_CHILD_HOME=\"${{PINOKIO_CHILD_HOME:-/var/lib/pinokio-oauth}}\"; \
if [ \"${{PINOKIO_CHILD_MODE:-}}\" = \"1\" ]; then PATH=\"$PINOKIO_CHILD_HOME/.npm-global/bin:$PINOKIO_CHILD_HOME/.local/bin:$PATH\"; fi; \
{detect_expr}; \
if [ -z \"$PINOKIO_OAUTH_BIN\" ]; then \
  if [ \"${{PINOKIO_CHILD_MODE:-}}\" = \"1\" ]; then \
    mkdir -p \"$PINOKIO_CHILD_HOME\"; \
    {child_install_unix}; \
  else \
    PINOKIO_OAUTH_OS=\"$(uname -s 2>/dev/null || echo unknown)\"; \
    case \"$PINOKIO_OAUTH_OS\" in \
      Darwin|Linux) {install_unix} ;; \
      MINGW*|MSYS*|CYGWIN*|Windows_NT) powershell.exe -NoProfile -ExecutionPolicy Bypass -Command {install_windows} ;; \
      *) {install_unix} ;; \
    esac; \
  fi; \
  {detect_expr}; \
fi; \
if [ -z \"$PINOKIO_OAUTH_BIN\" ]; then if [ \"${{PINOKIO_CHILD_MODE:-}}\" = \"1\" ]; then echo {child_mode_missing} >&2; else echo {not_found} >&2; fi; exit 1; fi; \
{run_body}",
        detect_expr = detect_expr,
        child_install_unix = child_install_unix,
        child_mode_missing = child_mode_missing,
        install_unix = install_unix,
        install_windows = install_windows,
        not_found = not_found,
        run_body = run_body
    )
}

fn build_detect_expr(spec: &OAuthCliToolSpec) -> String {
    let mut script = format!(
        "PINOKIO_OAUTH_BIN=\"$(command -v {} 2>/dev/null || true)\"",
        spec.binary_name
    );

    for fallback in spec.fallback_paths {
        if let Some(stripped) = fallback.strip_prefix("~/") {
            script.push_str(&format!(
                "; if [ -z \"$PINOKIO_OAUTH_BIN\" ] && [ -x \"$HOME/{path}\" ]; then PINOKIO_OAUTH_BIN=\"$HOME/{path}\"; fi",
                path = stripped
            ));
        } else {
            script.push_str(&format!(
                "; if [ -z \"$PINOKIO_OAUTH_BIN\" ] && [ -x \"{path}\" ]; then PINOKIO_OAUTH_BIN=\"{path}\"; fi",
                path = fallback
            ));
        }
    }

    script
}

fn spec_for_provider(provider: &str) -> Option<&'static OAuthCliToolSpec> {
    let normalized = provider.trim().to_ascii_lowercase();
    ALL_OAUTH_CLI_SPECS.iter().find(|spec| {
        spec.provider_keys.iter().any(|key| {
            let key = *key;
            normalized == key
                || normalized.starts_with(&format!("{}_", key))
                || normalized.ends_with(&format!("_{}", key))
        })
    })
}

fn run_install(spec: &OAuthCliToolSpec) -> Result<()> {
    let status = if cfg!(target_os = "windows") {
        Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(spec.install_windows_ps)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .with_context(|| format!("failed to start {} installer", spec.display_name))?
    } else {
        Command::new("sh")
            .args(["-lc", spec.install_unix_shell])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .with_context(|| format!("failed to start {} installer", spec.display_name))?
    };

    if !status.success() {
        anyhow::bail!(
            "{} installer failed with status {}",
            spec.display_name,
            status
        );
    }
    Ok(())
}

fn resolve_binary_path(spec: &OAuthCliToolSpec) -> Result<Option<PathBuf>> {
    if let Some(path) = lookup_path_command(spec.binary_name)? {
        return Ok(Some(path));
    }

    for fallback in spec.fallback_paths {
        if let Some(candidate) = expand_home(fallback) {
            if candidate.exists() {
                return Ok(Some(candidate));
            }
        }
    }

    Ok(None)
}

fn lookup_path_command(name: &str) -> Result<Option<PathBuf>> {
    if cfg!(target_os = "windows") {
        let output = Command::new("where")
            .arg(name)
            .output()
            .with_context(|| format!("failed running `where {}`", name))?;
        if !output.status.success() {
            return Ok(None);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = first_non_empty_line(&stdout);
        return Ok(line.map(PathBuf::from));
    }

    let output = Command::new("sh")
        .args(["-lc", &format!("command -v {}", name)])
        .output()
        .with_context(|| format!("failed running `command -v {}`", name))?;
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(first_non_empty_line(&stdout).map(PathBuf::from))
}

fn first_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut out = PathBuf::from(drive);
            out.push(path);
            Some(out)
        })
}

fn expand_home(raw: &str) -> Option<PathBuf> {
    if raw == "~" || raw.starts_with("~/") {
        let home = home_dir()?;
        if raw == "~" {
            return Some(home);
        }
        return Some(home.join(raw.trim_start_matches("~/")));
    }
    Some(PathBuf::from(raw))
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn wrap_install_with_timeout(shell_script: &str, timeout_message: &str) -> String {
    let quoted_script = shell_single_quote(shell_script);
    let quoted_timeout_message = shell_single_quote(timeout_message);
    format!(
        "PINOKIO_INSTALL_TIMEOUT_SECS=\"${{PINOKIO_OAUTH_INSTALL_TIMEOUT_SECS:-180}}\"; \
if command -v timeout >/dev/null 2>&1; then \
  timeout \"${{PINOKIO_INSTALL_TIMEOUT_SECS}}s\" sh -lc {quoted_script}; \
  code=$?; \
  if [ $code -eq 124 ]; then echo {quoted_timeout_message} >&2; fi; \
  if [ $code -ne 0 ]; then exit $code; fi; \
else \
  sh -lc {quoted_script}; \
fi",
        quoted_script = quoted_script,
        quoted_timeout_message = quoted_timeout_message
    )
}

#[cfg(test)]
mod tests {
    use super::{claude_code_command_layer_command, codex_command_layer_command};

    #[test]
    fn codex_command_wrapper_contains_auto_install_and_exec() {
        let command = codex_command_layer_command();
        assert!(command.contains("@openai/codex@latest"));
        assert!(command.contains("--ask-for-approval never exec --ephemeral --skip-git-repo-check"));
        assert!(command.contains("PINOKIO_OAUTH_BIN"));
    }

    #[test]
    fn claude_command_wrapper_contains_auto_install_and_print() {
        let command = claude_code_command_layer_command();
        assert!(command.contains("claude.ai/install.sh"));
        assert!(command.contains("--print \"$PINOKIO_PROMPT\""));
        assert!(command.contains("PINOKIO_OAUTH_BIN"));
    }
}
