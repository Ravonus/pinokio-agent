use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::UiConfig;
use crate::model::{AgentResult, ExecutionKind, TaskRequest};

#[derive(Debug, Clone, Serialize, Default)]
pub struct UiPublishOutcome {
    pub published: Vec<PublishedPageMeta>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishedPageMeta {
    pub id: String,
    pub title: String,
    pub route: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PublishedPageRecord {
    id: String,
    title: String,
    route: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    source: PublishedPageSource,
    model: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PublishedPageSource {
    task_id: String,
    task_summary: String,
    agent_id: String,
    resource: String,
    action: String,
    execution: String,
    plugin: Option<String>,
    connection: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct IncomingUiPage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    route: Option<String>,
    model: Value,
}

pub fn publish_agent_pages(
    ui: &UiConfig,
    request: &TaskRequest,
    result: &mut AgentResult,
) -> UiPublishOutcome {
    let mut outcome = UiPublishOutcome::default();
    if !ui.auto_publish_agent_pages {
        return outcome;
    }

    let payloads = extract_page_payloads(&result.data);
    if payloads.is_empty() {
        return outcome;
    }

    let pages_dir = match resolve_pages_dir(&ui.pages_dir) {
        Ok(path) => path,
        Err(err) => {
            outcome.errors.push(format!(
                "failed to resolve ui.pages_dir '{}': {}",
                ui.pages_dir, err
            ));
            attach_publish_metadata(&mut result.data, &outcome);
            return outcome;
        }
    };

    if let Err(err) = fs::create_dir_all(&pages_dir) {
        outcome.errors.push(format!(
            "failed to create ui pages directory {}: {}",
            pages_dir.display(),
            err
        ));
        attach_publish_metadata(&mut result.data, &outcome);
        return outcome;
    }

    for (index, raw_payload) in payloads.iter().enumerate() {
        let page = match serde_json::from_value::<IncomingUiPage>(raw_payload.clone()) {
            Ok(value) => value,
            Err(err) => {
                outcome.errors.push(format!(
                    "invalid ui_page payload from agent {}: {}",
                    result.spec.id, err
                ));
                continue;
            }
        };

        let fallback_id = format!("{}-{}", result.spec.id, index + 1);
        let id = sanitize_page_id(page.id.as_deref().unwrap_or(&fallback_id));
        if id.is_empty() {
            outcome.errors.push(format!(
                "invalid ui_page id from agent {} (payload index {})",
                result.spec.id, index
            ));
            continue;
        }

        let mut model = page.model;
        let model_obj = match model.as_object_mut() {
            Some(obj) => obj,
            None => {
                outcome
                    .errors
                    .push(format!("ui_page '{}' model must be a JSON object", id));
                continue;
            }
        };

        let title = page
            .title
            .or_else(|| {
                model_obj
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|v| v.to_string())
            })
            .unwrap_or_else(|| format!("{} UI", result.spec.id));

        if !model_obj.contains_key("id") {
            model_obj.insert("id".to_string(), Value::String(id.clone()));
        }
        if !model_obj.contains_key("title") {
            model_obj.insert("title".to_string(), Value::String(title.clone()));
        }

        let model_size = match serde_json::to_vec(&model) {
            Ok(bytes) => bytes.len() as u64,
            Err(err) => {
                outcome.errors.push(format!(
                    "failed to serialize ui_page '{}' model: {}",
                    id, err
                ));
                continue;
            }
        };
        if model_size > ui.max_page_bytes {
            outcome.errors.push(format!(
                "ui_page '{}' exceeds max size ({} > {} bytes)",
                id, model_size, ui.max_page_bytes
            ));
            continue;
        }

        let route = page.route.unwrap_or_else(|| format!("/ui/apps/{}", id));
        let now = now_ms();
        let page_path = pages_dir.join(format!("{}.json", id));
        let created_at = read_existing_created_at(&page_path).unwrap_or(now);
        let record = PublishedPageRecord {
            id: id.clone(),
            title: title.clone(),
            route: route.clone(),
            created_at_ms: created_at,
            updated_at_ms: now,
            source: PublishedPageSource {
                task_id: request.id.clone(),
                task_summary: request.summary.clone(),
                agent_id: result.spec.id.clone(),
                resource: result.spec.resource.clone(),
                action: result.spec.action.as_str().to_string(),
                execution: execution_kind_label(result.spec.execution).to_string(),
                plugin: result.spec.plugin.clone(),
                connection: result.spec.connection.clone(),
            },
            model,
        };

        if let Err(err) = write_record(&page_path, &record) {
            outcome.errors.push(format!(
                "failed to write ui_page '{}' at {}: {}",
                id,
                page_path.display(),
                err
            ));
            continue;
        }

        outcome.published.push(PublishedPageMeta {
            id,
            title,
            route,
            updated_at_ms: now,
        });
    }

    attach_publish_metadata(&mut result.data, &outcome);
    outcome
}

fn extract_page_payloads(data: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(obj) = data.as_object() else {
        return out;
    };

    if let Some(one) = obj.get("ui_page") {
        out.push(one.clone());
    }
    if let Some(many) = obj.get("ui_pages").and_then(Value::as_array) {
        for item in many {
            out.push(item.clone());
        }
    }

    out
}

fn attach_publish_metadata(data: &mut Value, outcome: &UiPublishOutcome) {
    let meta = json!({
        "published": &outcome.published,
        "errors": &outcome.errors,
    });

    if let Some(obj) = data.as_object_mut() {
        obj.insert("ui_publish".to_string(), meta);
        return;
    }

    *data = json!({
        "result": data.clone(),
        "ui_publish": meta,
    });
}

fn resolve_pages_dir(raw: &str) -> Result<PathBuf> {
    if raw == "~" || raw.starts_with("~/") {
        let home = env::var("HOME").context("HOME is not set")?;
        if raw == "~" {
            return Ok(Path::new(&home).to_path_buf());
        }
        return Ok(Path::new(&home).join(raw.trim_start_matches("~/")));
    }
    Ok(PathBuf::from(raw))
}

fn read_existing_created_at(path: &Path) -> Option<u64> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: PublishedPageRecord = serde_json::from_str(&raw).ok()?;
    Some(parsed.created_at_ms)
}

fn write_record(path: &Path, record: &PublishedPageRecord) -> Result<()> {
    let raw = serde_json::to_string_pretty(record).context("failed to serialize page record")?;
    fs::write(path, raw).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn execution_kind_label(kind: ExecutionKind) -> &'static str {
    match kind {
        ExecutionKind::PlaywrightRead => "playwright_read",
        ExecutionKind::PluginCommand => "plugin_command",
        ExecutionKind::ConnectionCommand => "connection_command",
        ExecutionKind::Noop => "noop",
    }
}

fn sanitize_page_id(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_sep = false;

    for ch in raw.chars() {
        let mapped = ch.to_ascii_lowercase();
        if mapped.is_ascii_alphanumeric() {
            out.push(mapped);
            prev_sep = false;
            continue;
        }

        let is_sep =
            mapped == '-' || mapped == '_' || ch.is_whitespace() || matches!(ch, '.' | '/' | ':');
        if is_sep && !out.is_empty() && !prev_sep {
            out.push('-');
            prev_sep = true;
        }
    }

    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        let suffix = Uuid::new_v4()
            .as_simple()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();
        return format!("page-{}", suffix);
    }
    trimmed
}
