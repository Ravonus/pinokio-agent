use std::{
    collections::HashSet,
    env,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use serde_json::{json, Value};

use crate::{
    config::AppConfig,
    credentials::resolve_runtime_credential,
    model::{ApiLayerKind, ApiLayerRuntime, LlmRuntimeProfile},
};

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Clone)]
pub struct LlmCompletion {
    pub text: String,
    pub provider: String,
    pub model: String,
}

pub fn resolve_profile(config: &AppConfig, profile_name: &str) -> Result<LlmRuntimeProfile> {
    let profile = config
        .llm_profiles
        .get(profile_name)
        .with_context(|| format!("llm profile not found: {}", profile_name))?;
    let layer = config.api_layers.get(&profile.api_layer).with_context(|| {
        format!(
            "api layer not found for profile {}: {}",
            profile_name, profile.api_layer
        )
    })?;

    let layer_kind = parse_layer_kind(&layer.kind)?;
    let credential_name = profile
        .credential
        .as_deref()
        .or(layer.credential.as_deref());
    let require_token = !matches!(layer_kind, ApiLayerKind::Command) || credential_name.is_some();
    let credential = resolve_runtime_credential(
        config,
        credential_name,
        require_token,
        &format!("llm profile {}", profile_name),
    )?;

    Ok(LlmRuntimeProfile {
        name: profile_name.to_string(),
        provider: profile.provider.clone(),
        model: profile.model.clone(),
        max_tokens: profile.max_tokens,
        temperature: profile.temperature,
        fallback: profile.fallback.clone(),
        system_prompt: profile.system_prompt.clone(),
        layer: ApiLayerRuntime {
            kind: layer_kind,
            base_url: layer.base_url.clone(),
            credential,
            command: layer.command.clone(),
            headers: layer.headers.clone(),
        },
    })
}

pub fn complete(config: &AppConfig, profile_name: &str, prompt: &str) -> Result<LlmCompletion> {
    complete_with_fallback(config, profile_name, prompt, &mut HashSet::new())
}

pub fn complete_runtime(profile: &LlmRuntimeProfile, prompt: &str) -> Result<LlmCompletion> {
    match profile.layer.kind {
        ApiLayerKind::OpenaiCompatible => complete_openai_compatible(profile, prompt),
        ApiLayerKind::AnthropicMessages => complete_anthropic(profile, prompt),
        ApiLayerKind::Command => complete_with_command(profile, prompt),
    }
}

fn complete_with_fallback(
    config: &AppConfig,
    profile_name: &str,
    prompt: &str,
    seen: &mut HashSet<String>,
) -> Result<LlmCompletion> {
    if !seen.insert(profile_name.to_string()) {
        anyhow::bail!("llm fallback cycle detected at profile {}", profile_name);
    }

    let profile = resolve_profile(config, profile_name)?;
    match complete_runtime(&profile, prompt) {
        Ok(result) => Ok(result),
        Err(err) => {
            if let Some(fallback) = &profile.fallback {
                complete_with_fallback(config, fallback, prompt, seen)
                    .with_context(|| format!("primary profile {} failed: {}", profile_name, err))
            } else {
                Err(err)
                    .with_context(|| format!("llm completion failed for profile {}", profile_name))
            }
        }
    }
}

fn complete_openai_compatible(profile: &LlmRuntimeProfile, prompt: &str) -> Result<LlmCompletion> {
    let api_base = profile
        .layer
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com")
        .trim_end_matches('/');
    let endpoint = format!("{}/v1/chat/completions", api_base);
    let key = load_api_key(profile)?;

    let mut body = json!({
        "model": profile.model,
        "messages": [
            {"role": "system", "content": profile.system_prompt.clone().unwrap_or_else(default_system_prompt)},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": profile.max_tokens,
        "temperature": profile.temperature
    });
    if profile.system_prompt.is_none() {
        body["messages"] = json!([
            {"role": "user", "content": prompt}
        ]);
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .context("failed to create http client")?;
    let mut req = client.post(endpoint).bearer_auth(key).json(&body);
    for (k, v) in &profile.layer.headers {
        req = req.header(k, v);
    }

    let res = req.send().context("openai-compatible request failed")?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().unwrap_or_else(|_| "".to_string());
        anyhow::bail!("openai-compatible request failed [{}]: {}", status, body);
    }

    let json: Value = res
        .json()
        .context("invalid openai-compatible response json")?;
    let text = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        anyhow::bail!("openai-compatible response was missing choices[0].message.content");
    }

    Ok(LlmCompletion {
        text,
        provider: profile.provider.clone(),
        model: profile.model.clone(),
    })
}

