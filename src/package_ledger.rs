use std::collections::{BTreeSet, HashSet};
use std::process::Command;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{AppConfig, OrchestratorServiceConfig};
use crate::model::{AgentResult, TaskReport, TaskRequest};

const SCHEMA_SQL: &str = r#"
CREATE SCHEMA IF NOT EXISTS pinokio_package_ledger;

CREATE TABLE IF NOT EXISTS pinokio_package_ledger.scope_state (
  scope_key TEXT PRIMARY KEY,
  scope_dir TEXT NOT NULL,
  resource TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  manager TEXT NOT NULL,
  packages TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS pinokio_package_ledger.events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_id TEXT NOT NULL,
  task_summary TEXT NOT NULL,
  action TEXT NOT NULL,
  manager TEXT NOT NULL,
  packages TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  scope_key TEXT NOT NULL,
  scope_dir TEXT NOT NULL,
  resource TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT true,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS pka_pkg_events_scope_created_idx
  ON pinokio_package_ledger.events (scope_key, created_at DESC);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageLedgerScopeRecord {
    pub scope_key: String,
    pub scope_dir: String,
    pub resource: String,
    pub agent_id: String,
    pub manager: String,
    pub packages: Vec<String>,
    pub updated_at: String,
    pub last_action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageLedgerEventRecord {
    pub id: i64,
    pub created_at: String,
    pub task_id: String,
    pub task_summary: String,
    pub action: String,
    pub manager: String,
    pub packages: Vec<String>,
    pub scope_key: String,
    pub scope_dir: String,
    pub resource: String,
    pub agent_id: String,
    pub applied: bool,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PackageLedgerWriteSummary {
    pub ok: bool,
    pub events_seen: usize,
    pub events_applied: usize,
    pub db_container: String,
    pub database: String,
    pub user: String,
}

#[derive(Debug, Clone)]
struct PackageLedgerConnection {
    container: String,
    database: String,
    user: String,
    password: String,
}

#[derive(Debug, Clone)]
struct PackageLedgerMutation {
    task_id: String,
    task_summary: String,
    action: String,
    manager: String,
    packages: Vec<String>,
    scope_key: String,
    scope_dir: String,
    resource: String,
    agent_id: String,
    applied: bool,
    details: Value,
}

pub fn record_task_report(
    config: &AppConfig,
    request: &TaskRequest,
    report: &TaskReport,
) -> Result<Option<PackageLedgerWriteSummary>> {
    let connection = match resolve_connection(config) {
        Some(value) => value,
        None => return Ok(None),
    };

    let mut events = collect_package_events(request, report);
    if events.is_empty() {
        return Ok(None);
    }
    dedupe_events(&mut events);

    ensure_schema(&connection)?;

    let mut applied_count = 0usize;
    for event in &events {
        insert_event(&connection, event)?;
        if event.applied {
            apply_scope_state(&connection, event)?;
            applied_count += 1;
        }
    }

    Ok(Some(PackageLedgerWriteSummary {
        ok: true,
        events_seen: events.len(),
        events_applied: applied_count,
        db_container: connection.container,
        database: connection.database,
        user: connection.user,
    }))
}

pub fn list_scopes(config: &AppConfig, limit: usize) -> Result<Vec<PackageLedgerScopeRecord>> {
    let connection = resolve_connection(config)
        .ok_or_else(|| anyhow::anyhow!("postgres service is not configured for package ledger"))?;
    ensure_schema(&connection)?;

    let sql = format!(
        "SELECT COALESCE(json_agg(row_to_json(t))::text, '[]') FROM (
          SELECT
            scope_key,
            scope_dir,
            resource,
            agent_id,
            manager,
            packages,
            to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS updated_at,
            last_action
          FROM pinokio_package_ledger.scope_state
          ORDER BY updated_at DESC
          LIMIT {}
        ) t;",
        limit.clamp(1, 5000)
    );
    let value = run_json_query(&connection, &sql)?;
    parse_records::<PackageLedgerScopeRecord>(value)
}

pub fn list_events(
    config: &AppConfig,
    scope_key: Option<&str>,
    limit: usize,
) -> Result<Vec<PackageLedgerEventRecord>> {
    let connection = resolve_connection(config)
        .ok_or_else(|| anyhow::anyhow!("postgres service is not configured for package ledger"))?;
    ensure_schema(&connection)?;

    let where_clause = match scope_key {
        Some(value) if !value.trim().is_empty() => {
            format!("WHERE scope_key = {}", sql_quote(value.trim()))
        }
        _ => String::new(),
    };

    let sql = format!(
        "SELECT COALESCE(json_agg(row_to_json(t))::text, '[]') FROM (
          SELECT
            id,
            to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS created_at,
            task_id,
            task_summary,
            action,
            manager,
            packages,
            scope_key,
            scope_dir,
            resource,
            agent_id,
            applied,
            details
          FROM pinokio_package_ledger.events
          {where_clause}
          ORDER BY created_at DESC
          LIMIT {limit}
        ) t;",
        where_clause = where_clause,
        limit = limit.clamp(1, 10000)
    );
    let value = run_json_query(&connection, &sql)?;
    parse_records::<PackageLedgerEventRecord>(value)
}

fn parse_records<T>(value: Value) -> Result<Vec<T>>
where
    T: for<'de> Deserialize<'de>,
{
    match value {
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                let parsed: T = serde_json::from_value(item).context("invalid package ledger row")?;
                out.push(parsed);
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

fn collect_package_events(request: &TaskRequest, report: &TaskReport) -> Vec<PackageLedgerMutation> {
    let mut out = Vec::new();
    collect_events_from_report(&request.id, &request.summary, report, &mut out, 0);
    out
}

fn collect_events_from_report(
    task_id: &str,
    task_summary: &str,
    report: &TaskReport,
    out: &mut Vec<PackageLedgerMutation>,
    depth: usize,
) {
    if depth > 24 {
        return;
    }

    for agent in &report.agents {
        collect_event_from_agent(task_id, task_summary, agent, out);
        collect_nested_events_from_value(task_id, task_summary, &agent.data, out, depth + 1);
    }
}

fn collect_nested_events_from_value(
    task_id: &str,
    task_summary: &str,
    value: &Value,
    out: &mut Vec<PackageLedgerMutation>,
    depth: usize,
) {
    if depth > 24 {
        return;
    }

    match value {
        Value::Object(map) => {
            if let Some(report_value) = map.get("report") {
                if let Ok(nested_report) = serde_json::from_value::<TaskReport>(report_value.clone()) {
                    collect_events_from_report(task_id, task_summary, &nested_report, out, depth + 1);
                }
            }
            for nested in map.values() {
                collect_nested_events_from_value(task_id, task_summary, nested, out, depth + 1);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_nested_events_from_value(task_id, task_summary, item, out, depth + 1);
            }
        }
        _ => {}
    }
}

fn collect_event_from_agent(
    task_id: &str,
    task_summary: &str,
    agent: &AgentResult,
    out: &mut Vec<PackageLedgerMutation>,
) {
    let plugin = agent
        .data
        .get("plugin")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if plugin != "explorer_write_agent" {
        return;
    }
    let Some(result) = agent.data.get("result").and_then(Value::as_object) else {
        return;
    };

    let operation = result
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let action = match operation {
        "ensure_packages" | "restore_packages" => "install",
        "remove_packages" => "remove",
        _ => return,
    };

    let packages = parse_string_array(result.get("packages"));
    if packages.is_empty() {
        return;
    }

    let scope_dir = agent
        .data
        .get("scope_dir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    if scope_dir.is_empty() {
        return;
    }

    let manager = result
        .get("manager")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let applied = result.get("applied").and_then(Value::as_bool).unwrap_or(true);
    let scope_key = result
        .get("ledger")
        .and_then(Value::as_object)
        .and_then(|ledger| ledger.get("scope_key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("{}::{}::{}", agent.spec.resource, agent.spec.id, scope_dir));

    out.push(PackageLedgerMutation {
        task_id: task_id.to_string(),
        task_summary: task_summary.to_string(),
        action: action.to_string(),
        manager,
        packages,
        scope_key,
        scope_dir,
        resource: agent.spec.resource.clone(),
        agent_id: agent.spec.id.clone(),
        applied,
        details: json!({
            "operation": operation,
            "task_agent_summary": agent.summary,
        }),
    });
}

fn dedupe_events(events: &mut Vec<PackageLedgerMutation>) {
    let mut seen = HashSet::new();
    events.retain(|event| {
        let package_key = event.packages.join(",");
        let key = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            event.task_id,
            event.action,
            event.scope_key,
            event.manager,
            event.resource,
            event.agent_id,
            package_key
        );
        seen.insert(key)
    });
}

fn parse_string_array(value: Option<&Value>) -> Vec<String> {
    let mut out = BTreeSet::new();
    let Some(Value::Array(values)) = value else {
        return Vec::new();
    };
    for value in values {
        if let Some(raw) = value.as_str() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            out.insert(trimmed.to_string());
        }
    }
    out.into_iter().collect()
}

fn ensure_schema(connection: &PackageLedgerConnection) -> Result<()> {
    let _ = run_sql(connection, SCHEMA_SQL)?;
    Ok(())
}

fn apply_scope_state(connection: &PackageLedgerConnection, event: &PackageLedgerMutation) -> Result<()> {
    let current_packages = load_scope_packages(connection, &event.scope_key)?;
    let mut package_set = BTreeSet::new();
    for package in current_packages {
        package_set.insert(package);
    }

    if event.action.eq_ignore_ascii_case("remove") {
        for package in &event.packages {
            package_set.remove(package);
        }
    } else {
        for package in &event.packages {
            package_set.insert(package.clone());
        }
    }

    let packages: Vec<String> = package_set.into_iter().collect();
    let sql = format!(
        "INSERT INTO pinokio_package_ledger.scope_state (
          scope_key,
          scope_dir,
          resource,
          agent_id,
          manager,
          packages,
          updated_at,
          last_action,
          metadata
        ) VALUES (
          {scope_key},
          {scope_dir},
          {resource},
          {agent_id},
          {manager},
          {packages},
          now(),
          {last_action},
          {metadata}
        )
        ON CONFLICT (scope_key) DO UPDATE SET
          scope_dir = EXCLUDED.scope_dir,
          resource = EXCLUDED.resource,
          agent_id = EXCLUDED.agent_id,
          manager = EXCLUDED.manager,
          packages = EXCLUDED.packages,
          updated_at = now(),
          last_action = EXCLUDED.last_action,
          metadata = EXCLUDED.metadata;",
        scope_key = sql_quote(&event.scope_key),
        scope_dir = sql_quote(&event.scope_dir),
        resource = sql_quote(&event.resource),
        agent_id = sql_quote(&event.agent_id),
        manager = sql_quote(&event.manager),
        packages = sql_text_array(&packages),
        last_action = sql_quote(&event.action),
        metadata = sql_jsonb(&event.details),
    );
    let _ = run_sql(connection, &sql)?;
    Ok(())
}

fn insert_event(connection: &PackageLedgerConnection, event: &PackageLedgerMutation) -> Result<()> {
    let sql = format!(
        "INSERT INTO pinokio_package_ledger.events (
          task_id,
          task_summary,
          action,
          manager,
          packages,
          scope_key,
          scope_dir,
          resource,
          agent_id,
          applied,
          details
        ) VALUES (
          {task_id},
          {task_summary},
          {action},
          {manager},
          {packages},
          {scope_key},
          {scope_dir},
          {resource},
          {agent_id},
          {applied},
          {details}
        );",
        task_id = sql_quote(&event.task_id),
        task_summary = sql_quote(&event.task_summary),
        action = sql_quote(&event.action),
        manager = sql_quote(&event.manager),
        packages = sql_text_array(&event.packages),
        scope_key = sql_quote(&event.scope_key),
        scope_dir = sql_quote(&event.scope_dir),
        resource = sql_quote(&event.resource),
        agent_id = sql_quote(&event.agent_id),
        applied = if event.applied { "true" } else { "false" },
        details = sql_jsonb(&event.details),
    );
    let _ = run_sql(connection, &sql)?;
    Ok(())
}

fn load_scope_packages(connection: &PackageLedgerConnection, scope_key: &str) -> Result<Vec<String>> {
    let sql = format!(
        "SELECT COALESCE(array_to_json(packages)::text, '[]')
         FROM pinokio_package_ledger.scope_state
         WHERE scope_key = {};",
        sql_quote(scope_key)
    );
    let value = run_json_query(connection, &sql)?;
    let Value::Array(values) = value else {
        return Ok(Vec::new());
    };
    let mut out = BTreeSet::new();
    for value in values {
        if let Some(raw) = value.as_str() {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                out.insert(trimmed.to_string());
            }
        }
    }
    Ok(out.into_iter().collect())
}

