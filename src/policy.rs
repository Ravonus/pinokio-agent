use std::collections::HashSet;

use anyhow::Result;
use uuid::Uuid;

use crate::{
    config::AppConfig,
    model::{
        AgentPermissions, AgentSkill, AgentSpec, CrudAction, ExecutionKind, IsolationMode,
        TaskRequest,
    },
};

pub fn plan_agents(config: &AppConfig, request: &TaskRequest) -> Result<Vec<AgentSpec>> {
    let actions = required_actions(config, request);
    actions
        .into_iter()
        .map(|action| -> Result<AgentSpec> {
            let execution = select_execution(config, &request.resource, &request.target, action);
            if let Some(plugin_name) = execution.plugin.as_deref() {
                ensure_plugin_access(config, request, plugin_name)?;
                ensure_plugin_dependencies(config, plugin_name)?;
            }
            ensure_permissions_for_plan(action, execution.kind, &execution.permissions)?;
            let isolation = select_isolation(
                config,
                request,
                &request.resource,
                action,
                execution.kind,
                &execution.permissions,
            );
            if requested_isolation(request) != Some(IsolationMode::Host) {
                ensure_container_isolation_for_permissions(
                    config,
                    &request.resource,
                    action,
                    execution.kind,
                    isolation,
                    &execution.permissions,
                )?;
            }
            let allow_spawn_child = execution.permissions.spawn_child;
            let allow_hook_requests = execution.permissions.hook_extensions;
            let permissions = execution.permissions.clone();
            let skills = select_skills(
                config,
                &request.resource,
                action,
                execution.plugin.as_deref(),
                execution.connection.as_deref(),
            );
            Ok(AgentSpec {
                id: format!("{}-{}", action.as_str(), Uuid::new_v4()),
                resource: request.resource.clone(),
                action,
                isolation,
                execution: execution.kind,
                connector: select_connector(config, &request.resource),
                connection: execution.connection,
                connection_command: execution.connection_command,
                plugin: execution.plugin,
                plugin_command: execution.plugin_command,
                allow_spawn_child,
                allow_hook_requests,
                permissions,
                skills,
                container_image: Some(select_container_image(config, request, &request.resource)?),
                container_network: select_container_network(config, request)?,
                llm_profile: select_profile(config, request, action),
            })
        })
        .collect::<Result<Vec<_>>>()
}

fn ensure_plugin_access(
    config: &AppConfig,
    request: &TaskRequest,
    plugin_name: &str,
) -> Result<()> {
    let plugin = config
        .plugins
        .get(plugin_name)
        .ok_or_else(|| anyhow::anyhow!("plugin '{}' is not configured", plugin_name))?;

    if plugin.managed_only
        && (request
            .caller_task_id
            .as_ref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
            || request
                .caller_agent_id
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            || request
                .caller_resource
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true))
    {
        anyhow::bail!(
            "plugin '{}' is managed-only and cannot be invoked directly",
            plugin_name
        );
    }
    if is_unsafe_host_plugin(plugin_name) && !config.manager.unsafe_host_communication_enabled {
        anyhow::bail!(
            "plugin '{}' is disabled by manager policy (set manager.unsafe_host_communication_enabled=true to enable)",
            plugin_name
        );
    }

    Ok(())
}

fn is_unsafe_host_plugin(plugin_name: &str) -> bool {
    plugin_name.eq_ignore_ascii_case("unsafe_host_agent")
}