fn complete_anthropic(profile: &LlmRuntimeProfile, prompt: &str) -> Result<LlmCompletion> {
    let api_base = profile
        .layer
        .base_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com")
        .trim_end_matches('/');
    let endpoint = format!("{}/v1/messages", api_base);
    let key = load_api_key(profile)?;

    let mut body = json!({
        "model": profile.model,
        "max_tokens": profile.max_tokens,
        "messages": [
            {"role": "user", "content": prompt}
        ]
    });
    if let Some(system_prompt) = &profile.system_prompt {
        body["system"] = Value::String(system_prompt.clone());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .context("failed to create http client")?;
    let mut req = client
        .post(endpoint)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    for (k, v) in &profile.layer.headers {
        req = req.header(k, v);
    }

    let res = req.send().context("anthropic request failed")?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().unwrap_or_else(|_| "".to_string());
        anyhow::bail!("anthropic request failed [{}]: {}", status, body);
    }

    let json: Value = res.json().context("invalid anthropic response json")?;
    let text = json
        .get("content")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        anyhow::bail!("anthropic response was missing content[0].text");
    }

    Ok(LlmCompletion {
        text,
        provider: profile.provider.clone(),
        model: profile.model.clone(),
    })
}

fn complete_with_command(profile: &LlmRuntimeProfile, prompt: &str) -> Result<LlmCompletion> {
    let Some(command) = &profile.layer.command else {
        anyhow::bail!("command api layer requires layer.command");
    };

    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .env("PINOKIO_PROMPT", prompt)
        .env(
            "PINOKIO_SYSTEM_PROMPT",
            profile
                .system_prompt
                .clone()
                .unwrap_or_else(default_system_prompt),
        )
        .env("PINOKIO_MODEL", &profile.model);

    if let Some(credential) = &profile.layer.credential {
        cmd.env("PINOKIO_CREDENTIAL_NAME", &credential.name)
            .env("PINOKIO_CREDENTIAL_TOKEN", &credential.token)
            .env("PINOKIO_CREDENTIAL_PROVIDER", &credential.provider)
            .env("PINOKIO_CREDENTIAL_MODE", &credential.mode);
        for env_name in &credential.env {
            cmd.env(env_name, &credential.token);
        }
    }

    let output = run_command_with_timeout(cmd, resolve_command_timeout())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("command api layer failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let text = if let Ok(parsed) = serde_json::from_str::<Value>(&stdout) {
        parsed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or(&stdout)
            .trim()
            .to_string()
    } else {
        stdout.trim().to_string()
    };

    if text.is_empty() {
        anyhow::bail!("command api layer returned empty output");
    };

    Ok(LlmCompletion {
        text,
        provider: profile.provider.clone(),
        model: profile.model.clone(),
    })
}

fn parse_layer_kind(value: &str) -> Result<ApiLayerKind> {
    match value {
        "openai_compatible" => Ok(ApiLayerKind::OpenaiCompatible),
        "anthropic_messages" => Ok(ApiLayerKind::AnthropicMessages),
        "command" => Ok(ApiLayerKind::Command),
        other => anyhow::bail!("unsupported api layer kind: {}", other),
    }
}

fn load_api_key(profile: &LlmRuntimeProfile) -> Result<String> {
    let credential = profile
        .layer
        .credential
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("credential missing for profile {}", profile.name))?;
    if credential.token.trim().is_empty() {
        anyhow::bail!("credential '{}' has an empty token", credential.name);
    }
    Ok(credential.token.clone())
}

fn default_system_prompt() -> String {
    "You are a secure orchestration agent. Keep output concise and actionable. Always check installed plugins and systems before claiming a capability is unavailable.".to_string()
}

fn run_command_with_timeout(mut cmd: Command, timeout: Duration) -> Result<std::process::Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().context("failed to execute command api layer")?;
    let started = Instant::now();

    loop {
        if child
            .try_wait()
            .context("failed checking command api layer status")?
            .is_some()
        {
            return child
                .wait_with_output()
                .context("failed collecting command api layer output");
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("command api layer timed out after {:?}", timeout);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn resolve_command_timeout() -> Duration {
    let parsed = env::var("PINOKIO_LLM_COMMAND_TIMEOUT_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0);
    Duration::from_secs(parsed.unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECS))
}
