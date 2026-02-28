use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::config::{HookConfig, HookEventConfig};

#[derive(Debug, Clone, Copy)]
pub struct HookRunOptions {
    pub timeout_ms: u64,
    pub max_retries: u8,
    pub fail_open: bool,
}

impl Default for HookRunOptions {
    fn default() -> Self {
        Self {
            timeout_ms: 10_000,
            max_retries: 0,
            fail_open: false,
        }
    }
}

pub fn run_hooks_with_options<T: Serialize>(
    stage: &str,
    commands: &[String],
    context: &T,
    options: HookRunOptions,
) -> Result<()> {
    if commands.is_empty() {
        return Ok(());
    }

    let context_json =
        serde_json::to_string(context).context("failed to serialize hook context to json")?;

    for command in commands {
        let mut attempt: u8 = 0;
        loop {
            let result = run_single_hook(stage, command, &context_json, options.timeout_ms);
            match result {
                Ok(()) => break,
                Err(err) => {
                    if attempt < options.max_retries {
                        attempt += 1;
                        continue;
                    }
                    if options.fail_open {
                        eprintln!(
                            "hook failed but fail_open=true [stage={} command={}]: {}",
                            stage, command, err
                        );
                        break;
                    }
                    return Err(err);
                }
            }
        }
    }

    Ok(())
}

pub fn emit_hook_event<T: Serialize>(hooks: &HookConfig, event: &str, context: &T) -> Result<()> {
    for (_, _, pattern, cfg) in resolve_event_configs(hooks, event) {
        run_hooks_with_options(
            event,
            &cfg.commands,
            context,
            merge_hook_options(hooks, cfg),
        )
        .with_context(|| format!("event hook pattern '{}' failed", pattern))?;
    }

    Ok(())
}

fn merge_hook_options(base: &HookConfig, event_cfg: &HookEventConfig) -> HookRunOptions {
    HookRunOptions {
        timeout_ms: event_cfg.timeout_ms.unwrap_or(base.timeout_ms).max(100),
        max_retries: event_cfg.max_retries.unwrap_or(base.max_retries),
        fail_open: event_cfg.fail_open.unwrap_or(base.fail_open),
    }
}

fn resolve_event_configs<'a>(
    hooks: &'a HookConfig,
    event: &str,
) -> Vec<(u8, usize, &'a str, &'a HookEventConfig)> {
    let mut out = Vec::new();
    for (pattern, cfg) in &hooks.events {
        if pattern == "*" {
            out.push((0, 0, pattern.as_str(), cfg));
            continue;
        }

        if let Some(prefix) = pattern.strip_suffix('*') {
            if event.starts_with(prefix) {
                out.push((1, prefix.len(), pattern.as_str(), cfg));
            }
            continue;
        }

        if pattern == event {
            out.push((2, pattern.len(), pattern.as_str(), cfg));
        }
    }

    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out
}

fn run_single_hook(event: &str, command: &str, context_json: &str, timeout_ms: u64) -> Result<()> {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .env("PINOKIO_HOOK_EVENT", event)
        .env("PINOKIO_HOOK_CONTEXT_JSON", context_json)
        .spawn()
        .with_context(|| format!("failed to start hook command: {}", command))?;

    let timeout = Duration::from_millis(timeout_ms.max(100));
    let start = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("failed while waiting for hook command: {}", command))?
        {
            if !status.success() {
                anyhow::bail!("hook command failed [{}]: {}", event, command);
            }
            return Ok(());
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!(
                "hook command timed out after {}ms [{}]: {}",
                timeout.as_millis(),
                event,
                command
            );
        }

        thread::sleep(Duration::from_millis(25));
    }
}