fn run_json_query(connection: &PackageLedgerConnection, sql: &str) -> Result<Value> {
    let stdout = run_sql(connection, sql)?;
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("null");
    let parsed: Value = serde_json::from_str(line)
        .with_context(|| format!("invalid JSON returned from package ledger query: {}", line))?;
    Ok(parsed)
}

fn run_sql(connection: &PackageLedgerConnection, sql: &str) -> Result<String> {
    let mut cmd = Command::new("docker");
    cmd.arg("exec").arg("-i");
    if !connection.password.trim().is_empty() {
        cmd.arg("-e")
            .arg(format!("PGPASSWORD={}", connection.password));
    }
    cmd.arg(&connection.container)
        .arg("psql")
        .arg("-v")
        .arg("ON_ERROR_STOP=1")
        .arg("-X")
        .arg("-U")
        .arg(&connection.user)
        .arg("-d")
        .arg(&connection.database)
        .arg("-t")
        .arg("-A")
        .arg("-P")
        .arg("pager=off")
        .arg("-c")
        .arg(sql);

    let output = cmd
        .output()
        .with_context(|| format!("failed to execute docker for {}", connection.container))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        anyhow::bail!(
            "package ledger SQL failed against {} (db={} user={}): {}",
            connection.container,
            connection.database,
            connection.user,
            detail
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn resolve_connection(config: &AppConfig) -> Option<PackageLedgerConnection> {
    let (name, service) = find_postgres_service(config)?;
    let container = config.orchestrator.service_container_name(name, service);
    let database = resolve_service_value(
        service,
        &["PINOKIO_DB_NAME", "PGDATABASE"],
        &["POSTGRES_DB"],
        "pinokio",
    );
    let user = resolve_service_value(
        service,
        &["PINOKIO_DB_USER", "PGUSER"],
        &["POSTGRES_USER"],
        "pinokio",
    );
    let password = resolve_service_value(
        service,
        &["PINOKIO_DB_PASSWORD", "PGPASSWORD"],
        &["POSTGRES_PASSWORD"],
        "",
    );

    Some(PackageLedgerConnection {
        container,
        database,
        user,
        password,
    })
}

fn find_postgres_service<'a>(
    config: &'a AppConfig,
) -> Option<(&'a String, &'a OrchestratorServiceConfig)> {
    if let Some(service) = config.orchestrator.services.get_key_value("postgres_main") {
        return Some(service);
    }

    let mut services: Vec<(&String, &OrchestratorServiceConfig)> =
        config.orchestrator.services.iter().collect();
    services.sort_by(|a, b| a.0.cmp(b.0));
    services.into_iter().find(|(_, service)| {
        service
            .image
            .to_ascii_lowercase()
            .contains("postgres")
    })
}

fn resolve_service_value(
    service: &OrchestratorServiceConfig,
    agent_keys: &[&str],
    env_keys: &[&str],
    fallback: &str,
) -> String {
    for key in agent_keys {
        if let Some(value) = service.agent_env.get(*key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    for key in env_keys {
        if let Some(value) = service.env.get(*key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    fallback.to_string()
}

fn sql_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_jsonb(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
    format!("{}::jsonb", sql_quote(&raw))
}

fn sql_text_array(values: &[String]) -> String {
    if values.is_empty() {
        return "ARRAY[]::text[]".to_string();
    }
    let values = values
        .iter()
        .map(|value| sql_quote(value))
        .collect::<Vec<_>>()
        .join(",");
    format!("ARRAY[{}]::text[]", values)
}