fn required_actions(config: &AppConfig, request: &TaskRequest) -> Vec<CrudAction> {
    if !config.policies.always_split_crud {
        return vec![request.action];
    }

    // Plugin and child-managed flows already provide explicit CRUD intent.
    // Re-inferring from free text on every hop causes action escalation
    // (for example "cleanup" -> delete) that breaks read-only micro agents.
    if request.resource.trim().starts_with("plugin:")
        || request.resource.trim().starts_with("connection:")
        || request.caller_task_id.is_some()
        || request.caller_agent_id.is_some()
        || request.caller_resource.is_some()
    {
        return vec![request.action];
    }

    let lower = request.summary.to_lowercase();
    let mut actions = Vec::new();

    if lower.contains("create") || lower.contains("new") {
        actions.push(CrudAction::Create);
    }
    if lower.contains("read")
        || lower.contains("inspect")
        || lower.contains("check")
        || lower.contains("list")
    {
        actions.push(CrudAction::Read);
    }
    if lower.contains("update") || lower.contains("edit") || lower.contains("modify") {
        actions.push(CrudAction::Update);
    }
    if lower.contains("delete") || lower.contains("remove") {
        actions.push(CrudAction::Delete);
    }
    if lower.contains("cleanup") || lower.contains("clean up") || lower.contains("organize") {
        actions.push(CrudAction::Update);
    }

    if actions.is_empty() {
        actions.push(request.action);
    }

    actions.sort_by_key(|a| match a {
        CrudAction::Create => 0,
        CrudAction::Read => 1,
        CrudAction::Update => 2,
        CrudAction::Delete => 3,
    });
    actions.dedup();
    actions
}

fn select_isolation(
    config: &AppConfig,
    request: &TaskRequest,
    resource: &str,
    action: CrudAction,
    execution_kind: ExecutionKind,
    permissions: &AgentPermissions,
) -> IsolationMode {
    let resource_lower = resource.to_lowercase();
    if let Some(plugin) = resource.strip_prefix("plugin:") {
        if let Some(cfg) = config.plugins.get(plugin.trim()) {
            if cfg.host_only {
                return IsolationMode::Host;
            }
            if let Some(mode) = requested_isolation(request) {
                return mode;
            }
            return IsolationMode::Container;
        }
    }
    if let Some(connection_name) = connection_name_from_resource(resource) {
        if let Some(cfg) = config.connections.get(connection_name) {
            if cfg.host_only {
                return IsolationMode::Host;
            }
            if let Some(mode) = requested_isolation(request) {
                return mode;
            }
            return IsolationMode::Container;
        }
    }

    let connector_host_only = select_connector(config, resource)
        .and_then(|name| config.connectors.get(&name))
        .map(|connector| connector.host_only)
        .unwrap_or(false);

    if connector_host_only {
        return IsolationMode::Host;
    }

    if let Some(mode) = requested_isolation(request) {
        return mode;
    }

    if config
        .policies
        .container_first_resources
        .iter()
        .any(|r| r == &resource_lower)
    {
        return IsolationMode::Container;
    }

    let high_risk = config
        .policies
        .high_risk_resources
        .iter()
        .any(|r| r == &resource_lower);

    if high_risk && action != CrudAction::Read {
        return IsolationMode::Container;
    }

    if requires_container_for_permissions(config, permissions, action, execution_kind) {
        return IsolationMode::Container;
    }

    IsolationMode::Host
}

fn requested_isolation(request: &TaskRequest) -> Option<IsolationMode> {
    let runtime = request.runtime.clone().or_else(|| {
        request
            .target
            .as_deref()
            .and_then(parse_runtime_from_target_json)
    })?;
    let normalized = runtime.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "container" | "sandbox" => Some(IsolationMode::Container),
        "host" | "unsafe_host" | "unsafe-host" | "unsafe" => Some(IsolationMode::Host),
        _ => None,
    }
}

