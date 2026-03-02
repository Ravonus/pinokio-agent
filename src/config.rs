use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{
    model::AgentPermissions,
    oauth_cli::{claude_code_command_layer_command, codex_command_layer_command},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub manager: ManagerConfig,
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub marketplace: MarketplaceConfig,
    #[serde(default)]
    pub playwright: PlaywrightConfig,
    #[serde(default)]
    pub ui: UiConfig,
    #[serde(default)]
    pub orchestrator: OrchestratorConfig,
    #[serde(default)]
    pub connectors: HashMap<String, ConnectorConfig>,
    #[serde(default)]
    pub connections: HashMap<String, ConnectionConfig>,
    #[serde(default)]
    pub api_layers: HashMap<String, ApiLayerConfig>,
    #[serde(default)]
    pub credentials: HashMap<String, CredentialConfig>,
    #[serde(default)]
    pub llm_profiles: HashMap<String, LlmProfile>,
    #[serde(default)]
    pub policies: PolicyConfig,
    #[serde(default)]
    pub hooks: HookConfig,
    #[serde(default)]
    pub plugins: HashMap<String, PluginConfig>,
    #[serde(default)]
    pub skills: HashMap<String, SkillConfig>,
    #[serde(default)]
    pub plugin_registry: PluginRegistryConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut api_layers = HashMap::new();
        api_layers.insert(
            "openai_codex".to_string(),
            ApiLayerConfig {
                kind: "openai_compatible".to_string(),
                base_url: Some("https://api.openai.com".to_string()),
                credential: Some("openai_main".to_string()),
                command: None,
                headers: HashMap::new(),
            },
        );
        api_layers.insert(
            "claude_api".to_string(),
            ApiLayerConfig {
                kind: "anthropic_messages".to_string(),
                base_url: Some("https://api.anthropic.com".to_string()),
                credential: Some("claude_api_main".to_string()),
                command: None,
                headers: HashMap::new(),
            },
        );
        api_layers.insert(
            "claude_code".to_string(),
            ApiLayerConfig {
                kind: "command".to_string(),
                base_url: None,
                credential: Some("claude_code_main".to_string()),
                command: Some(claude_code_command_layer_command()),
                headers: HashMap::new(),
            },
        );

        let mut credentials = HashMap::new();
        credentials.insert(
            "openai_main".to_string(),
            CredentialConfig {
                provider: "openai".to_string(),
                mode: "api_key".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                login_command: None,
                session_file: None,
            },
        );
        credentials.insert(
            "claude_api_main".to_string(),
            CredentialConfig {
                provider: "anthropic".to_string(),
                mode: "api_key".to_string(),
                env: vec!["ANTHROPIC_API_KEY".to_string()],
                login_command: None,
                session_file: None,
            },
        );
        credentials.insert(
            "claude_code_main".to_string(),
            CredentialConfig {
                provider: "claude_code".to_string(),
                mode: "oauth_command".to_string(),
                env: vec!["ANTHROPIC_API_KEY".to_string()],
                login_command: Some("claude auth token --json".to_string()),
                session_file: None,
            },
        );

        let mut llm_profiles = HashMap::new();
        llm_profiles.insert(
            "default".to_string(),
            LlmProfile {
                provider: "openai".to_string(),
                model: "gpt-4.1-mini".to_string(),
                api_layer: "openai_codex".to_string(),
                credential: None,
                fallback: None,
                max_tokens: 2000,
                max_cost_usd: 0.25,
                temperature: 0.2,
                system_prompt: Some(
                    "You are a secure orchestration agent. Be concise and risk-aware. Always check installed plugins and systems before claiming a capability is unavailable.".to_string(),
                ),
            },
        );
        llm_profiles.insert(
            "claude_code".to_string(),
            LlmProfile {
                provider: "claude_code".to_string(),
                model: "claude-code".to_string(),
                api_layer: "claude_code".to_string(),
                credential: None,
                fallback: None,
                max_tokens: 2000,
                max_cost_usd: 0.25,
                temperature: 0.2,
                system_prompt: Some(
                    "You are a secure orchestration agent. Be concise and risk-aware. Always check installed plugins and systems before claiming a capability is unavailable.".to_string(),
                ),
            },
        );

        let plugins = HashMap::new();
        let skills = HashMap::new();

        let mut config = Self {
            manager: ManagerConfig::default(),
            auth: AuthConfig::default(),
            marketplace: MarketplaceConfig::default(),
            playwright: PlaywrightConfig::default(),
            ui: UiConfig::default(),
            orchestrator: OrchestratorConfig::default(),
            connectors: HashMap::new(),
            connections: HashMap::new(),
            api_layers,
            credentials,
            llm_profiles,
            policies: PolicyConfig::default(),
            hooks: HookConfig::default(),
            plugins,
            skills,
            plugin_registry: PluginRegistryConfig::default(),
        };
        hydrate_installed_manifest_entries(&mut config, None);
        config
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorConfig {
    #[serde(default = "default_orchestrator_backend")]
    pub backend: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_orchestrator_default_image")]
    pub default_image: String,
    #[serde(default = "default_true")]
    pub allow_custom_images: bool,
    #[serde(default = "default_allowed_image_prefixes")]
    pub allowed_custom_image_prefixes: Vec<String>,
    #[serde(default)]
    pub resource_images: HashMap<String, String>,
    #[serde(default = "default_orchestrator_resource_networks")]
    pub resource_networks: HashMap<String, String>,
    #[serde(default = "default_orchestrator_services")]
    pub services: HashMap<String, OrchestratorServiceConfig>,
    #[serde(default = "default_orchestrator_entrypoint")]
    pub agent_entrypoint: String,
    #[serde(default = "default_orchestrator_mounts")]
    pub mounts: Vec<String>,
    #[serde(default = "default_true")]
    pub mount_workspace: bool,
    #[serde(default = "default_workspace_mount_path")]
    pub workspace_mount_path: String,
    #[serde(default)]
    pub network: Option<String>,
    #[serde(default = "default_orchestrator_managed_network")]
    pub managed_network_name: String,
    #[serde(default = "default_true")]
    pub ensure_managed_network: bool,
    #[serde(default = "default_true")]
    pub auto_create_networks: bool,
    #[serde(default)]
    pub additional_networks: Vec<String>,
    #[serde(default = "default_orchestrator_dns_servers")]
    pub dns_servers: Vec<String>,
    #[serde(default = "default_orchestrator_swarm_poll_ms")]
    pub swarm_poll_interval_ms: u64,
    #[serde(default = "default_true")]
    pub allow_backend_fallback: bool,
    #[serde(default)]
    pub auto_init_swarm: bool,
    #[serde(default = "default_true")]
    pub auto_pull_images: bool,
    #[serde(default = "default_true")]
    pub inject_host_binary: bool,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            backend: default_orchestrator_backend(),
            enabled: true,
            default_image: default_orchestrator_default_image(),
            allow_custom_images: true,
            allowed_custom_image_prefixes: default_allowed_image_prefixes(),
            resource_images: HashMap::new(),
            resource_networks: default_orchestrator_resource_networks(),
            services: default_orchestrator_services(),
            agent_entrypoint: default_orchestrator_entrypoint(),
            mounts: default_orchestrator_mounts(),
            mount_workspace: true,
            workspace_mount_path: default_workspace_mount_path(),
            network: None,
            managed_network_name: default_orchestrator_managed_network(),
            ensure_managed_network: true,
            auto_create_networks: true,
            additional_networks: Vec::new(),
            dns_servers: default_orchestrator_dns_servers(),
            swarm_poll_interval_ms: default_orchestrator_swarm_poll_ms(),
            allow_backend_fallback: true,
            auto_init_swarm: false,
            auto_pull_images: true,
            inject_host_binary: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorServiceConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub image: String,
    #[serde(default)]
    pub container_name: Option<String>,
    #[serde(default = "default_service_restart_policy")]
    pub restart: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub mounts: Vec<String>,
    #[serde(default)]
    pub ports: Vec<String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub network_aliases: Vec<String>,
    #[serde(default)]
    pub internal_port: Option<u16>,
    #[serde(default)]
    pub healthcheck_cmd: Option<String>,
    #[serde(default = "default_service_ready_timeout_secs")]
    pub ready_timeout_secs: u64,
    #[serde(default)]
    pub expose_to_agents: bool,
    #[serde(default)]
    pub expose_resources: Vec<String>,
    #[serde(default)]
    pub agent_env: HashMap<String, String>,
}

impl OrchestratorConfig {
    pub fn primary_network(&self) -> Option<String> {
        if let Some(explicit) = &self.network {
            let trimmed = explicit.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if self.ensure_managed_network {
            let trimmed = self.managed_network_name.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    }

    pub fn container_networks(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(primary) = self.primary_network() {
            out.push(primary);
        }
        for network in &self.additional_networks {
            let trimmed = network.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !out.iter().any(|name| name == trimmed) {
                out.push(trimmed.to_string());
            }
        }
        out
    }

    pub fn service_container_name(
        &self,
        service_name: &str,
        service: &OrchestratorServiceConfig,
    ) -> String {
        if let Some(container_name) = &service.container_name {
            let trimmed = container_name.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        format!("pinokio-svc-{}", sanitize_service_name(service_name))
    }
}

fn sanitize_service_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "service".to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaywrightConfig {
    #[serde(default = "default_true")]
    pub managed_by_rust: bool,
    #[serde(default = "default_true")]
    pub default_use_user_context: bool,
    #[serde(default = "default_false")]
    pub default_headless: bool,
    #[serde(default = "default_true")]
    pub require_user_context_permission: bool,
    #[serde(default = "default_true")]
    pub allow_user_context_any_domain: bool,
    #[serde(default = "default_playwright_user_context_domain_allowlist")]
    pub user_context_domain_allowlist: Vec<String>,
    #[serde(default = "default_playwright_auth_domain_hints")]
    pub auth_domain_hints: Vec<String>,
    #[serde(default = "default_true")]
    pub container_fallback_non_auth: bool,
    #[serde(default = "default_playwright_user_context_dir")]
    pub user_context_dir: String,
    #[serde(default = "default_true")]
    pub auto_install_node_deps: bool,
    #[serde(default = "default_playwright_node_setup_command")]
    pub node_setup_command: String,
    #[serde(default = "default_playwright_auto_install")]
    pub auto_install_chromium: bool,
    #[serde(default = "default_playwright_install_command")]
    pub install_command: String,
    #[serde(default = "default_playwright_host_service_command")]
    pub host_service_command: String,
    #[serde(default)]
    pub container_service_command: Option<String>,
    #[serde(default = "default_playwright_timeout_ms")]
    pub request_timeout_ms: u64,
}

impl Default for PlaywrightConfig {
    fn default() -> Self {
        Self {
            managed_by_rust: true,
            default_use_user_context: true,
            default_headless: false,
            require_user_context_permission: true,
            allow_user_context_any_domain: true,
            user_context_domain_allowlist: default_playwright_user_context_domain_allowlist(),
            auth_domain_hints: default_playwright_auth_domain_hints(),
            container_fallback_non_auth: true,
            user_context_dir: default_playwright_user_context_dir(),
            auto_install_node_deps: true,
            node_setup_command: default_playwright_node_setup_command(),
            auto_install_chromium: default_playwright_auto_install(),
            install_command: default_playwright_install_command(),
            host_service_command: default_playwright_host_service_command(),
            container_service_command: None,
            request_timeout_ms: default_playwright_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_ui_host")]
    pub host: String,
    #[serde(default = "default_ui_port")]
    pub port: u16,
    #[serde(default = "default_true")]
    pub auto_install_node_deps: bool,
    #[serde(default = "default_ui_setup_command")]
    pub node_setup_command: String,
    #[serde(default = "default_ui_build_on_start")]
    pub build_on_start: bool,
    #[serde(default = "default_ui_build_command")]
    pub build_command: String,
    #[serde(default = "default_ui_serve_command")]
    pub serve_command: String,
    #[serde(default = "default_ui_https_enabled")]
    pub https_enabled: bool,
    #[serde(default = "default_ui_auto_trust_local_https")]
    pub auto_trust_local_https: bool,
    #[serde(default)]
    pub tls_cert_path: Option<String>,
    #[serde(default)]
    pub tls_key_path: Option<String>,
    #[serde(default = "default_true")]
    pub auto_publish_agent_pages: bool,
    #[serde(default = "default_ui_pages_dir")]
    pub pages_dir: String,
    #[serde(default = "default_ui_max_page_bytes")]
    pub max_page_bytes: u64,
    #[serde(default)]
    pub extensions: HashMap<String, UiExtensionConfig>,
}

impl Default for UiConfig {
    fn default() -> Self {
        let mut extensions = HashMap::new();
        extensions.insert(
            "configure".to_string(),
            UiExtensionConfig {
                kind: "core".to_string(),
                slot: "settings".to_string(),
                title: Some("Manager Configure".to_string()),
                detail: Some("Credential setup and extension registration surface.".to_string()),
                route: Some("/ui/configure".to_string()),
                order: 10,
                enabled: true,
            },
        );

        Self {
            enabled: true,
            host: default_ui_host(),
            port: default_ui_port(),
            auto_install_node_deps: true,
            node_setup_command: default_ui_setup_command(),
            build_on_start: default_ui_build_on_start(),
            build_command: default_ui_build_command(),
            serve_command: default_ui_serve_command(),
            https_enabled: default_ui_https_enabled(),
            auto_trust_local_https: default_ui_auto_trust_local_https(),
            tls_cert_path: None,
            tls_key_path: None,
            auto_publish_agent_pages: true,
            pages_dir: default_ui_pages_dir(),
            max_page_bytes: default_ui_max_page_bytes(),
            extensions,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiExtensionConfig {
    #[serde(default = "default_ui_extension_kind")]
    pub kind: String,
    #[serde(default = "default_ui_extension_slot")]
    pub slot: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default = "default_ui_extension_order")]
    pub order: i32,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for UiExtensionConfig {
    fn default() -> Self {
        Self {
            kind: default_ui_extension_kind(),
            slot: default_ui_extension_slot(),
            title: None,
            detail: None,
            route: None,
            order: default_ui_extension_order(),
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagerConfig {
    #[serde(default = "default_true")]
    pub prefer_container_manager: bool,
    #[serde(default = "default_true")]
    pub enable_container_agents: bool,
    #[serde(default = "default_true")]
    pub child_spawn_enabled: bool,
    #[serde(default = "default_child_spawn_depth")]
    pub child_spawn_max_depth: u8,
    #[serde(default = "default_true")]
    pub child_spawn_container_only: bool,
    #[serde(default = "default_false")]
    pub unsafe_host_communication_enabled: bool,
    #[serde(default = "default_true")]
    pub hook_extensions_enabled: bool,
    #[serde(default = "default_true")]
    pub hook_extensions_container_only: bool,
    #[serde(default = "default_true")]
    pub socket_bus_enabled: bool,
    #[serde(default = "default_true")]
    pub socket_bus_container_only: bool,
    #[serde(default = "default_socket_bus_max_channel_messages")]
    pub socket_bus_max_channel_messages: usize,
    #[serde(default = "default_false")]
    pub container_package_installs_enabled: bool,
    #[serde(default = "default_container_required_permissions")]
    pub container_required_permissions: Vec<String>,
    #[serde(default = "default_image")]
    pub default_container_image: String,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            prefer_container_manager: true,
            enable_container_agents: true,
            child_spawn_enabled: true,
            child_spawn_max_depth: default_child_spawn_depth(),
            child_spawn_container_only: true,
            unsafe_host_communication_enabled: default_false(),
            hook_extensions_enabled: true,
            hook_extensions_container_only: true,
            socket_bus_enabled: true,
            socket_bus_container_only: true,
            socket_bus_max_channel_messages: default_socket_bus_max_channel_messages(),
            container_package_installs_enabled: default_false(),
            container_required_permissions: default_container_required_permissions(),
            default_container_image: default_image(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default = "default_auth_provider")]
    pub provider: String,
    #[serde(default)]
    pub login_command: Option<String>,
    #[serde(default)]
    pub logout_command: Option<String>,
    #[serde(default = "default_auth_session_file")]
    pub session_file: String,
    #[serde(default = "default_auth_token_env")]
    pub token_env: String,
    #[serde(default = "default_auth_user_env")]
    pub user_env: String,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            required: false,
            provider: default_auth_provider(),
            login_command: None,
            logout_command: None,
            session_file: default_auth_session_file(),
            token_env: default_auth_token_env(),
            user_env: default_auth_user_env(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default = "default_marketplace_source")]
    pub source: String,
    #[serde(default = "default_true")]
    pub send_task_events: bool,
}

impl Default for MarketplaceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: None,
            api_key_env: None,
            source: default_marketplace_source(),
            send_task_events: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectorConfig {
    #[serde(default)]
    pub auth_env: Vec<String>,
    #[serde(default)]
    pub allowed_resources: Vec<String>,
    #[serde(default)]
    pub host_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CommandCapabilityConfig {
    #[serde(default)]
    pub allow_spawn_child: bool,
    #[serde(default)]
    pub allow_hook_requests: bool,
    #[serde(default)]
    pub allow_network: bool,
    #[serde(default)]
    pub allow_filesystem: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CommandPermissionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_child: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_extensions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem_read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem_write: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_write: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playwright: Option<bool>,
}

impl CommandPermissionConfig {
    pub fn resolve(
        &self,
        allowed_actions: &[String],
        capabilities: &CommandCapabilityConfig,
    ) -> AgentPermissions {
        let default_create = action_allowed(allowed_actions, "create");
        let default_read = action_allowed(allowed_actions, "read");
        let default_update = action_allowed(allowed_actions, "update");
        let default_delete = action_allowed(allowed_actions, "delete");

        AgentPermissions {
            create: self.create.unwrap_or(default_create),
            read: self.read.unwrap_or(default_read),
            update: self.update.unwrap_or(default_update),
            delete: self.delete.unwrap_or(default_delete),
            spawn_child: self.spawn_child.unwrap_or(capabilities.allow_spawn_child),
            hook_extensions: self
                .hook_extensions
                .unwrap_or(capabilities.allow_hook_requests),
            network: self.network.unwrap_or(capabilities.allow_network),
            filesystem_read: self
                .filesystem_read
                .unwrap_or(capabilities.allow_filesystem),
            filesystem_write: self
                .filesystem_write
                .unwrap_or(capabilities.allow_filesystem),
            exec: self.exec.unwrap_or(false),
            memory_read: self.memory_read.unwrap_or(default_read),
            memory_write: self
                .memory_write
                .unwrap_or(default_create || default_update || default_delete),
            playwright: self.playwright.unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionConfig {
    pub command: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub auth_env: Vec<String>,
    #[serde(default)]
    pub allowed_actions: Vec<String>,
    #[serde(default)]
    pub capabilities: CommandCapabilityConfig,
    #[serde(default)]
    pub permissions: CommandPermissionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProfile {
    pub provider: String,
    pub model: String,
    #[serde(default = "default_api_layer")]
    pub api_layer: String,
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_cost")]
    pub max_cost_usd: f32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApiLayerConfig {
    #[serde(default = "default_layer_kind")]
    pub kind: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialConfig {
    #[serde(default)]
    pub provider: String,
    #[serde(default = "default_credential_mode")]
    pub mode: String,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub login_command: Option<String>,
    #[serde(default)]
    pub session_file: Option<String>,
}

impl Default for CredentialConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            mode: default_credential_mode(),
            env: Vec::new(),
            login_command: None,
            session_file: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    #[serde(default = "default_true")]
    pub always_split_crud: bool,
    #[serde(default = "default_high_risk")]
    pub high_risk_resources: Vec<String>,
    #[serde(default = "default_container_first")]
    pub container_first_resources: Vec<String>,
    #[serde(default = "default_profile_name")]
    pub default_profile: String,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            always_split_crud: true,
            high_risk_resources: default_high_risk(),
            container_first_resources: default_container_first(),
            default_profile: default_profile_name(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookConfig {
    #[serde(default = "default_hook_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub fail_open: bool,
    #[serde(default)]
    pub max_retries: u8,
    #[serde(default)]
    pub events: HashMap<String, HookEventConfig>,
    #[serde(default)]
    pub extensions: HashMap<String, HookExtensionConfig>,
}

impl Default for HookConfig {
    fn default() -> Self {
        Self {
            timeout_ms: default_hook_timeout_ms(),
            fail_open: false,
            max_retries: 0,
            events: HashMap::new(),
            extensions: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HookEventConfig {
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub fail_open: Option<bool>,
    #[serde(default)]
    pub max_retries: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookExtensionConfig {
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default = "default_hook_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub fail_open: bool,
    #[serde(default)]
    pub max_retries: u8,
}

impl Default for HookExtensionConfig {
    fn default() -> Self {
        Self {
            commands: Vec::new(),
            timeout_ms: default_hook_timeout_ms(),
            fail_open: false,
            max_retries: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginConfig {
    pub command: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub allowed_actions: Vec<String>,
    #[serde(default)]
    pub managed_only: bool,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub capabilities: CommandCapabilityConfig,
    #[serde(default)]
    pub permissions: CommandPermissionConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkillTargetConfig {
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SkillConfig {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub install_command: Option<String>,
    #[serde(default)]
    pub targets: SkillTargetConfig,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRegistryConfig {
    #[serde(default = "default_plugin_manifest_dirs")]
    pub manifest_dirs: Vec<String>,
    #[serde(default)]
    pub installed_manifests: HashMap<String, InstalledPluginManifest>,
}

impl Default for PluginRegistryConfig {
    fn default() -> Self {
        Self {
            manifest_dirs: default_plugin_manifest_dirs(),
            installed_manifests: default_installed_manifests(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstalledPluginManifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub manifest_path: String,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    pub ui_extensions: Vec<String>,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub resource_networks: Vec<String>,
    #[serde(default)]
    pub hook_extensions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePluginManifestDocument {
    #[serde(default)]
    api_version: String,
    #[serde(default)]
    plugins: Vec<RuntimePluginManifestPlugin>,
    #[serde(default)]
    ui_extensions: Vec<RuntimePluginManifestUiExtension>,
    #[serde(default)]
    services: Vec<RuntimePluginManifestService>,
    #[serde(default)]
    skills: Vec<RuntimePluginManifestSkill>,
    #[serde(default)]
    resource_networks: HashMap<String, String>,
    #[serde(default)]
    hook_extensions: Vec<RuntimePluginManifestHookExtension>,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePluginManifestPlugin {
    name: String,
    #[serde(flatten)]
    config: PluginConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePluginManifestUiExtension {
    name: String,
    #[serde(flatten)]
    config: UiExtensionConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePluginManifestService {
    name: String,
    #[serde(flatten)]
    config: OrchestratorServiceConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePluginManifestSkill {
    name: String,
    #[serde(flatten)]
    config: SkillConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimePluginManifestHookExtension {
    name: String,
    #[serde(flatten)]
    config: HookExtensionConfig,
}

pub fn resolve_path(path: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = path {
        return Ok(path.to_path_buf());
    }

    let workspace_default = Path::new("config/agent.toml").to_path_buf();
    if workspace_default.exists() {
        return Ok(workspace_default);
    }

    let user_default = expand_home("~/.pinokio-agent/config.toml")?;
    if user_default.exists() {
        return Ok(user_default);
    }

    Ok(user_default)
}

pub fn load(path: Option<&Path>) -> Result<AppConfig> {
    let target = resolve_path(path)?;
    if !target.exists() {
        let mut config = AppConfig::default();
        apply_runtime_compat_defaults(&mut config);
        hydrate_installed_manifest_entries(&mut config, target.parent());
        return Ok(config);
    }

    let raw = fs::read_to_string(&target)
        .with_context(|| format!("failed to read config at {}", target.display()))?;
    let mut parsed: AppConfig =
        toml::from_str(&raw).with_context(|| format!("failed to parse {}", target.display()))?;
    apply_runtime_compat_defaults(&mut parsed);
    refresh_generated_oauth_layer_commands(&mut parsed);
    hydrate_installed_manifest_entries(&mut parsed, target.parent());
    Ok(parsed)
}

pub fn save(path: Option<&Path>, config: &AppConfig) -> Result<PathBuf> {
    let target = resolve_path(path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;
    }
    let mut to_write = config.clone();
    strip_manifest_managed_entries(&mut to_write);
    let raw = toml::to_string_pretty(&to_write).context("failed to serialize config")?;
    fs::write(&target, raw).with_context(|| format!("failed to write {}", target.display()))?;
    Ok(target)
}

fn hydrate_installed_manifest_entries(config: &mut AppConfig, config_dir: Option<&Path>) {
    let installed = config.plugin_registry.installed_manifests.clone();
    for (_, manifest) in installed {
        let Some(path) = resolve_manifest_path(&manifest.manifest_path, config_dir) else {
            continue;
        };
        let Ok(doc) = load_runtime_manifest(&path) else {
            continue;
        };
        for plugin in doc.plugins {
            config.plugins.insert(plugin.name, plugin.config);
        }
        for extension in doc.ui_extensions {
            config
                .ui
                .extensions
                .insert(extension.name, extension.config);
        }
        for service in doc.services {
            config
                .orchestrator
                .services
                .insert(service.name, service.config);
        }
        for skill in doc.skills {
            config.skills.insert(skill.name, skill.config);
        }
        for (name, network) in doc.resource_networks {
            config.orchestrator.resource_networks.insert(name, network);
        }
        for extension in doc.hook_extensions {
            config
                .hooks
                .extensions
                .insert(extension.name, extension.config);
        }
    }
}

fn strip_manifest_managed_entries(config: &mut AppConfig) {
    for manifest in config.plugin_registry.installed_manifests.values() {
        for name in &manifest.plugins {
            config.plugins.remove(name);
        }
        for name in &manifest.ui_extensions {
            config.ui.extensions.remove(name);
        }
        for name in &manifest.services {
            config.orchestrator.services.remove(name);
        }
        for name in &manifest.skills {
            config.skills.remove(name);
        }
        for name in &manifest.resource_networks {
            config.orchestrator.resource_networks.remove(name);
        }
        for name in &manifest.hook_extensions {
            config.hooks.extensions.remove(name);
        }
    }
}

fn resolve_manifest_path(raw: &str, config_dir: Option<&Path>) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "~" || trimmed.starts_with("~/") {
        return expand_home(trimmed).ok();
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Some(path);
    }
    if let Some(dir) = config_dir {
        let candidate = dir.join(&path);
        if candidate.exists() {
            return Some(candidate);
        }
        if path.exists() {
            return Some(path);
        }
        return Some(candidate);
    }
    Some(path)
}

fn load_runtime_manifest(path: &Path) -> Result<RuntimePluginManifestDocument> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read manifest {}", path.display()))?;
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let doc: RuntimePluginManifestDocument = match ext.as_str() {
        "json" => serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse JSON manifest {}", path.display()))?,
        "yaml" | "yml" => serde_yaml::from_str(&raw)
            .with_context(|| format!("failed to parse YAML manifest {}", path.display()))?,
        _ => anyhow::bail!("unsupported manifest extension for {}", path.display()),
    };
    if !doc.api_version.is_empty() && !doc.api_version.eq_ignore_ascii_case("pinokio.plugin/v1") {
        anyhow::bail!(
            "unsupported manifest api_version '{}' for {}",
            doc.api_version,
            path.display()
        );
    }
    Ok(doc)
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

fn refresh_generated_oauth_layer_commands(config: &mut AppConfig) {
    if let Some(layer) = config.api_layers.get_mut("openai_codex") {
        if layer.kind.eq_ignore_ascii_case("command")
            && should_refresh_generated_oauth_command(layer.command.as_deref(), "codex")
        {
            layer.command = Some(codex_command_layer_command());
        }
    }
    if let Some(layer) = config.api_layers.get_mut("claude_code") {
        if layer.kind.eq_ignore_ascii_case("command")
            && should_refresh_generated_oauth_command(layer.command.as_deref(), "claude")
        {
            layer.command = Some(claude_code_command_layer_command());
        }
    }
}

fn should_refresh_generated_oauth_command(existing: Option<&str>, marker: &str) -> bool {
    let Some(command) = existing else {
        return true;
    };
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return true;
    }
    trimmed.contains("PINOKIO_OAUTH_BIN") && trimmed.contains(marker)
}

fn default_image() -> String {
    "ghcr.io/pinokio-ai/pinokio-agent-micro:local".to_string()
}

fn default_container_required_permissions() -> Vec<String> {
    vec!["playwright".to_string(), "filesystem_write".to_string()]
}

fn default_socket_bus_max_channel_messages() -> usize {
    256
}

fn default_child_spawn_depth() -> u8 {
    6
}

fn apply_runtime_compat_defaults(config: &mut AppConfig) {
    // Plugin-first chat + directory orchestration can require up to:
    // chat -> worker -> explorer -> read -> write -> write(apply socket).
    // Keep this automatic for older consumer configs that still use lower depth values.
    if config.manager.child_spawn_max_depth < 6 {
        config.manager.child_spawn_max_depth = 6;
    }
    ensure_plugin_first_system_prompts(config);
}

fn ensure_plugin_first_system_prompts(config: &mut AppConfig) {
    const DIRECTIVE: &str =
        "Before using local or host methods, check installed plugins and systems first and route through them when possible.";
    let directive_lc = DIRECTIVE.to_ascii_lowercase();
    for profile in config.llm_profiles.values_mut() {
        match &mut profile.system_prompt {
            Some(prompt) => {
                if prompt.to_ascii_lowercase().contains(&directive_lc) {
                    continue;
                }
                if !prompt.trim().is_empty() {
                    prompt.push(' ');
                }
                prompt.push_str(DIRECTIVE);
            }
            None => {
                profile.system_prompt = Some(DIRECTIVE.to_string());
            }
        }
    }
}

fn action_allowed(allowed_actions: &[String], action: &str) -> bool {
    allowed_actions.is_empty()
        || allowed_actions
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(action))
}

fn default_hook_timeout_ms() -> u64 {
    10_000
}

fn default_max_tokens() -> u32 {
    2000
}

fn default_cost() -> f32 {
    0.25
}

fn default_temperature() -> f32 {
    0.2
}

fn default_api_layer() -> String {
    "openai_codex".to_string()
}

fn default_layer_kind() -> String {
    "openai_compatible".to_string()
}

fn default_credential_mode() -> String {
    "api_key".to_string()
}

fn default_profile_name() -> String {
    "default".to_string()
}

fn default_auth_provider() -> String {
    "none".to_string()
}

fn default_auth_session_file() -> String {
    "~/.pinokio-agent/session.json".to_string()
}

fn default_auth_token_env() -> String {
    "PINOKIO_AUTH_TOKEN".to_string()
}

fn default_auth_user_env() -> String {
    "PINOKIO_AUTH_USER".to_string()
}

fn default_marketplace_source() -> String {
    "oss".to_string()
}

fn default_orchestrator_backend() -> String {
    "auto".to_string()
}

fn default_orchestrator_default_image() -> String {
    "ghcr.io/pinokio-ai/pinokio-agent-micro:local".to_string()
}

fn default_orchestrator_services() -> HashMap<String, OrchestratorServiceConfig> {
    HashMap::new()
}

fn default_orchestrator_resource_networks() -> HashMap<String, String> {
    HashMap::new()
}

fn default_orchestrator_entrypoint() -> String {
    "/usr/local/bin/pinokio-agent".to_string()
}

fn default_allowed_image_prefixes() -> Vec<String> {
    vec![
        "ghcr.io/pinokio-ai/".to_string(),
        "docker.io/library/alpine".to_string(),
        "mcr.microsoft.com/playwright".to_string(),
        "alpine:".to_string(),
    ]
}

fn default_orchestrator_mounts() -> Vec<String> {
    vec!["/tmp:/tmp".to_string()]
}

fn default_workspace_mount_path() -> String {
    "/app".to_string()
}

fn default_orchestrator_managed_network() -> String {
    "pinokio-agent-net".to_string()
}

fn default_orchestrator_dns_servers() -> Vec<String> {
    vec!["1.1.1.1".to_string(), "8.8.8.8".to_string()]
}

fn default_orchestrator_swarm_poll_ms() -> u64 {
    1000
}

fn default_service_restart_policy() -> String {
    "unless-stopped".to_string()
}

fn default_service_ready_timeout_secs() -> u64 {
    60
}

fn default_playwright_auto_install() -> bool {
    true
}

fn default_playwright_user_context_dir() -> String {
    "~/.pinokio-agent/playwright-profile".to_string()
}

fn default_playwright_user_context_domain_allowlist() -> Vec<String> {
    vec![
        "mail.google.com".to_string(),
        "accounts.google.com".to_string(),
        "gmail.com".to_string(),
        "outlook.live.com".to_string(),
        "login.live.com".to_string(),
        "live.com".to_string(),
        "outlook.com".to_string(),
        "hotmail.com".to_string(),
        "outlook.office.com".to_string(),
        "office.com".to_string(),
        "account.microsoft.com".to_string(),
        "twitch.tv".to_string(),
        "x.com".to_string(),
        "twitter.com".to_string(),
        "linkedin.com".to_string(),
        "facebook.com".to_string(),
        "instagram.com".to_string(),
        "discord.com".to_string(),
        "slack.com".to_string(),
    ]
}

fn default_playwright_auth_domain_hints() -> Vec<String> {
    vec![
        "mail.google.com".to_string(),
        "outlook.live.com".to_string(),
        "login.live.com".to_string(),
        "gmail.com".to_string(),
        "hotmail.com".to_string(),
        "outlook.com".to_string(),
        "twitch.tv".to_string(),
        "x.com".to_string(),
        "twitter.com".to_string(),
        "linkedin.com".to_string(),
        "facebook.com".to_string(),
        "instagram.com".to_string(),
        "discord.com".to_string(),
        "slack.com".to_string(),
    ]
}

fn default_playwright_node_setup_command() -> String {
    "npm install --omit=dev".to_string()
}

fn default_playwright_install_command() -> String {
    "npx playwright install chromium".to_string()
}

fn default_playwright_host_service_command() -> String {
    "node workers/playwright-service.ts".to_string()
}

fn default_playwright_timeout_ms() -> u64 {
    45000
}

fn default_ui_host() -> String {
    "localhost".to_string()
}

fn default_ui_port() -> u16 {
    5173
}

fn default_ui_setup_command() -> String {
    "npm --prefix ui install --no-audit --no-fund --silent".to_string()
}

fn default_ui_build_on_start() -> bool {
    false
}

fn default_ui_build_command() -> String {
    "npm --prefix ui run build".to_string()
}

fn default_ui_serve_command() -> String {
    "npm --prefix ui run dev -- --host {host} --port {port}".to_string()
}

fn default_ui_https_enabled() -> bool {
    true
}

fn default_ui_auto_trust_local_https() -> bool {
    true
}

fn default_ui_pages_dir() -> String {
    "~/.pinokio-agent/ui-pages".to_string()
}

fn default_ui_max_page_bytes() -> u64 {
    262_144
}

fn default_ui_extension_kind() -> String {
    "systems".to_string()
}

fn default_ui_extension_slot() -> String {
    "settings".to_string()
}

fn default_ui_extension_order() -> i32 {
    100
}

fn default_plugin_manifest_dirs() -> Vec<String> {
    vec![
        "plugin-manifests".to_string(),
        "plugins/manifests".to_string(),
        "plugins".to_string(),
        "~/.pinokio-agent/plugin-manifests".to_string(),
    ]
}

fn default_installed_manifests() -> HashMap<String, InstalledPluginManifest> {
    let mut out = HashMap::new();
    out.insert(
        "pinokio.chat".to_string(),
        InstalledPluginManifest {
            name: "Chat Agents".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/chat/manifest.json".to_string(),
            plugins: vec!["chat_agent".to_string(), "chat_worker_agent".to_string()],
            ui_extensions: vec!["chat".to_string()],
            services: Vec::new(),
            skills: vec!["chat.orchestrator".to_string()],
            resource_networks: vec![
                "plugin:chat_agent".to_string(),
                "plugin:chat_worker_agent".to_string(),
            ],
            hook_extensions: Vec::new(),
        },
    );
    out.insert(
        "pinokio.database".to_string(),
        InstalledPluginManifest {
            name: "Database Core".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/database/manifest.json".to_string(),
            plugins: vec![
                "postgres_agent".to_string(),
                "db_router_agent".to_string(),
                "db_read_agent".to_string(),
                "db_write_agent".to_string(),
                "db_create_agent".to_string(),
                "db_update_agent".to_string(),
                "db_delete_agent".to_string(),
            ],
            ui_extensions: Vec::new(),
            services: vec!["postgres_main".to_string()],
            skills: vec!["db.router".to_string()],
            resource_networks: Vec::new(),
            hook_extensions: Vec::new(),
        },
    );
    out.insert(
        "pinokio.memory".to_string(),
        InstalledPluginManifest {
            name: "Memory System".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/memory/manifest.json".to_string(),
            plugins: vec!["memory_agent".to_string()],
            ui_extensions: Vec::new(),
            services: Vec::new(),
            skills: vec!["memory.indexing".to_string()],
            resource_networks: Vec::new(),
            hook_extensions: Vec::new(),
        },
    );
    out.insert(
        "pinokio.explorer".to_string(),
        InstalledPluginManifest {
            name: "Directory Plugin".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/explorer/manifest.json".to_string(),
            plugins: vec![
                "explorer_agent".to_string(),
                "explorer_read_agent".to_string(),
                "explorer_write_agent".to_string(),
            ],
            ui_extensions: Vec::new(),
            services: Vec::new(),
            skills: vec!["explorer.safe_ops".to_string()],
            resource_networks: Vec::new(),
            hook_extensions: Vec::new(),
        },
    );
    out.insert(
        "pinokio.playwright".to_string(),
        InstalledPluginManifest {
            name: "Playwright Browser Automation".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/playwright/manifest.json".to_string(),
            plugins: vec![
                "playwright_agent".to_string(),
                "playwright_read_agent".to_string(),
                "playwright_write_agent".to_string(),
                "playwright_unsafe_agent".to_string(),
            ],
            ui_extensions: Vec::new(),
            services: Vec::new(),
            skills: vec!["playwright.discovery_split".to_string()],
            resource_networks: Vec::new(),
            hook_extensions: Vec::new(),
        },
    );
    out.insert(
        "pinokio.unsafe_host".to_string(),
        InstalledPluginManifest {
            name: "Unsafe Host Agent".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/unsafe-host/manifest.json".to_string(),
            plugins: vec!["unsafe_host_agent".to_string()],
            ui_extensions: Vec::new(),
            services: Vec::new(),
            skills: vec!["unsafe.host_ops".to_string()],
            resource_networks: Vec::new(),
            hook_extensions: Vec::new(),
        },
    );
    out.insert(
        "pinokio.echo".to_string(),
        InstalledPluginManifest {
            name: "Echo".to_string(),
            version: "1.0.0".to_string(),
            manifest_path: "plugins/echo/manifest.json".to_string(),
            plugins: vec!["echo".to_string()],
            ui_extensions: Vec::new(),
            services: Vec::new(),
            skills: vec!["echo.basic".to_string()],
            resource_networks: Vec::new(),
            hook_extensions: Vec::new(),
        },
    );
    out
}

fn default_high_risk() -> Vec<String> {
    vec![
        "bank".to_string(),
        "email".to_string(),
        "twitter".to_string(),
        "filesystem".to_string(),
    ]
}

fn default_container_first() -> Vec<String> {
    vec!["filesystem".to_string(), "plugins".to_string()]
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
