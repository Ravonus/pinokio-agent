use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::bootstrap::{
    ensure_services as bootstrap_ensure_services, service_statuses, ManagedServiceStatus,
};
use crate::config::{
    save as save_config, ApiLayerConfig, AppConfig, CredentialConfig, HookExtensionConfig,
    InstalledPluginManifest, LlmProfile, OrchestratorServiceConfig, PluginConfig, SkillConfig,
    SkillTargetConfig, UiExtensionConfig,
};
use crate::credentials::{self, CredentialStatus};
use crate::llm::resolve_profile;
use crate::model::AgentPermissions;
use crate::oauth_cli::{claude_code_command_layer_command, codex_command_layer_command};

#[derive(Debug, Clone, Serialize)]
pub struct ConfigureDoctorReport {
    pub ok: bool,
    pub credentials: Vec<CredentialStatus>,
    pub profile_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiExtensionSurface {
    pub name: String,
    pub kind: String,
    pub slot: String,
    pub title: String,
    pub detail: String,
    pub route: Option<String>,
    pub order: i32,
    pub source: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginCatalogReport {
    pub manifest_dirs: Vec<String>,
    pub manifests: Vec<PluginManifestSummary>,
    pub parse_errors: Vec<String>,
    pub installed_manifests: Vec<String>,
    pub configured_plugins: Vec<ConfiguredPluginSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginManifestSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub readme: Option<String>,
    pub manifest_path: String,
    pub manifest_format: String,
    pub requires: PluginManifestRequires,
    pub runtime: PluginManifestRuntime,
    pub extends: PluginManifestExtends,
    pub plugin_count: usize,
    pub ui_extension_count: usize,
    pub service_count: usize,
    pub skill_count: usize,
    pub resource_network_count: usize,
    pub hook_extension_count: usize,
    pub install: PluginManifestInstallPlan,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInstallPreview {
    pub manifest: PluginManifestSummary,
    pub plugins: Vec<PluginPermissionSummary>,
    pub ui_extensions: Vec<String>,
    pub services: Vec<String>,
    pub skills: Vec<PluginSkillSummary>,
    pub resource_networks: Vec<String>,
    pub hook_extensions: Vec<String>,
    pub install_commands: Vec<PluginInstallCommandSummary>,
    pub missing_dependencies: Vec<String>,
    pub conflicts: Vec<String>,
    pub adoptable_conflicts: Vec<String>,
    pub blocking_conflicts: Vec<String>,
    pub warnings: Vec<String>,
    pub can_install: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInstallResult {
    pub ok: bool,
    pub manifest_id: String,
    pub manifest_name: String,
    pub installed_plugins: Vec<String>,
    pub installed_ui_extensions: Vec<String>,
    pub installed_services: Vec<String>,
    pub installed_skills: Vec<String>,
    pub installed_resource_networks: Vec<String>,
    pub installed_hook_extensions: Vec<String>,
    pub install_command_results: Vec<PluginInstallCommandResult>,
    pub preview: PluginInstallPreview,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginRemoveResult {
    pub ok: bool,
    pub manifest_id: String,
    pub removed_plugins: Vec<String>,
    pub removed_ui_extensions: Vec<String>,
    pub removed_services: Vec<String>,
    pub removed_skills: Vec<String>,
    pub removed_resource_networks: Vec<String>,
    pub removed_hook_extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginPermissionSummary {
    pub name: String,
    pub host_only: bool,
    pub managed_only: bool,
    pub allowed_actions: Vec<String>,
    pub dependencies: Vec<String>,
    pub resolved_permissions: AgentPermissions,
    pub risk_flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginSkillSummary {
    pub name: String,
    pub description: String,
    pub path: String,
    pub install_command: Option<String>,
    pub targets: SkillTargetConfig,
    pub tags: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInstallCommandSummary {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_manifest_install_scope")]
    pub scope: String,
    pub command: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dangerous: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInstallCommandResult {
    pub id: String,
    pub scope: String,
    pub command: String,
    pub ok: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub path: String,
    pub install_command: Option<String>,
    pub targets: SkillTargetConfig,
    pub tags: Vec<String>,
    pub enabled: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfiguredPluginSummary {
    pub name: String,
    pub command: String,
    pub host_only: bool,
    pub managed_only: bool,
    pub allowed_actions: Vec<String>,
    pub dependencies: Vec<String>,
    pub resolved_permissions: AgentPermissions,
    pub risk_flags: Vec<String>,
    pub manifest_owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginManifestRequires {
    #[serde(default)]
    pub manifests: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    pub services: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifestRuntime {
    #[serde(default = "default_manifest_runtime_mode")]
    pub mode: String,
    #[serde(default)]
    pub requires_container: bool,
    #[serde(default)]
    pub unsafe_host_access: bool,
}

impl Default for PluginManifestRuntime {
    fn default() -> Self {
        Self {
            mode: default_manifest_runtime_mode(),
            requires_container: false,
            unsafe_host_access: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginManifestExtends {
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub containers: Vec<String>,
    #[serde(default)]
    pub navigation: Vec<String>,
    #[serde(default)]
    pub settings: Vec<String>,
    #[serde(default)]
    pub pages: Vec<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub hooks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginManifestInstallPlan {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub commands: Vec<PluginInstallCommandSummary>,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestDocument {
    #[serde(default = "default_manifest_api_version")]
    api_version: String,
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    readme: Option<String>,
    #[serde(default)]
    requires: PluginManifestRequires,
    #[serde(default)]
    runtime: PluginManifestRuntime,
    #[serde(default)]
    extends: PluginManifestExtends,
    #[serde(default)]
    plugins: Vec<PluginManifestPlugin>,
    #[serde(default)]
    ui_extensions: Vec<PluginManifestUiExtension>,
    #[serde(default)]
    services: Vec<PluginManifestService>,
    #[serde(default)]
    skills: Vec<PluginManifestSkill>,
    #[serde(default)]
    resource_networks: HashMap<String, String>,
    #[serde(default)]
    hook_extensions: Vec<PluginManifestHookExtension>,
    #[serde(default)]
    install: PluginManifestInstallPlan,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestPlugin {
    name: String,
    #[serde(flatten)]
    config: PluginConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestUiExtension {
    name: String,
    #[serde(flatten)]
    config: UiExtensionConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestService {
    name: String,
    #[serde(flatten)]
    config: OrchestratorServiceConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestSkill {
    name: String,
    #[serde(flatten)]
    config: SkillConfig,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginManifestHookExtension {
    name: String,
    #[serde(flatten)]
    config: HookExtensionConfig,
}

#[derive(Debug, Clone)]
struct ResolvedPluginManifest {
    doc: PluginManifestDocument,
    path: PathBuf,
    format: String,
}

pub fn configure_openai(
    config: &mut AppConfig,
    credential_name: &str,
    api_key: &str,
    profile_name: Option<&str>,
    layer_name: &str,
) -> Result<CredentialStatus> {
    upsert_credential(
        config,
        credential_name,
        CredentialConfig {
            provider: "openai".to_string(),
            mode: "api_key".to_string(),
            env: vec!["OPENAI_API_KEY".to_string()],
            login_command: None,
            session_file: None,
        },
    );

    upsert_layer(
        config,
        layer_name,
        ApiLayerConfig {
            kind: "openai_compatible".to_string(),
            base_url: Some("https://api.openai.com".to_string()),
            credential: Some(credential_name.to_string()),
            command: None,
            headers: Default::default(),
        },
    );

    if let Some(profile_name) = profile_name {
        bind_profile_credential(config, profile_name, credential_name)?;
    }

    credentials::store_token_for_credential(config, credential_name, api_key, None)
}

pub fn configure_claude_api(
    config: &mut AppConfig,
    credential_name: &str,
    api_key: &str,
    profile_name: Option<&str>,
    layer_name: &str,
) -> Result<CredentialStatus> {
    upsert_credential(
        config,
        credential_name,
        CredentialConfig {
            provider: "anthropic".to_string(),
            mode: "api_key".to_string(),
            env: vec!["ANTHROPIC_API_KEY".to_string()],
            login_command: None,
            session_file: None,
        },
    );

    upsert_layer(
        config,
        layer_name,
        ApiLayerConfig {
            kind: "anthropic_messages".to_string(),
            base_url: Some("https://api.anthropic.com".to_string()),
            credential: Some(credential_name.to_string()),
            command: None,
            headers: Default::default(),
        },
    );

    if let Some(profile_name) = profile_name {
        bind_profile_credential(config, profile_name, credential_name)?;
    }

    credentials::store_token_for_credential(config, credential_name, api_key, None)
}

pub fn configure_claude_code(
    config: &mut AppConfig,
    credential_name: &str,
    token: Option<&str>,
    oauth_command: Option<&str>,
    profile_name: Option<&str>,
    layer_name: &str,
) -> Result<Option<CredentialStatus>> {
    upsert_credential(
        config,
        credential_name,
        CredentialConfig {
            provider: "claude_code".to_string(),
            mode: if oauth_command.is_some() {
                "oauth_command".to_string()
            } else {
                "api_key".to_string()
            },
            env: vec!["ANTHROPIC_API_KEY".to_string()],
            login_command: oauth_command.map(|s| s.to_string()),
            session_file: None,
        },
    );

    upsert_layer(
        config,
        layer_name,
        ApiLayerConfig {
            kind: "command".to_string(),
            base_url: None,
            credential: Some(credential_name.to_string()),
            command: Some(claude_code_command_layer_command()),
            headers: Default::default(),
        },
    );

    if let Some(profile_name) = profile_name {
        bind_profile_credential(config, profile_name, credential_name)?;
        set_profile_fallback(config, profile_name, None)?;
    }

    if let Some(token) = token {
        let status = credentials::store_token_for_credential(config, credential_name, token, None)?;
        return Ok(Some(status));
    }

    Ok(None)
}

pub fn configure_codex(
    config: &mut AppConfig,
    credential_name: &str,
    token: Option<&str>,
    oauth_command: Option<&str>,
    profile_name: Option<&str>,
    layer_name: &str,
) -> Result<Option<CredentialStatus>> {
    // Explicit token mode: configure as OpenAI-compatible credentialed profile.
    if let Some(token) = token {
        upsert_credential(
            config,
            credential_name,
            CredentialConfig {
                provider: "openai_codex".to_string(),
                mode: "api_key".to_string(),
                env: vec!["OPENAI_API_KEY".to_string()],
                login_command: oauth_command.map(|s| s.to_string()),
                session_file: None,
            },
        );

        upsert_layer(
            config,
            layer_name,
            ApiLayerConfig {
                kind: "openai_compatible".to_string(),
                base_url: Some("https://api.openai.com".to_string()),
                credential: Some(credential_name.to_string()),
                command: None,
                headers: Default::default(),
            },
        );

        if let Some(profile_name) = profile_name {
            bind_profile_credential(config, profile_name, credential_name)?;
        }

        let status = credentials::store_token_for_credential(config, credential_name, token, None)?;
        return Ok(Some(status));
    }

    // OAuth CLI mode: Codex manages auth internally via `codex login`.
    upsert_credential(
        config,
        credential_name,
        CredentialConfig {
            provider: "openai_codex".to_string(),
            mode: "oauth_cli".to_string(),
            env: vec![],
            login_command: oauth_command.map(|s| s.to_string()),
            session_file: None,
        },
    );

    upsert_layer(
        config,
        layer_name,
        ApiLayerConfig {
            kind: "command".to_string(),
            base_url: None,
            credential: None,
            command: Some(codex_command_layer_command()),
            headers: Default::default(),
        },
    );

    if let Some(profile_name) = profile_name {
        clear_profile_credential(config, profile_name)?;
        set_profile_fallback(config, profile_name, None)?;
    }

    Ok(None)
}

pub fn login_credential(config: &AppConfig, credential_name: &str) -> Result<CredentialStatus> {
    credentials::login_credential(config, credential_name)
}

pub fn status(config: &AppConfig) -> Result<Vec<CredentialStatus>> {
    credentials::statuses(config)
}

pub fn services(config: &AppConfig) -> Result<Vec<ManagedServiceStatus>> {
    service_statuses(config)
}

pub fn ensure_services(
    config: &AppConfig,
    names: Option<&[String]>,
) -> Result<Vec<ManagedServiceStatus>> {
    bootstrap_ensure_services(config, names)
}

pub fn doctor(config: &AppConfig) -> Result<ConfigureDoctorReport> {
    let credentials = credentials::statuses(config)?;
    let mut profile_errors = Vec::new();

    for profile_name in config.llm_profiles.keys() {
        if let Err(err) = resolve_profile(config, profile_name) {
            profile_errors.push(format!("profile {}: {}", profile_name, err));
        }
    }

    Ok(ConfigureDoctorReport {
        ok: profile_errors.is_empty(),
        credentials,
        profile_errors,
    })
}

pub fn save(path: Option<&Path>, config: &AppConfig) -> Result<String> {
    let path = save_config(path, config)?;
    Ok(path.display().to_string())
}

pub fn list_ui_extensions(config: &AppConfig) -> Vec<UiExtensionSurface> {
    let mut out = Vec::new();

    out.push(UiExtensionSurface {
        name: "credentials".to_string(),
        kind: "core".to_string(),
        slot: "settings".to_string(),
        title: "Credentials".to_string(),
        detail: "OpenAI/Claude credential setup and auth sessions.".to_string(),
        route: Some("/ui/configure/credentials".to_string()),
        order: 10,
        source: "core".to_string(),
        enabled: true,
    });
    out.push(UiExtensionSurface {
        name: "manager".to_string(),
        kind: "systems".to_string(),
        slot: "settings".to_string(),
        title: "Manager".to_string(),
        detail: "Manager-level configure and doctor controls.".to_string(),
        route: Some("/ui/configure".to_string()),
        order: 20,
        source: "core".to_string(),
        enabled: true,
    });

    for name in config.plugins.keys() {
        out.push(UiExtensionSurface {
            name: name.clone(),
            kind: "plugins".to_string(),
            slot: "settings".to_string(),
            title: name.clone(),
            detail: "Plugin extension surface.".to_string(),
            route: Some("/ui/configure/extensions".to_string()),
            order: 50,
            source: "derived".to_string(),
            enabled: true,
        });
    }

    for name in config.connections.keys() {
        out.push(UiExtensionSurface {
            name: format!("connection:{}", name),
            kind: "systems".to_string(),
            slot: "settings".to_string(),
            title: format!("Connection {}", name),
            detail: "External system connection extension surface.".to_string(),
            route: Some("/ui/configure/extensions".to_string()),
            order: 60,
            source: "derived".to_string(),
            enabled: true,
        });
    }

    for (name, service) in &config.orchestrator.services {
        out.push(UiExtensionSurface {
            name: format!("service:{}", name),
            kind: "systems".to_string(),
            slot: "settings".to_string(),
            title: format!("Service {}", name),
            detail: format!(
                "Managed service container (image={}, enabled={})",
                service.image, service.enabled
            ),
            route: Some("/ui/configure/diagnostics".to_string()),
            order: 65,
            source: "derived".to_string(),
            enabled: service.enabled,
        });
    }

    for name in config.llm_profiles.keys() {
        out.push(UiExtensionSurface {
            name: name.clone(),
            kind: "agents".to_string(),
            slot: "settings".to_string(),
            title: name.clone(),
            detail: "LLM profile binding surface for agents.".to_string(),
            route: Some("/ui/configure/extensions".to_string()),
            order: 70,
            source: "derived".to_string(),
            enabled: true,
        });
    }

    for (name, extension) in &config.ui.extensions {
        let slot = normalize_extension_slot(&extension.slot);
        out.push(UiExtensionSurface {
            name: name.clone(),
            kind: normalize_extension_kind(&extension.kind),
            slot,
            title: extension.title.clone().unwrap_or_else(|| name.clone()),
            detail: extension
                .detail
                .clone()
                .unwrap_or_else(|| "Custom UI extension".to_string()),
            route: extension.route.clone(),
            order: extension.order,
            source: "configured".to_string(),
            enabled: extension.enabled,
        });
    }

    out.sort_by(|a, b| {
        a.order
            .cmp(&b.order)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

pub fn upsert_ui_extension(
    config: &mut AppConfig,
    name: &str,
    kind: &str,
    slot: Option<&str>,
    title: Option<&str>,
    detail: Option<&str>,
    route: Option<&str>,
    order: Option<i32>,
    enabled: bool,
) -> UiExtensionSurface {
    let normalized_kind = normalize_extension_kind(kind);
    let normalized_slot = normalize_extension_slot(slot.unwrap_or("settings"));
    let extension = UiExtensionConfig {
        kind: normalized_kind.clone(),
        slot: normalized_slot.clone(),
        title: title.map(|v| v.to_string()),
        detail: detail.map(|v| v.to_string()),
        route: route.map(|v| v.to_string()),
        order: order.unwrap_or(100),
        enabled,
    };
    config
        .ui
        .extensions
        .insert(name.to_string(), extension.clone());

    UiExtensionSurface {
        name: name.to_string(),
        kind: normalized_kind,
        slot: normalized_slot,
        title: extension.title.clone().unwrap_or_else(|| name.to_string()),
        detail: extension
            .detail
            .unwrap_or_else(|| "Custom UI extension".to_string()),
        route: extension.route,
        order: extension.order,
        source: "configured".to_string(),
        enabled,
    }
}

pub fn remove_ui_extension(config: &mut AppConfig, name: &str) -> bool {
    config.ui.extensions.remove(name).is_some()
}

pub fn list_skills(config: &AppConfig) -> Vec<SkillSummary> {
    let owners = installed_skill_owners(config);
    let mut out = config
        .skills
        .iter()
        .map(|(name, skill)| SkillSummary {
            name: name.clone(),
            description: skill.description.clone(),
            path: skill.path.clone(),
            install_command: skill.install_command.clone(),
            targets: skill.targets.clone(),
            tags: skill.tags.clone(),
            enabled: skill.enabled,
            source: owners
                .get(name)
                .map(|owner| format!("manifest:{}", owner))
                .unwrap_or_else(|| "config".to_string()),
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub fn upsert_skill(
    config: &mut AppConfig,
    name: &str,
    skill: SkillConfig,
    run_install: bool,
) -> Result<SkillSummary> {
    let normalized = name.trim();
    if normalized.is_empty() {
        anyhow::bail!("skill name is required");
    }

    if run_install {
        if let Some(command) = skill.install_command.as_deref() {
            let (code, output) = run_shell_command_capture(command)?;
            if code != 0 {
                anyhow::bail!(
                    "skill install command failed for '{}': {}",
                    normalized,
                    output.trim()
                );
            }
        }
    }

    config.skills.insert(normalized.to_string(), skill.clone());

    Ok(SkillSummary {
        name: normalized.to_string(),
        description: skill.description,
        path: skill.path,
        install_command: skill.install_command,
        targets: skill.targets,
        tags: skill.tags,
        enabled: skill.enabled,
        source: "config".to_string(),
    })
}

pub fn remove_skill(config: &mut AppConfig, name: &str) -> bool {
    config.skills.remove(name.trim()).is_some()
}

pub fn plugin_catalog(config: &AppConfig) -> Result<PluginCatalogReport> {
    let (manifests, parse_errors) = discover_plugin_manifests(config);
    let mut summaries = manifests
        .iter()
        .map(|manifest| manifest_to_summary(config, manifest))
        .collect::<Vec<_>>();
    summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let mut installed_manifests = config
        .plugin_registry
        .installed_manifests
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    installed_manifests.sort();

    let owners = installed_plugin_owners(config);
    let mut configured_plugins = config
        .plugins
        .iter()
        .map(|(name, plugin)| {
            let resolved = plugin
                .permissions
                .resolve(&plugin.allowed_actions, &plugin.capabilities);
            ConfiguredPluginSummary {
                name: name.clone(),
                command: plugin.command.clone(),
                host_only: plugin.host_only,
                managed_only: plugin.managed_only,
                allowed_actions: plugin.allowed_actions.clone(),
                dependencies: plugin.dependencies.clone(),
                resolved_permissions: resolved.clone(),
                risk_flags: permission_risk_flags(plugin.host_only, &resolved),
                manifest_owner: owners.get(name).cloned(),
            }
        })
        .collect::<Vec<_>>();
    configured_plugins.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(PluginCatalogReport {
        manifest_dirs: config.plugin_registry.manifest_dirs.clone(),
        manifests: summaries,
        parse_errors,
        installed_manifests,
        configured_plugins,
    })
}

pub fn plugin_preview(config: &AppConfig, manifest_ref: &str) -> Result<PluginInstallPreview> {
    let resolved = resolve_manifest_reference(config, manifest_ref)?;
    build_install_preview(config, &resolved)
}

pub fn plugin_install(
    config: &mut AppConfig,
    manifest_ref: &str,
    allow_missing_dependencies: bool,
    adopt_existing: bool,
    run_install_commands: bool,
) -> Result<PluginInstallResult> {
    let resolved = resolve_manifest_reference(config, manifest_ref)?;
    let preview = build_install_preview(config, &resolved)?;
    let effective_conflicts = if adopt_existing {
        preview.blocking_conflicts.clone()
    } else {
        preview.conflicts.clone()
    };
    if !effective_conflicts.is_empty() {
        anyhow::bail!(
            "plugin package '{}' has conflicts: {}",
            preview.manifest.id,
            effective_conflicts.join("; ")
        );
    }
    if !allow_missing_dependencies && !preview.missing_dependencies.is_empty() {
        anyhow::bail!(
            "plugin package '{}' has missing dependencies: {}",
            preview.manifest.id,
            preview.missing_dependencies.join(", ")
        );
    }

    let manifest = &resolved.doc;
    let manifest_path = fs::canonicalize(&resolved.path)
        .unwrap_or_else(|_| resolved.path.clone())
        .display()
        .to_string();
    let mut resource_network_names = manifest
        .resource_networks
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    resource_network_names.sort();
    let mut hook_extension_names = manifest
        .hook_extensions
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    hook_extension_names.sort();
    let mut skill_names = manifest
        .skills
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    skill_names.sort();
    let install_command_results = if run_install_commands {
        run_manifest_install_commands(manifest)?
    } else {
        Vec::new()
    };

    for entry in &manifest.plugins {
        config
            .plugins
            .insert(entry.name.clone(), entry.config.clone());
    }
    for entry in &manifest.ui_extensions {
        config
            .ui
            .extensions
            .insert(entry.name.clone(), entry.config.clone());
    }
    for entry in &manifest.services {
        config
            .orchestrator
            .services
            .insert(entry.name.clone(), entry.config.clone());
    }
    for entry in &manifest.skills {
        config
            .skills
            .insert(entry.name.clone(), entry.config.clone());
    }
    for (name, network) in &manifest.resource_networks {
        config
            .orchestrator
            .resource_networks
            .insert(name.clone(), network.clone());
    }
    for entry in &manifest.hook_extensions {
        config
            .hooks
            .extensions
            .insert(entry.name.clone(), entry.config.clone());
    }

    config.plugin_registry.installed_manifests.insert(
        manifest.id.clone(),
        InstalledPluginManifest {
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            manifest_path,
            plugins: manifest
                .plugins
                .iter()
                .map(|entry| entry.name.clone())
                .collect(),
            ui_extensions: manifest
                .ui_extensions
                .iter()
                .map(|entry| entry.name.clone())
                .collect(),
            services: manifest
                .services
                .iter()
                .map(|entry| entry.name.clone())
                .collect(),
            skills: skill_names.clone(),
            resource_networks: resource_network_names.clone(),
            hook_extensions: hook_extension_names.clone(),
        },
    );

    Ok(PluginInstallResult {
        ok: true,
        manifest_id: manifest.id.clone(),
        manifest_name: manifest.name.clone(),
        installed_plugins: manifest
            .plugins
            .iter()
            .map(|entry| entry.name.clone())
            .collect(),
        installed_ui_extensions: manifest
            .ui_extensions
            .iter()
            .map(|entry| entry.name.clone())
            .collect(),
        installed_services: manifest
            .services
            .iter()
            .map(|entry| entry.name.clone())
            .collect(),
        installed_skills: skill_names,
        installed_resource_networks: resource_network_names,
        installed_hook_extensions: hook_extension_names,
        install_command_results,
        preview,
    })
}

pub fn plugin_remove(config: &mut AppConfig, manifest_id: &str) -> Result<PluginRemoveResult> {
    let normalized = manifest_id.trim();
    if normalized.is_empty() {
        anyhow::bail!("plugin package id is required");
    }

    let Some(installed) = config
        .plugin_registry
        .installed_manifests
        .get(normalized)
        .cloned()
    else {
        anyhow::bail!("plugin package '{}' is not installed", normalized);
    };

    let mut removed_plugins = Vec::new();
    for plugin_name in &installed.plugins {
        if config.plugins.remove(plugin_name).is_some() {
            removed_plugins.push(plugin_name.clone());
        }
    }

    let mut removed_ui_extensions = Vec::new();
    for extension_name in &installed.ui_extensions {
        if config.ui.extensions.remove(extension_name).is_some() {
            removed_ui_extensions.push(extension_name.clone());
        }
    }

    let mut removed_services = Vec::new();
    for service_name in &installed.services {
        if config.orchestrator.services.remove(service_name).is_some() {
            removed_services.push(service_name.clone());
        }
    }

    let mut removed_skills = Vec::new();
    for skill_name in &installed.skills {
        if config.skills.remove(skill_name).is_some() {
            removed_skills.push(skill_name.clone());
        }
    }

    let mut removed_resource_networks = Vec::new();
    for key in &installed.resource_networks {
        if config.orchestrator.resource_networks.remove(key).is_some() {
            removed_resource_networks.push(key.clone());
        }
    }

    let mut removed_hook_extensions = Vec::new();
    for name in &installed.hook_extensions {
        if config.hooks.extensions.remove(name).is_some() {
            removed_hook_extensions.push(name.clone());
        }
    }

    config
        .plugin_registry
        .installed_manifests
        .remove(normalized);

    Ok(PluginRemoveResult {
        ok: true,
        manifest_id: normalized.to_string(),
        removed_plugins,
        removed_ui_extensions,
        removed_services,
        removed_skills,
        removed_resource_networks,
        removed_hook_extensions,
    })
}

fn build_install_preview(
    config: &AppConfig,
    manifest: &ResolvedPluginManifest,
) -> Result<PluginInstallPreview> {
    let doc = &manifest.doc;
    validate_manifest(doc)?;

    let manifest_plugin_names = doc
        .plugins
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<HashSet<_>>();
    let manifest_service_names = doc
        .services
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<HashSet<_>>();

    let mut missing_dependencies = Vec::new();
    for dep in &doc.requires.manifests {
        if !config.plugin_registry.installed_manifests.contains_key(dep) {
            missing_dependencies.push(format!("manifest:{}", dep));
        }
    }
    for dep in &doc.requires.plugins {
        let normalized = normalize_plugin_ref(dep);
        if !config.plugins.contains_key(&normalized) && !manifest_plugin_names.contains(&normalized)
        {
            missing_dependencies.push(format!("plugin:{}", normalized));
        }
    }
    for dep in &doc.requires.services {
        if !config.orchestrator.services.contains_key(dep) && !manifest_service_names.contains(dep)
        {
            missing_dependencies.push(format!("service:{}", dep));
        }
    }

    for plugin in &doc.plugins {
        for dep in &plugin.config.dependencies {
            let normalized = normalize_plugin_ref(dep);
            if !config.plugins.contains_key(&normalized)
                && !manifest_plugin_names.contains(&normalized)
            {
                missing_dependencies.push(format!("plugin:{}", normalized));
            }
        }
    }
    missing_dependencies.sort();
    missing_dependencies.dedup();

    let owner_plugins = installed_plugin_owners(config);
    let owner_extensions = installed_extension_owners(config);
    let owner_services = installed_service_owners(config);
    let owner_skills = installed_skill_owners(config);
    let owner_resource_networks = installed_resource_network_owners(config);
    let owner_hook_extensions = installed_hook_extension_owners(config);

    let mut conflicts = Vec::new();
    for plugin in &doc.plugins {
        if config.plugins.contains_key(&plugin.name) {
            if let Some(owner) = owner_plugins.get(&plugin.name) {
                if owner != &doc.id {
                    conflicts.push(format!(
                        "plugin '{}' is already owned by plugin package '{}'",
                        plugin.name, owner
                    ));
                }
            } else {
                conflicts.push(format!(
                    "plugin '{}' already exists and is not package-managed",
                    plugin.name
                ));
            }
        }
    }
    for extension in &doc.ui_extensions {
        if config.ui.extensions.contains_key(&extension.name) {
            if let Some(owner) = owner_extensions.get(&extension.name) {
                if owner != &doc.id {
                    conflicts.push(format!(
                        "ui extension '{}' is already owned by plugin package '{}'",
                        extension.name, owner
                    ));
                }
            } else {
                conflicts.push(format!(
                    "ui extension '{}' already exists and is not package-managed",
                    extension.name
                ));
            }
        }
    }
    for service in &doc.services {
        if config.orchestrator.services.contains_key(&service.name) {
            if let Some(owner) = owner_services.get(&service.name) {
                if owner != &doc.id {
                    conflicts.push(format!(
                        "service '{}' is already owned by plugin package '{}'",
                        service.name, owner
                    ));
                }
            } else {
                conflicts.push(format!(
                    "service '{}' already exists and is not package-managed",
                    service.name
                ));
            }
        }
    }
    for skill in &doc.skills {
        if config.skills.contains_key(&skill.name) {
            if let Some(owner) = owner_skills.get(&skill.name) {
                if owner != &doc.id {
                    conflicts.push(format!(
                        "skill '{}' is already owned by plugin package '{}'",
                        skill.name, owner
                    ));
                }
            } else {
                conflicts.push(format!(
                    "skill '{}' already exists and is not package-managed",
                    skill.name
                ));
            }
        }
    }
    for name in doc.resource_networks.keys() {
        if config.orchestrator.resource_networks.contains_key(name) {
            if let Some(owner) = owner_resource_networks.get(name) {
                if owner != &doc.id {
                    conflicts.push(format!(
                        "resource network '{}' is already owned by plugin package '{}'",
                        name, owner
                    ));
                }
            } else {
                conflicts.push(format!(
                    "resource network '{}' already exists and is not package-managed",
                    name
                ));
            }
        }
    }
    for extension in &doc.hook_extensions {
        if config.hooks.extensions.contains_key(&extension.name) {
            if let Some(owner) = owner_hook_extensions.get(&extension.name) {
                if owner != &doc.id {
                    conflicts.push(format!(
                        "hook extension '{}' is already owned by plugin package '{}'",
                        extension.name, owner
                    ));
                }
            } else {
                conflicts.push(format!(
                    "hook extension '{}' already exists and is not package-managed",
                    extension.name
                ));
            }
        }
    }
    conflicts.sort();
    conflicts.dedup();
    let adoptable_conflicts = conflicts
        .iter()
        .filter(|line| is_adoptable_conflict(line))
        .cloned()
        .collect::<Vec<_>>();
    let blocking_conflicts = conflicts
        .iter()
        .filter(|line| !is_adoptable_conflict(line))
        .cloned()
        .collect::<Vec<_>>();

    let mut warnings = Vec::new();
    if doc.runtime.unsafe_host_access {
        warnings.push("plugin package requests unsafe host access".to_string());
    }
    if doc.runtime.requires_container && doc.runtime.mode.eq_ignore_ascii_case("host") {
        warnings.push(
            "plugin package runtime requires_container=true conflicts with runtime.mode=host"
                .to_string(),
        );
    }

    let plugin_summaries = doc
        .plugins
        .iter()
        .map(|plugin| {
            let resolved = plugin
                .config
                .permissions
                .resolve(&plugin.config.allowed_actions, &plugin.config.capabilities);
            if doc.runtime.requires_container && plugin.config.host_only {
                warnings.push(format!(
                    "plugin '{}' is host_only but plugin package requires container runtime",
                    plugin.name
                ));
            }
            PluginPermissionSummary {
                name: plugin.name.clone(),
                host_only: plugin.config.host_only,
                managed_only: plugin.config.managed_only,
                allowed_actions: plugin.config.allowed_actions.clone(),
                dependencies: plugin.config.dependencies.clone(),
                risk_flags: permission_risk_flags(plugin.config.host_only, &resolved),
                resolved_permissions: resolved,
            }
        })
        .collect::<Vec<_>>();
    let skill_summaries = doc
        .skills
        .iter()
        .map(|skill| PluginSkillSummary {
            name: skill.name.clone(),
            description: skill.config.description.clone(),
            path: skill.config.path.clone(),
            install_command: skill.config.install_command.clone(),
            targets: skill.config.targets.clone(),
            tags: skill.config.tags.clone(),
            enabled: skill.config.enabled,
        })
        .collect::<Vec<_>>();

    let summary = manifest_to_summary(config, manifest);
    let ui_extensions = doc
        .ui_extensions
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let services = doc
        .services
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let mut resource_networks = doc.resource_networks.keys().cloned().collect::<Vec<_>>();
    resource_networks.sort();
    let mut hook_extensions = doc
        .hook_extensions
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    hook_extensions.sort();

    Ok(PluginInstallPreview {
        manifest: summary,
        plugins: plugin_summaries,
        ui_extensions,
        services,
        skills: skill_summaries,
        resource_networks,
        hook_extensions,
        install_commands: doc.install.commands.clone(),
        missing_dependencies: missing_dependencies.clone(),
        conflicts: conflicts.clone(),
        adoptable_conflicts,
        blocking_conflicts: blocking_conflicts.clone(),
        warnings,
        can_install: missing_dependencies.is_empty() && blocking_conflicts.is_empty(),
    })
}

fn permission_risk_flags(host_only: bool, permissions: &AgentPermissions) -> Vec<String> {
    let mut out = Vec::new();
    if host_only {
        out.push("host_runtime".to_string());
    }
    if permissions.exec {
        out.push("exec".to_string());
    }
    if permissions.filesystem_write {
        out.push("filesystem_write".to_string());
    }
    if permissions.filesystem_read {
        out.push("filesystem_read".to_string());
    }
    if permissions.network {
        out.push("network".to_string());
    }
    if permissions.spawn_child {
        out.push("spawn_child".to_string());
    }
    if permissions.hook_extensions {
        out.push("hook_extensions".to_string());
    }
    if permissions.memory_write {
        out.push("memory_write".to_string());
    }
    if permissions.playwright {
        out.push("playwright".to_string());
    }
    out
}

fn manifest_to_summary(
    config: &AppConfig,
    manifest: &ResolvedPluginManifest,
) -> PluginManifestSummary {
    PluginManifestSummary {
        id: manifest.doc.id.clone(),
        name: manifest.doc.name.clone(),
        version: manifest.doc.version.clone(),
        description: manifest.doc.description.clone(),
        readme: manifest.doc.readme.clone(),
        manifest_path: manifest.path.display().to_string(),
        manifest_format: manifest.format.clone(),
        requires: manifest.doc.requires.clone(),
        runtime: manifest.doc.runtime.clone(),
        extends: manifest.doc.extends.clone(),
        plugin_count: manifest.doc.plugins.len(),
        ui_extension_count: manifest.doc.ui_extensions.len(),
        service_count: manifest.doc.services.len(),
        skill_count: manifest.doc.skills.len(),
        resource_network_count: manifest.doc.resource_networks.len(),
        hook_extension_count: manifest.doc.hook_extensions.len(),
        install: manifest.doc.install.clone(),
        installed: config
            .plugin_registry
            .installed_manifests
            .contains_key(&manifest.doc.id),
    }
}

fn resolve_manifest_reference(
    config: &AppConfig,
    manifest_ref: &str,
) -> Result<ResolvedPluginManifest> {
    let trimmed = manifest_ref.trim();
    if trimmed.is_empty() {
        anyhow::bail!("plugin package reference is required");
    }

    let candidate_path = Path::new(trimmed);
    if candidate_path.exists() {
        return load_manifest_from_path(candidate_path);
    }

    let (manifests, parse_errors) = discover_plugin_manifests(config);
    if let Some(found) = manifests.into_iter().find(|manifest| {
        manifest.doc.id.eq_ignore_ascii_case(trimmed)
            || manifest.doc.name.eq_ignore_ascii_case(trimmed)
    }) {
        return Ok(found);
    }

    if !parse_errors.is_empty() {
        anyhow::bail!(
            "plugin package '{}' not found ({} parse errors in catalog)",
            trimmed,
            parse_errors.len()
        );
    }
    anyhow::bail!("plugin package '{}' not found", trimmed);
}

fn discover_plugin_manifests(config: &AppConfig) -> (Vec<ResolvedPluginManifest>, Vec<String>) {
    let mut manifests = Vec::new();
    let mut parse_errors = Vec::new();

    let mut paths = Vec::new();
    for dir in plugin_manifest_dirs(config) {
        collect_manifest_files(&dir, &mut paths);
    }
    paths.sort();
    paths.dedup();

    for path in paths {
        match load_manifest_from_path(&path) {
            Ok(manifest) => manifests.push(manifest),
            Err(err) => parse_errors.push(format!("{}: {}", path.display(), err)),
        }
    }
    manifests.sort_by(|a, b| a.doc.name.to_lowercase().cmp(&b.doc.name.to_lowercase()));
    (manifests, parse_errors)
}

fn plugin_manifest_dirs(config: &AppConfig) -> Vec<PathBuf> {
    config
        .plugin_registry
        .manifest_dirs
        .iter()
        .map(|raw| expand_manifest_dir(raw))
        .collect::<Vec<_>>()
}

fn expand_manifest_dir(raw: &str) -> PathBuf {
    if raw == "~" || raw.starts_with("~/") {
        if let Ok(home) = env::var("HOME") {
            if raw == "~" {
                return PathBuf::from(home);
            }
            return PathBuf::from(home).join(raw.trim_start_matches("~/"));
        }
    }
    PathBuf::from(raw)
}

fn collect_manifest_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if !dir.exists() || !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_manifest_files(&path, out);
            continue;
        }
        if is_manifest_file(&path) {
            out.push(path);
        }
    }
}

fn is_manifest_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    if !matches!(ext.to_ascii_lowercase().as_str(), "json" | "yaml" | "yml") {
        return false;
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if file_name.contains("manifest")
        || matches!(
            file_name.as_str(),
            "plugin.json"
                | "plugin.yaml"
                | "plugin.yml"
                | "pinokio-plugin.json"
                | "pinokio-plugin.yaml"
                | "pinokio-plugin.yml"
        )
    {
        return true;
    }

    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        value == "plugin-manifests" || value == "manifests"
    })
}

fn load_manifest_from_path(path: &Path) -> Result<ResolvedPluginManifest> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read manifest {}", path.display()))?;
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let doc: PluginManifestDocument = match ext.as_str() {
        "yaml" | "yml" => serde_yaml::from_str(&raw)
            .with_context(|| format!("failed to parse YAML manifest {}", path.display()))?,
        "json" => serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse JSON manifest {}", path.display()))?,
        _ => anyhow::bail!("unsupported manifest extension for {}", path.display()),
    };
    validate_manifest(&doc)?;
    Ok(ResolvedPluginManifest {
        doc,
        path: path.to_path_buf(),
        format: ext,
    })
}

fn validate_manifest(doc: &PluginManifestDocument) -> Result<()> {
    if !doc.api_version.eq_ignore_ascii_case("pinokio.plugin/v1") {
        anyhow::bail!(
            "unsupported manifest api_version '{}', expected 'pinokio.plugin/v1'",
            doc.api_version
        );
    }
    if doc.id.trim().is_empty() {
        anyhow::bail!("manifest id is required");
    }
    if doc.name.trim().is_empty() {
        anyhow::bail!("manifest name is required");
    }
    if doc.plugins.is_empty()
        && doc.ui_extensions.is_empty()
        && doc.services.is_empty()
        && doc.skills.is_empty()
        && doc.resource_networks.is_empty()
        && doc.hook_extensions.is_empty()
    {
        anyhow::bail!(
            "manifest must define at least one plugin, ui extension, service, skill, resource network, or hook extension"
        );
    }

    let mut plugin_names = HashSet::new();
    for plugin in &doc.plugins {
        if plugin.name.trim().is_empty() {
            anyhow::bail!("manifest plugin name cannot be empty");
        }
        if !plugin_names.insert(plugin.name.clone()) {
            anyhow::bail!("duplicate plugin entry '{}'", plugin.name);
        }
        if plugin.config.command.trim().is_empty() {
            anyhow::bail!("plugin '{}' has empty command", plugin.name);
        }
    }

    let mut extension_names = HashSet::new();
    for extension in &doc.ui_extensions {
        if extension.name.trim().is_empty() {
            anyhow::bail!("manifest ui extension name cannot be empty");
        }
        if !extension_names.insert(extension.name.clone()) {
            anyhow::bail!("duplicate ui extension entry '{}'", extension.name);
        }
    }

    let mut service_names = HashSet::new();
    for service in &doc.services {
        if service.name.trim().is_empty() {
            anyhow::bail!("manifest service name cannot be empty");
        }
        if !service_names.insert(service.name.clone()) {
            anyhow::bail!("duplicate service entry '{}'", service.name);
        }
    }

    let mut skill_names = HashSet::new();
    for skill in &doc.skills {
        if skill.name.trim().is_empty() {
            anyhow::bail!("manifest skill name cannot be empty");
        }
        if !skill_names.insert(skill.name.clone()) {
            anyhow::bail!("duplicate skill entry '{}'", skill.name);
        }
    }

    let mut hook_extension_names = HashSet::new();
    for extension in &doc.hook_extensions {
        if extension.name.trim().is_empty() {
            anyhow::bail!("manifest hook extension name cannot be empty");
        }
        if !hook_extension_names.insert(extension.name.clone()) {
            anyhow::bail!("duplicate hook extension entry '{}'", extension.name);
        }
    }

    for key in doc.resource_networks.keys() {
        if key.trim().is_empty() {
            anyhow::bail!("manifest resource network key cannot be empty");
        }
    }

    for install in &doc.install.commands {
        if install.command.trim().is_empty() {
            anyhow::bail!("manifest install command cannot be empty");
        }
    }
    Ok(())
}

fn installed_plugin_owners(config: &AppConfig) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for (manifest_id, installed) in &config.plugin_registry.installed_manifests {
        for plugin_name in &installed.plugins {
            owners.insert(plugin_name.clone(), manifest_id.clone());
        }
    }
    owners
}

fn installed_extension_owners(config: &AppConfig) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for (manifest_id, installed) in &config.plugin_registry.installed_manifests {
        for extension_name in &installed.ui_extensions {
            owners.insert(extension_name.clone(), manifest_id.clone());
        }
    }
    owners
}

fn installed_service_owners(config: &AppConfig) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for (manifest_id, installed) in &config.plugin_registry.installed_manifests {
        for service_name in &installed.services {
            owners.insert(service_name.clone(), manifest_id.clone());
        }
    }
    owners
}

fn installed_skill_owners(config: &AppConfig) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for (manifest_id, installed) in &config.plugin_registry.installed_manifests {
        for name in &installed.skills {
            owners.insert(name.clone(), manifest_id.clone());
        }
    }
    owners
}

fn installed_resource_network_owners(config: &AppConfig) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for (manifest_id, installed) in &config.plugin_registry.installed_manifests {
        for name in &installed.resource_networks {
            owners.insert(name.clone(), manifest_id.clone());
        }
    }
    owners
}

fn installed_hook_extension_owners(config: &AppConfig) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for (manifest_id, installed) in &config.plugin_registry.installed_manifests {
        for name in &installed.hook_extensions {
            owners.insert(name.clone(), manifest_id.clone());
        }
    }
    owners
}

fn is_adoptable_conflict(value: &str) -> bool {
    value.contains("is not package-managed") || value.contains("is not manifest-managed")
}

fn run_manifest_install_commands(
    manifest: &PluginManifestDocument,
) -> Result<Vec<PluginInstallCommandResult>> {
    let mut results = Vec::new();
    for (idx, command) in manifest.install.commands.iter().enumerate() {
        let id = if command.id.trim().is_empty() {
            format!("step_{}", idx + 1)
        } else {
            command.id.trim().to_string()
        };
        if command.scope.eq_ignore_ascii_case("container") {
            results.push(PluginInstallCommandResult {
                id: id.clone(),
                scope: command.scope.clone(),
                command: command.command.clone(),
                ok: true,
                output: "skipped: container-scope install commands are not yet executable by manager during install".to_string(),
            });
            continue;
        }
        if command.scope.eq_ignore_ascii_case("backend") {
            results.push(PluginInstallCommandResult {
                id: id.clone(),
                scope: command.scope.clone(),
                command: command.command.clone(),
                ok: true,
                output: "skipped: backend-scope install commands are not yet executable by manager during install".to_string(),
            });
            continue;
        }

        let output = run_shell_command_capture(&command.command)?;
        let success = output.0 == 0;
        let result = PluginInstallCommandResult {
            id: id.clone(),
            scope: command.scope.clone(),
            command: command.command.clone(),
            ok: success,
            output: output.1.clone(),
        };
        results.push(result);
        if !success {
            anyhow::bail!("install command '{}' failed: {}", id, output.1.trim());
        }
    }
    Ok(results)
}

fn run_shell_command_capture(command: &str) -> Result<(i32, String)> {
    #[cfg(target_os = "windows")]
    let output = Command::new("cmd")
        .args(["/C", command])
        .output()
        .with_context(|| format!("failed to run shell command '{}'", command))?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("sh")
        .args(["-lc", command])
        .output()
        .with_context(|| format!("failed to run shell command '{}'", command))?;

    let status = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let merged = [stdout.as_ref().trim(), stderr.as_ref().trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok((status, merged))
}

fn normalize_plugin_ref(value: &str) -> String {
    value
        .trim()
        .strip_prefix("plugin:")
        .unwrap_or(value.trim())
        .to_string()
}

fn default_manifest_api_version() -> String {
    "pinokio.plugin/v1".to_string()
}

fn default_manifest_runtime_mode() -> String {
    "container".to_string()
}

fn default_manifest_install_scope() -> String {
    "host".to_string()
}

fn bind_profile_credential(
    config: &mut AppConfig,
    profile_name: &str,
    credential_name: &str,
) -> Result<()> {
    let profile = config
        .llm_profiles
        .get_mut(profile_name)
        .with_context(|| format!("llm profile not found: {}", profile_name))?;
    profile.credential = Some(credential_name.to_string());
    Ok(())
}

fn clear_profile_credential(config: &mut AppConfig, profile_name: &str) -> Result<()> {
    let profile = config
        .llm_profiles
        .get_mut(profile_name)
        .with_context(|| format!("llm profile not found: {}", profile_name))?;
    profile.credential = None;
    Ok(())
}

fn set_profile_fallback(
    config: &mut AppConfig,
    profile_name: &str,
    fallback: Option<String>,
) -> Result<()> {
    let profile = config
        .llm_profiles
        .get_mut(profile_name)
        .with_context(|| format!("llm profile not found: {}", profile_name))?;
    profile.fallback = fallback;
    Ok(())
}

fn upsert_credential(config: &mut AppConfig, credential_name: &str, desired: CredentialConfig) {
    match config.credentials.get_mut(credential_name) {
        Some(existing) => {
            existing.provider = desired.provider;
            existing.mode = desired.mode;
            if existing.env.is_empty() {
                existing.env = desired.env;
            }
            if desired.login_command.is_some() {
                existing.login_command = desired.login_command;
            }
            if desired.session_file.is_some() {
                existing.session_file = desired.session_file;
            }
        }
        None => {
            config
                .credentials
                .insert(credential_name.to_string(), desired);
        }
    }
}

fn upsert_layer(config: &mut AppConfig, layer_name: &str, desired: ApiLayerConfig) {
    match config.api_layers.get_mut(layer_name) {
        Some(existing) => {
            existing.kind = desired.kind;
            if desired.base_url.is_some() {
                existing.base_url = desired.base_url;
            }
            existing.credential = desired.credential;
            if desired.command.is_some() {
                existing.command = desired.command;
            }
        }
        None => {
            config.api_layers.insert(layer_name.to_string(), desired);
        }
    }
}

fn normalize_extension_kind(kind: &str) -> String {
    match kind.to_lowercase().as_str() {
        "plugin" | "plugins" => "plugins".to_string(),
        "agent" | "agents" => "agents".to_string(),
        "system" | "systems" | "connection" | "connections" => "systems".to_string(),
        "core" => "core".to_string(),
        _ => "systems".to_string(),
    }
}

fn normalize_extension_slot(slot: &str) -> String {
    match slot.to_lowercase().as_str() {
        "nav" | "navigation" => "navigation".to_string(),
        "setting" | "settings" => "settings".to_string(),
        "page" | "pages" => "page".to_string(),
        _ => "settings".to_string(),
    }
}

pub fn ensure_profile_exists(
    config: &mut AppConfig,
    profile_name: &str,
    provider: &str,
    model: &str,
    layer_name: &str,
) {
    if config.llm_profiles.contains_key(profile_name) {
        return;
    }
    config.llm_profiles.insert(
        profile_name.to_string(),
        LlmProfile {
            provider: provider.to_string(),
            model: model.to_string(),
            api_layer: layer_name.to_string(),
            credential: None,
            fallback: Some("default".to_string()),
            max_tokens: 2000,
            max_cost_usd: 0.25,
            temperature: 0.2,
            system_prompt: Some(
                "You are a secure orchestration agent. Be concise and risk-aware. Always check installed plugins and systems before claiming a capability is unavailable.".to_string(),
            ),
        },
    );
}