fn parse_runtime_from_target_json(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    parsed
        .as_object()
        .and_then(|obj| obj.get("runtime"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

#[derive(Debug)]
struct ExecutionSelection {
    kind: ExecutionKind,
    plugin: Option<String>,
    plugin_command: Option<String>,
    connection: Option<String>,
    connection_command: Option<String>,
    permissions: AgentPermissions,
}

fn select_execution(
    config: &AppConfig,
    resource: &str,
    target: &Option<String>,
    action: CrudAction,
) -> ExecutionSelection {
    if let Some(plugin) = resource.strip_prefix("plugin:") {
        let plugin_name = plugin.trim().to_string();
        if let Some(plugin_cfg) = config.plugins.get(&plugin_name) {
            let permissions = plugin_cfg
                .permissions
                .resolve(&plugin_cfg.allowed_actions, &plugin_cfg.capabilities);
            let plugin_cmd = if permissions.allows_action(action) {
                Some(plugin_cfg.command.clone())
            } else {
                None
            };
            return ExecutionSelection {
                kind: ExecutionKind::PluginCommand,
                plugin: Some(plugin_name),
                plugin_command: plugin_cmd,
                connection: None,
                connection_command: None,
                permissions,
            };
        }
        return ExecutionSelection {
            kind: ExecutionKind::PluginCommand,
            plugin: Some(plugin_name),
            plugin_command: None,
            connection: None,
            connection_command: None,
            permissions: AgentPermissions::default(),
        };
    }

    if let Some(connection_name) = connection_name_from_resource(resource) {
        if let Some(connection_cfg) = config.connections.get(connection_name) {
            let permissions = connection_cfg.permissions.resolve(
                &connection_cfg.allowed_actions,
                &connection_cfg.capabilities,
            );
            let connection_cmd = if permissions.allows_action(action) {
                Some(connection_cfg.command.clone())
            } else {
                None
            };
            return ExecutionSelection {
                kind: ExecutionKind::ConnectionCommand,
                plugin: None,
                plugin_command: None,
                connection: Some(connection_name.to_string()),
                connection_command: connection_cmd,
                permissions,
            };
        }
        return ExecutionSelection {
            kind: ExecutionKind::ConnectionCommand,
            plugin: None,
            plugin_command: None,
            connection: Some(connection_name.to_string()),
            connection_command: None,
            permissions: AgentPermissions::default(),
        };
    }

    if action == CrudAction::Read {
        let resource_is_web = resource.eq_ignore_ascii_case("web");
        let target_is_url = target
            .as_ref()
            .map(|t| t.starts_with("http://") || t.starts_with("https://"))
            .unwrap_or(false);
        if resource_is_web || target_is_url {
            return ExecutionSelection {
                kind: ExecutionKind::PlaywrightRead,
                plugin: None,
                plugin_command: None,
                connection: None,
                connection_command: None,
                permissions: direct_permissions(action, ExecutionKind::PlaywrightRead),
            };
        }
    }

    ExecutionSelection {
        kind: ExecutionKind::Noop,
        plugin: None,
        plugin_command: None,
        connection: None,
        connection_command: None,
        permissions: direct_permissions(action, ExecutionKind::Noop),
    }
}

fn direct_permissions(action: CrudAction, execution_kind: ExecutionKind) -> AgentPermissions {
    let mut permissions = AgentPermissions::default();
    permissions.set_action(action, true);
    if execution_kind == ExecutionKind::PlaywrightRead {
        permissions.playwright = true;
        permissions.network = true;
    }
    permissions
}

fn ensure_permissions_for_plan(
    action: CrudAction,
    execution_kind: ExecutionKind,
    permissions: &AgentPermissions,
) -> Result<()> {
    if !permissions.allows_action(action) {
        anyhow::bail!("action '{}' denied by agent permissions", action.as_str());
    }

    if execution_kind == ExecutionKind::PlaywrightRead && !permissions.playwright {
        anyhow::bail!("playwright execution denied by agent permissions");
    }

    Ok(())
}

fn ensure_container_isolation_for_permissions(
    config: &AppConfig,
    resource: &str,
    action: CrudAction,
    execution_kind: ExecutionKind,
    isolation: IsolationMode,
    permissions: &AgentPermissions,
) -> Result<()> {
    if resource
        .trim()
        .eq_ignore_ascii_case("plugin:unsafe_host_agent")
    {
        return Ok(());
    }

    if isolation == IsolationMode::Container {
        return Ok(());
    }

    if !requires_container_for_permissions(config, permissions, action, execution_kind) {
        return Ok(());
    }

    anyhow::bail!(
        "resource '{}' action '{}' requires container isolation by manager policy",
        resource,
        action.as_str()
    );
}

fn requires_container_for_permissions(
    config: &AppConfig,
    permissions: &AgentPermissions,
    action: CrudAction,
    execution_kind: ExecutionKind,
) -> bool {
    config
        .manager
        .container_required_permissions
        .iter()
        .any(|key| container_permission_enabled(key, permissions, action, execution_kind))
}

fn container_permission_enabled(
    key: &str,
    permissions: &AgentPermissions,
    action: CrudAction,
    execution_kind: ExecutionKind,
) -> bool {
    match key.trim().to_ascii_lowercase().as_str() {
        "playwright" => permissions.playwright || execution_kind == ExecutionKind::PlaywrightRead,
        "filesystem_read" | "fs_read" => permissions.filesystem_read,
        "filesystem_write" | "fs_write" => permissions.filesystem_write,
        "network" => permissions.network,
        "exec" => permissions.exec,
        "memory_read" => permissions.memory_read,
        "memory_write" => permissions.memory_write,
        "spawn_child" => permissions.spawn_child,
        "hook_extensions" | "hooks" => permissions.hook_extensions,
        "create" => action == CrudAction::Create,
        "update" => action == CrudAction::Update,
        "delete" => action == CrudAction::Delete,
        "write" => matches!(
            action,
            CrudAction::Create | CrudAction::Update | CrudAction::Delete
        ),
        _ => false,
    }
}

fn connection_name_from_resource(resource: &str) -> Option<&str> {
    if let Some(connection) = resource.strip_prefix("connection:") {
        return Some(connection.trim());
    }
    if let Some(connection) = resource.strip_prefix("conn:") {
        return Some(connection.trim());
    }
    None
}

fn select_connector(config: &AppConfig, resource: &str) -> Option<String> {
    let resource_lower = resource.to_lowercase();
    config.connectors.iter().find_map(|(name, connector)| {
        if connector.allowed_resources.is_empty()
            || connector
                .allowed_resources
                .iter()
                .any(|allowed| allowed == &resource_lower)
        {
            Some(name.clone())
        } else {
            None
        }
    })
}

fn select_profile(config: &AppConfig, request: &TaskRequest, action: CrudAction) -> String {
    if let Some(profile) = &request.llm_profile {
        return profile.clone();
    }

    if action == CrudAction::Delete && config.llm_profiles.contains_key("conservative") {
        return "conservative".to_string();
    }

    config.policies.default_profile.clone()
}

fn select_container_image(
    config: &AppConfig,
    request: &TaskRequest,
    resource: &str,
) -> Result<String> {
    if let Some(image) = request.container_image.as_ref() {
        if !config.orchestrator.allow_custom_images {
            anyhow::bail!("custom images are disabled by orchestrator policy");
        }
        if !config.orchestrator.allowed_custom_image_prefixes.is_empty()
            && !config
                .orchestrator
                .allowed_custom_image_prefixes
                .iter()
                .any(|prefix| image.starts_with(prefix))
        {
            anyhow::bail!(
                "custom image '{}' is not allowed. allowed prefixes: {}",
                image,
                config.orchestrator.allowed_custom_image_prefixes.join(", ")
            );
        }
        return Ok(image.clone());
    }

    let key = resource.to_lowercase();
    if let Some(image) = config.orchestrator.resource_images.get(&key) {
        return Ok(image.clone());
    }
    if key.starts_with("plugin:") {
        if let Some(image) = config.orchestrator.resource_images.get("plugins") {
            return Ok(image.clone());
        }
    }
    if key.starts_with("connection:") || key.starts_with("conn:") {
        if let Some(image) = config.orchestrator.resource_images.get("connections") {
            return Ok(image.clone());
        }
    }

    Ok(config.orchestrator.default_image.clone())
}

fn select_container_network(config: &AppConfig, request: &TaskRequest) -> Result<Option<String>> {
    let configured = config
        .orchestrator
        .resource_networks
        .get(&request.resource.to_lowercase())
        .or_else(|| config.orchestrator.resource_networks.get("*"))
        .cloned();
    let requested = request.container_network.clone().or(configured);
    let Some(network) = requested else {
        return Ok(None);
    };
    let trimmed = network.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.eq_ignore_ascii_case("managed") || trimmed.eq_ignore_ascii_case("default") {
        return Ok(None);
    }

    if trimmed.eq_ignore_ascii_case("host") || trimmed.eq_ignore_ascii_case("bridge") {
        return Ok(Some(trimmed.to_ascii_lowercase()));
    }

    if config
        .orchestrator
        .container_networks()
        .iter()
        .any(|value| value.eq_ignore_ascii_case(trimmed))
    {
        return Ok(Some(trimmed.to_string()));
    }

    anyhow::bail!(
        "container network '{}' is not allowed. use host|bridge|managed or one of: {}",
        trimmed,
        config.orchestrator.container_networks().join(", ")
    );
}

fn ensure_plugin_dependencies(config: &AppConfig, plugin_name: &str) -> Result<()> {
    let mut stack = Vec::new();
    let mut visited = HashSet::new();
    resolve_plugin_dependencies(config, plugin_name, &mut stack, &mut visited)
}

fn resolve_plugin_dependencies(
    config: &AppConfig,
    plugin_name: &str,
    stack: &mut Vec<String>,
    visited: &mut HashSet<String>,
) -> Result<()> {
    if visited.contains(plugin_name) {
        return Ok(());
    }

    if let Some(pos) = stack.iter().position(|name| name == plugin_name) {
        let mut chain = stack[pos..].to_vec();
        chain.push(plugin_name.to_string());
        anyhow::bail!("plugin dependency cycle detected: {}", chain.join(" -> "));
    }

    let plugin = config
        .plugins
        .get(plugin_name)
        .ok_or_else(|| anyhow::anyhow!("plugin '{}' is not configured", plugin_name))?;

    stack.push(plugin_name.to_string());
    for dependency in &plugin.dependencies {
        let dep = normalize_plugin_dependency_name(dependency)?;
        resolve_plugin_dependencies(config, &dep, stack, visited).map_err(|err| {
            anyhow::anyhow!("plugin '{}' dependency '{}': {}", plugin_name, dep, err)
        })?;
    }
    stack.pop();

    visited.insert(plugin_name.to_string());
    Ok(())
}

fn normalize_plugin_dependency_name(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("dependency name is empty");
    }
    if let Some(plugin) = trimmed.strip_prefix("plugin:") {
        let name = plugin.trim();
        if name.is_empty() {
            anyhow::bail!("dependency '{}' has empty plugin name", raw);
        }
        return Ok(name.to_string());
    }
    if trimmed.contains(':') {
        anyhow::bail!(
            "unsupported dependency '{}' (expected plugin:<name> or bare plugin name)",
            raw
        );
    }
    Ok(trimmed.to_string())
}

fn select_skills(
    config: &AppConfig,
    resource: &str,
    action: CrudAction,
    plugin: Option<&str>,
    connection: Option<&str>,
) -> Vec<AgentSkill> {
    let mut out = config
        .skills
        .iter()
        .filter_map(|(name, skill)| {
            if !skill.enabled {
                return None;
            }
            if !skill_matches_targets(
                resource,
                action,
                plugin,
                connection,
                &skill.targets.plugins,
                &skill.targets.resources,
                &skill.targets.agents,
                &skill.targets.actions,
            ) {
                return None;
            }
            Some(AgentSkill {
                name: name.clone(),
                description: skill.description.clone(),
                path: skill.path.clone(),
                tags: skill.tags.clone(),
            })
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn skill_matches_targets(
    resource: &str,
    action: CrudAction,
    plugin: Option<&str>,
    connection: Option<&str>,
    plugin_targets: &[String],
    resource_targets: &[String],
    agent_targets: &[String],
    action_targets: &[String],
) -> bool {
    let plugin_alias = plugin.map(|name| format!("plugin:{}", name));
    let plugin_aliases = if let Some(alias) = plugin_alias.as_deref() {
        vec![resource, alias]
    } else {
        vec![resource]
    };
    let plugin_match = matches_target_value(plugin_targets, plugin, &plugin_aliases);
    let resource_match = matches_target_value(resource_targets, Some(resource), &[resource]);
    let action_match =
        matches_target_value(action_targets, Some(action.as_str()), &[action.as_str()]);

    let execution_agent = if let Some(name) = plugin {
        format!("plugin:{}", name)
    } else if let Some(name) = connection {
        format!("connection:{}", name)
    } else {
        "direct".to_string()
    };
    let agent_match = matches_target_value(
        agent_targets,
        Some(execution_agent.as_str()),
        &[execution_agent.as_str(), resource],
    );

    plugin_match && resource_match && action_match && agent_match
}

fn matches_target_value(values: &[String], primary: Option<&str>, aliases: &[&str]) -> bool {
    if values.is_empty() {
        return true;
    }
    let mut normalized = Vec::new();
    if let Some(primary) = primary {
        let trimmed = primary.trim();
        if !trimmed.is_empty() {
            normalized.push(trimmed.to_ascii_lowercase());
        }
    }
    for alias in aliases {
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = trimmed.to_ascii_lowercase();
        if !normalized.iter().any(|item| item == &value) {
            normalized.push(value);
        }
    }
    values.iter().any(|candidate| {
        let item = candidate.trim().to_ascii_lowercase();
        if item.is_empty() || item == "*" {
            return true;
        }
        normalized.iter().any(|value| value == &item)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::config::{
        AppConfig, CommandCapabilityConfig, CommandPermissionConfig, ConnectionConfig,
        ConnectorConfig, PolicyConfig,
    };
    use crate::model::{CrudAction, ExecutionKind, IsolationMode, TaskRequest};

    use super::plan_agents;

    #[test]
    fn split_crud_from_task_summary() {
        let config = AppConfig::default();
        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read and update twitter bio".to_string(),
            resource: "twitter".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let planned = plan_agents(&config, &request).expect("planning should succeed");
        assert_eq!(planned.len(), 2);
    }

    #[test]
    fn host_only_connector_wins_over_container_policy() {
        let mut connectors = HashMap::new();
        connectors.insert(
            "mail_host".to_string(),
            ConnectorConfig {
                auth_env: vec!["MAIL_TOKEN".to_string()],
                allowed_resources: vec!["email".to_string()],
                host_only: true,
            },
        );

        let config = AppConfig {
            connectors,
            policies: PolicyConfig {
                container_first_resources: vec!["email".to_string()],
                ..PolicyConfig::default()
            },
            ..AppConfig::default()
        };

        let request = TaskRequest {
            id: "x".to_string(),
            summary: "update email draft".to_string(),
            resource: "email".to_string(),
            action: CrudAction::Update,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let planned = plan_agents(&config, &request).expect("planning should succeed");
        assert_eq!(planned[0].isolation, IsolationMode::Host);
    }

    #[test]
    fn connection_resource_plans_connection_execution() {
        let mut connections = HashMap::new();
        connections.insert(
            "telegram".to_string(),
            ConnectionConfig {
                command: "node plugins/telegram-bridge.mjs".to_string(),
                host_only: false,
                auth_env: vec!["TELEGRAM_BOT_TOKEN".to_string()],
                allowed_actions: vec!["read".to_string(), "create".to_string()],
                capabilities: CommandCapabilityConfig {
                    allow_spawn_child: false,
                    allow_hook_requests: true,
                    allow_network: true,
                    allow_filesystem: false,
                },
                permissions: CommandPermissionConfig::default(),
            },
        );
        let config = AppConfig {
            connections,
            ..AppConfig::default()
        };

        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read telegram inbox".to_string(),
            resource: "connection:telegram".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let planned = plan_agents(&config, &request).expect("planning should succeed");
        assert_eq!(planned[0].execution, ExecutionKind::ConnectionCommand);
        assert_eq!(planned[0].connection.as_deref(), Some("telegram"));
        assert!(planned[0].allow_hook_requests);
    }

    #[test]
    fn plugin_dependency_validation_accepts_memory_stack() {
        let config = AppConfig::default();
        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read memory".to_string(),
            resource: "plugin:memory_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let planned = plan_agents(&config, &request).expect("planning should succeed");
        assert_eq!(planned[0].plugin.as_deref(), Some("memory_agent"));
    }

    #[test]
    fn plugin_dependency_validation_fails_when_missing() {
        let mut config = AppConfig::default();
        config
            .plugins
            .get_mut("memory_agent")
            .expect("memory plugin should exist")
            .dependencies = vec!["plugin:not_installed".to_string()];

        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read memory".to_string(),
            resource: "plugin:memory_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let err = plan_agents(&config, &request).expect_err("planning should fail");
        let msg = err.to_string();
        assert!(msg.contains("dependency 'not_installed'"));
    }

    #[test]
    fn plugin_dependency_validation_fails_on_cycle() {
        let mut config = AppConfig::default();
        config
            .plugins
            .get_mut("db_read_agent")
            .expect("db read plugin should exist")
            .dependencies = vec!["plugin:db_router_agent".to_string()];

        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read db".to_string(),
            resource: "plugin:db_router_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let err = plan_agents(&config, &request).expect_err("planning should fail");
        assert!(err.to_string().contains("dependency cycle detected"));
    }

    #[test]
    fn managed_only_plugin_denies_direct_request() {
        let config = AppConfig::default();
        let request = TaskRequest {
            id: "x".to_string(),
            summary: "run unsafe host chat".to_string(),
            resource: "plugin:unsafe_host_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let err = plan_agents(&config, &request).expect_err("planning should fail");
        assert!(err.to_string().contains("managed-only"));
    }

    #[test]
    fn unsafe_host_plugin_denied_when_manager_policy_disabled() {
        let config = AppConfig::default();
        let request = TaskRequest {
            id: "x".to_string(),
            summary: "run unsafe host chat".to_string(),
            resource: "plugin:unsafe_host_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: Some("parent-task".to_string()),
            caller_agent_id: Some("parent-agent".to_string()),
            caller_resource: Some("plugin:chat_worker_agent".to_string()),
        };

        let err = plan_agents(&config, &request).expect_err("planning should fail");
        assert!(err.to_string().contains("disabled by manager policy"));
    }

    #[test]
    fn managed_only_plugin_allows_spawned_request() {
        let mut config = AppConfig::default();
        config.manager.unsafe_host_communication_enabled = true;
        let request = TaskRequest {
            id: "x".to_string(),
            summary: "run unsafe host chat".to_string(),
            resource: "plugin:unsafe_host_agent".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: Some("parent-task".to_string()),
            caller_agent_id: Some("parent-agent".to_string()),
            caller_resource: Some("plugin:chat_worker_agent".to_string()),
        };

        let planned = plan_agents(&config, &request).expect("planning should succeed");
        assert_eq!(planned[0].plugin.as_deref(), Some("unsafe_host_agent"));
    }

    #[test]
    fn playwright_permission_defaults_to_container_isolation() {
        let config = AppConfig::default();
        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read web page".to_string(),
            resource: "web".to_string(),
            action: CrudAction::Read,
            target: Some("https://example.com".to_string()),
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let planned = plan_agents(&config, &request).expect("planning should succeed");
        assert_eq!(planned[0].execution, ExecutionKind::PlaywrightRead);
        assert_eq!(planned[0].isolation, IsolationMode::Container);
        assert!(planned[0].permissions.playwright);
    }

    #[test]
    fn host_only_connection_denied_when_policy_requires_container_permissions() {
        let mut connections = HashMap::new();
        connections.insert(
            "browser_host".to_string(),
            ConnectionConfig {
                command: "node plugins/browser-host.mjs".to_string(),
                host_only: true,
                auth_env: vec![],
                allowed_actions: vec!["read".to_string()],
                capabilities: CommandCapabilityConfig {
                    allow_spawn_child: false,
                    allow_hook_requests: false,
                    allow_network: false,
                    allow_filesystem: false,
                },
                permissions: CommandPermissionConfig {
                    playwright: Some(true),
                    ..CommandPermissionConfig::default()
                },
            },
        );
        let config = AppConfig {
            connections,
            ..AppConfig::default()
        };

        let request = TaskRequest {
            id: "x".to_string(),
            summary: "read browser host".to_string(),
            resource: "connection:browser_host".to_string(),
            action: CrudAction::Read,
            target: None,
            runtime: None,
            container_image: None,
            container_network: None,
            llm_profile: None,
            caller_task_id: None,
            caller_agent_id: None,
            caller_resource: None,
        };

        let err = plan_agents(&config, &request).expect_err("planning should fail");
        assert!(err.to_string().contains("requires container isolation"));
    }
}
