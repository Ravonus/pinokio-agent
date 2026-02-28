use std::env;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use serde_json::json;

use crate::config::MarketplaceConfig;
use crate::model::{TaskReport, TaskRequest};

pub fn track_task_event(
    config: &MarketplaceConfig,
    request: &TaskRequest,
    report: &TaskReport,
) -> Result<()> {
    if !config.enabled || !config.send_task_events {
        return Ok(());
    }

    let Some(endpoint) = config.endpoint.as_deref() else {
        return Ok(());
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .context("failed to build marketplace client")?;

    let mut req = client.post(endpoint).json(&json!({
        "source": config.source,
        "task": {
            "id": request.id,
            "summary": request.summary,
            "resource": request.resource,
            "action": request.action,
        },
        "agents": report.agents.len(),
    }));

    if let Some(key_env) = &config.api_key_env {
        if let Ok(key) = env::var(key_env) {
            if !key.trim().is_empty() {
                req = req.header("x-api-key", key);
            }
        }
    }

    let response = req.send().context("failed to send marketplace event")?;
    if !response.status().is_success() {
        anyhow::bail!(
            "marketplace event endpoint returned non-success status {}",
            response.status()
        );
    }

    Ok(())
}
