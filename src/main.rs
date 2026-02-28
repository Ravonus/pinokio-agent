mod agent;
mod auth;
mod bootstrap;
mod config;
mod configure;
mod credentials;
mod hooks;
mod llm;
mod manager;
mod marketplace;
mod model;
mod oauth_cli;
mod package_ledger;
mod playwright;
mod policy;
mod runtime;
mod transport;
mod ui;
mod ui_pages;

use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use uuid::Uuid;

use crate::config::{
    load as load_config, resolve_path as resolve_config_path, SkillConfig, SkillTargetConfig,
};
use crate::configure as app_configure;
use crate::hooks::emit_hook_event;
use crate::llm::complete;
use crate::manager::run_task;
use crate::model::{CrudAction, TaskRequest};
use crate::package_ledger::{list_events as package_ledger_list_events, list_scopes as package_ledger_list_scopes};
use crate::ui::start_ui;

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "pinokio.ai Rust-first agent manager with isolated workers"
)]
struct Cli {
    #[arg(long)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Run(RunArgs),
    Llm(LlmArgs),
    Configure(ConfigureArgs),
    Ui(UiArgs),
    Setup,
    Login,
    Logout,
    AuthStatus,
    Agent(AgentArgs),
    Micro(AgentArgs),
}

#[derive(clap::Args, Debug)]
struct RunArgs {
    #[arg(long)]
    task: String,
    #[arg(long)]
    resource: String,
    #[arg(long, value_enum, default_value_t = ActionArg::Read)]
    action: ActionArg,
    #[arg(long)]
    target: Option<String>,
    #[arg(long)]
    runtime: Option<String>,
    #[arg(long)]
    image: Option<String>,
    #[arg(long)]
    network: Option<String>,
    #[arg(long)]
    profile: Option<String>,
}

#[derive(clap::Args, Debug)]
struct AgentArgs {
    #[arg(long)]
    socket: Option<PathBuf>,
    #[arg(long)]
    tcp: Option<String>,
    #[arg(long)]
    stdio: bool,
    #[arg(long)]
    agent_id: Option<String>,
}

#[derive(clap::Args, Debug)]
struct LlmArgs {
    #[arg(long)]
    prompt: String,
    #[arg(long, default_value = "default")]
    profile: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureArgs {
    #[command(subcommand)]
    command: ConfigureCommand,
}

#[derive(Subcommand, Debug)]
enum ConfigureCommand {
    Openai(ConfigureOpenAiArgs),
    ClaudeApi(ConfigureClaudeApiArgs),
    ClaudeCode(ConfigureClaudeCodeArgs),
    Codex(ConfigureCodexArgs),
    ManagerPolicy(ConfigureManagerPolicyArgs),
    Skills,
    SkillAdd(ConfigureSkillAddArgs),
    SkillRemove(ConfigureSkillRemoveArgs),
    PluginCatalog,
    PluginPreview(ConfigurePluginPreviewArgs),
    PluginInstall(ConfigurePluginInstallArgs),
    PluginRemove(ConfigurePluginRemoveArgs),
    Login(ConfigureLoginArgs),
    ExtensionAdd(ConfigureExtensionAddArgs),
    ExtensionRemove(ConfigureExtensionRemoveArgs),
    Extensions,
    Services,
    ServiceEnsure(ConfigureServiceEnsureArgs),
    PackageLedgerScopes(ConfigurePackageLedgerScopesArgs),
    PackageLedgerEvents(ConfigurePackageLedgerEventsArgs),
    Doctor,
    Status,
}

#[derive(clap::Args, Debug)]
struct ConfigureOpenAiArgs {
    #[arg(long, default_value = "openai_main")]
    credential: String,
    #[arg(long)]
    api_key: Option<String>,
    #[arg(long, default_value = "openai_codex")]
    layer: String,
    #[arg(long, default_value = "default")]
    profile: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureClaudeApiArgs {
    #[arg(long, default_value = "claude_api_main")]
    credential: String,
    #[arg(long)]
    api_key: Option<String>,
    #[arg(long, default_value = "claude_api")]
    layer: String,
    #[arg(long, default_value = "claude")]
    profile: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureClaudeCodeArgs {
    #[arg(long, default_value = "claude_code_main")]
    credential: String,
    #[arg(long)]
    token: Option<String>,
    #[arg(long)]
    oauth_command: Option<String>,
    #[arg(long, default_value = "claude_code")]
    layer: String,
    #[arg(long, default_value = "claude_code")]
    profile: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureCodexArgs {
    #[arg(long, default_value = "codex_main")]
    credential: String,
    #[arg(long)]
    token: Option<String>,
    #[arg(long, default_value = "codex login --device-auth")]
    oauth_command: String,
    #[arg(long, default_value = "openai_codex")]
    layer: String,
    #[arg(long, default_value = "codex")]
    profile: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureLoginArgs {
    #[arg(long)]
    credential: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureManagerPolicyArgs {
    #[arg(long)]
    child_spawn_enabled: Option<bool>,
    #[arg(long)]
    child_spawn_container_only: Option<bool>,
    #[arg(long)]
    unsafe_host_communication_enabled: Option<bool>,
    #[arg(long)]
    socket_bus_enabled: Option<bool>,
    #[arg(long)]
    socket_bus_container_only: Option<bool>,
    #[arg(long)]
    socket_bus_max_channel_messages: Option<usize>,
    #[arg(long)]
    container_package_installs_enabled: Option<bool>,
}

#[derive(clap::Args, Debug)]
struct ConfigurePluginPreviewArgs {
    #[arg(long = "plugin", visible_alias = "manifest")]
    plugin: String,
}

#[derive(clap::Args, Debug)]
struct ConfigurePluginInstallArgs {
    #[arg(long = "plugin", visible_alias = "manifest")]
    plugin: String,
    #[arg(long)]
    allow_missing_dependencies: bool,
    #[arg(long)]
    adopt_existing: bool,
    #[arg(long)]
    skip_install_commands: bool,
}

#[derive(clap::Args, Debug)]
struct ConfigurePluginRemoveArgs {
    #[arg(long = "plugin", visible_alias = "manifest")]
    plugin: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureSkillAddArgs {
    #[arg(long)]
    name: String,
    #[arg(long, default_value = "")]
    description: String,
    #[arg(long, default_value = "")]
    path: String,
    #[arg(long)]
    install_command: Option<String>,
    #[arg(long = "plugin")]
    plugins: Vec<String>,
    #[arg(long = "resource")]
    resources: Vec<String>,
    #[arg(long = "agent")]
    agents: Vec<String>,
    #[arg(long = "action")]
    actions: Vec<String>,
    #[arg(long = "tag")]
    tags: Vec<String>,
    #[arg(long)]
    enabled: Option<bool>,
    #[arg(long)]
    run_install: bool,
}

#[derive(clap::Args, Debug)]
struct ConfigureSkillRemoveArgs {
    #[arg(long)]
    name: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureExtensionAddArgs {
    #[arg(long)]
    name: String,
    #[arg(long, default_value = "systems")]
    kind: String,
    #[arg(long)]
    slot: Option<String>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    detail: Option<String>,
    #[arg(long)]
    route: Option<String>,
    #[arg(long)]
    order: Option<i32>,
    #[arg(long)]
    enabled: Option<bool>,
}

#[derive(clap::Args, Debug)]
struct ConfigureExtensionRemoveArgs {
    #[arg(long)]
    name: String,
}

#[derive(clap::Args, Debug)]
struct ConfigureServiceEnsureArgs {
    #[arg(long = "name")]
    names: Vec<String>,
}

#[derive(clap::Args, Debug)]
struct ConfigurePackageLedgerScopesArgs {
    #[arg(long, default_value_t = 200)]
    limit: usize,
}

#[derive(clap::Args, Debug)]
struct ConfigurePackageLedgerEventsArgs {
    #[arg(long)]
    scope_key: Option<String>,
    #[arg(long, default_value_t = 200)]
    limit: usize,
}

#[derive(clap::Args, Debug)]
struct UiArgs {
    #[arg(long)]
    host: Option<String>,
    #[arg(long)]
    port: Option<u16>,
    #[arg(long)]
    configure: bool,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum ActionArg {
    Create,
    Read,
    Update,
    Delete,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run(args) => {
            let config = load_config(cli.config.as_deref())?;
            let request = TaskRequest {
                id: Uuid::new_v4().to_string(),
                summary: args.task,
                resource: args.resource,
                action: to_action(args.action),
                target: args.target,
                runtime: args.runtime,
                container_image: args.image,
                container_network: args.network,
                llm_profile: args.profile,
                caller_task_id: None,
                caller_agent_id: None,
                caller_resource: None,
            };
            emit_hook_event(
                &config.hooks,
                "cli.run.started",
                &serde_json::json!({ "task": &request }),
            )?;
            let report = match run_task(&config, request.clone()) {
                Ok(report) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.run.completed",
                        &serde_json::json!({ "task": &request, "report": &report }),
                    )?;
                    report
                }
                Err(err) => {
                    let _ = emit_hook_event(
                        &config.hooks,
                        "cli.run.failed",
                        &serde_json::json!({ "task": &request, "error": err.to_string() }),
                    );
                    return Err(err);
                }
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Commands::Llm(args) => {
            let config = load_config(cli.config.as_deref())?;
            emit_hook_event(
                &config.hooks,
                "cli.llm.started",
                &serde_json::json!({ "profile": &args.profile, "prompt_len": args.prompt.len() }),
            )?;
            let out = complete(&config, &args.profile, &args.prompt)?;
            emit_hook_event(
                &config.hooks,
                "cli.llm.completed",
                &serde_json::json!({ "profile": &args.profile, "provider": &out.provider, "model": &out.model }),
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "profile": args.profile,
                    "provider": out.provider,
                    "model": out.model,
                    "text": out.text,
                }))?
            );
            Ok(())
        }
        Commands::Configure(args) => {
            let mut config = load_config(cli.config.as_deref())?;
            match args.command {
                ConfigureCommand::Openai(openai) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.openai.started",
                        &serde_json::json!({
                            "credential": &openai.credential,
                            "layer": &openai.layer,
                            "profile": &openai.profile,
                        }),
                    )?;
                    let openai_model = if openai.profile.eq_ignore_ascii_case("codex") {
                        "gpt-5-codex"
                    } else {
                        "gpt-4.1-mini"
                    };
                    app_configure::ensure_profile_exists(
                        &mut config,
                        &openai.profile,
                        "openai",
                        openai_model,
                        &openai.layer,
                    );
                    let api_key = match openai.api_key {
                        Some(key) => key,
                        None => read_secret_from_stdin("OpenAI API key")?,
                    };
                    let credential = app_configure::configure_openai(
                        &mut config,
                        &openai.credential,
                        &api_key,
                        Some(&openai.profile),
                        &openai.layer,
                    )?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.openai.completed",
                        &serde_json::json!({
                            "credential": &credential,
                            "config_path": &config_path,
                        }),
                    )?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "message": "openai configured",
                            "config_path": config_path,
                            "credential": credential,
                        }))?
                    );
                }
                ConfigureCommand::ClaudeApi(claude_api) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.claude_api.started",
                        &serde_json::json!({
                            "credential": &claude_api.credential,
                            "layer": &claude_api.layer,
                            "profile": &claude_api.profile,
                        }),
                    )?;
                    app_configure::ensure_profile_exists(
                        &mut config,
                        &claude_api.profile,
                        "anthropic",
                        "claude-sonnet-4-20250514",
                        &claude_api.layer,
                    );
                    let api_key = match claude_api.api_key {
                        Some(key) => key,
                        None => read_secret_from_stdin("Claude API key")?,
                    };
                    let credential = app_configure::configure_claude_api(
                        &mut config,
                        &claude_api.credential,
                        &api_key,
                        Some(&claude_api.profile),
                        &claude_api.layer,
                    )?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.claude_api.completed",
                        &serde_json::json!({
                            "credential": &credential,
                            "config_path": &config_path,
                        }),
                    )?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "message": "claude api configured",
                            "config_path": config_path,
                            "credential": credential,
                        }))?
                    );
                }
                ConfigureCommand::ClaudeCode(claude_code) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.claude_code.started",
                        &serde_json::json!({
                            "credential": &claude_code.credential,
                            "layer": &claude_code.layer,
                            "profile": &claude_code.profile,
                        }),
                    )?;
                    app_configure::ensure_profile_exists(
                        &mut config,
                        &claude_code.profile,
                        "claude_code",
                        "claude-code",
                        &claude_code.layer,
                    );
                    let credential = app_configure::configure_claude_code(
                        &mut config,
                        &claude_code.credential,
                        claude_code.token.as_deref(),
                        claude_code.oauth_command.as_deref(),
                        Some(&claude_code.profile),
                        &claude_code.layer,
                    )?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.claude_code.completed",
                        &serde_json::json!({
                            "credential": &credential,
                            "config_path": &config_path,
                        }),
                    )?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "message": "claude code configured",
                            "config_path": config_path,
                            "credential": credential,
                        }))?
                    );
                }
                ConfigureCommand::Codex(codex) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.codex.started",
                        &serde_json::json!({
                            "credential": &codex.credential,
                            "layer": &codex.layer,
                            "profile": &codex.profile,
                        }),
                    )?;
                    app_configure::ensure_profile_exists(
                        &mut config,
                        &codex.profile,
                        "openai",
                        "gpt-5-codex",
                        &codex.layer,
                    );
                    let credential = app_configure::configure_codex(
                        &mut config,
                        &codex.credential,
                        codex.token.as_deref(),
                        Some(codex.oauth_command.as_str()),
                        Some(&codex.profile),
                        &codex.layer,
                    )?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.codex.completed",
                        &serde_json::json!({
                            "credential": &credential,
                            "config_path": &config_path,
                        }),
                    )?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "message": "codex configured",
                            "config_path": config_path,
                            "credential": credential,
                        }))?
                    );
                }
                ConfigureCommand::ManagerPolicy(args) => {
                    let mut changed = false;
                    if let Some(value) = args.child_spawn_enabled {
                        config.manager.child_spawn_enabled = value;
                        changed = true;
                    }
                    if let Some(value) = args.child_spawn_container_only {
                        config.manager.child_spawn_container_only = value;
                        changed = true;
                    }
                    if let Some(value) = args.unsafe_host_communication_enabled {
                        config.manager.unsafe_host_communication_enabled = value;
                        changed = true;
                    }
                    if let Some(value) = args.socket_bus_enabled {
                        config.manager.socket_bus_enabled = value;
                        changed = true;
                    }
                    if let Some(value) = args.socket_bus_container_only {
                        config.manager.socket_bus_container_only = value;
                        changed = true;
                    }
                    if let Some(value) = args.socket_bus_max_channel_messages {
                        config.manager.socket_bus_max_channel_messages = value.clamp(16, 4096);
                        changed = true;
                    }
                    if let Some(value) = args.container_package_installs_enabled {
                        config.manager.container_package_installs_enabled = value;
                        changed = true;
                    }

                    let resolved_path = resolve_config_path(cli.config.as_deref())?;
                    let config_path = if changed {
                        app_configure::save(cli.config.as_deref(), &config)?
                    } else {
                        resolved_path.display().to_string()
                    };

                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "changed": changed,
                            "config_path": config_path,
                            "policy": {
                                "child_spawn_enabled": config.manager.child_spawn_enabled,
                                "child_spawn_container_only": config.manager.child_spawn_container_only,
                                "unsafe_host_communication_enabled": config.manager.unsafe_host_communication_enabled,
                                "hook_extensions_enabled": config.manager.hook_extensions_enabled,
                                "hook_extensions_container_only": config.manager.hook_extensions_container_only,
                                "socket_bus_enabled": config.manager.socket_bus_enabled,
                                "socket_bus_container_only": config.manager.socket_bus_container_only,
                                "socket_bus_max_channel_messages": config.manager.socket_bus_max_channel_messages,
                                "container_package_installs_enabled": config.manager.container_package_installs_enabled
                            }
                        }))?
                    );
                }
                ConfigureCommand::Skills => {
                    let skills = app_configure::list_skills(&config);
                    println!("{}", serde_json::to_string_pretty(&skills)?);
                }
                ConfigureCommand::SkillAdd(args) => {
                    let skill = SkillConfig {
                        description: args.description,
                        path: args.path,
                        install_command: args.install_command,
                        targets: SkillTargetConfig {
                            plugins: args.plugins,
                            resources: args.resources,
                            agents: args.agents,
                            actions: args.actions,
                        },
                        tags: args.tags,
                        enabled: args.enabled.unwrap_or(true),
                    };
                    let registered = app_configure::upsert_skill(
                        &mut config,
                        &args.name,
                        skill,
                        args.run_install,
                    )?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "message": "skill registered",
                            "config_path": config_path,
                            "skill": registered,
                        }))?
                    );
                }
                ConfigureCommand::SkillRemove(args) => {
                    let removed = app_configure::remove_skill(&mut config, &args.name);
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "removed": removed,
                            "name": args.name,
                            "config_path": config_path,
                        }))?
                    );
                }
                ConfigureCommand::PluginCatalog => {
                    let report = app_configure::plugin_catalog(&config)?;
                    println!("{}", serde_json::to_string_pretty(&report)?);
                }
                ConfigureCommand::PluginPreview(args) => {
                    let preview = app_configure::plugin_preview(&config, &args.plugin)?;
                    println!("{}", serde_json::to_string_pretty(&preview)?);
                }
                ConfigureCommand::PluginInstall(args) => {
                    let result = app_configure::plugin_install(
                        &mut config,
                        &args.plugin,
                        args.allow_missing_dependencies,
                        args.adopt_existing,
                        !args.skip_install_commands,
                    )?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": result.ok,
                            "config_path": config_path,
                            "result": result,
                        }))?
                    );
                }
                ConfigureCommand::PluginRemove(args) => {
                    let result = app_configure::plugin_remove(&mut config, &args.plugin)?;
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": result.ok,
                            "config_path": config_path,
                            "result": result,
                        }))?
                    );
                }
                ConfigureCommand::Login(login) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.login.started",
                        &serde_json::json!({ "credential": &login.credential }),
                    )?;
                    let status = app_configure::login_credential(&config, &login.credential)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.login.completed",
                        &serde_json::json!({ "credential": &status }),
                    )?;
                    println!("{}", serde_json::to_string_pretty(&status)?);
                }
                ConfigureCommand::ExtensionAdd(extension) => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.extension.add.started",
                        &serde_json::json!({
                            "name": &extension.name,
                            "kind": &extension.kind,
                        }),
                    )?;
                    let registered = app_configure::upsert_ui_extension(
                        &mut config,
                        &extension.name,
                        &extension.kind,
                        extension.slot.as_deref(),
                        extension.title.as_deref(),
                        extension.detail.as_deref(),
                        extension.route.as_deref(),
                        extension.order,
                        extension.enabled.unwrap_or(true),
                    );
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.extension.add.completed",
                        &serde_json::json!({
                            "extension": &registered,
                            "config_path": &config_path,
                        }),
                    )?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "message": "extension registered",
                            "config_path": config_path,
                            "extension": registered,
                        }))?
                    );
                }
                ConfigureCommand::ExtensionRemove(extension) => {
                    let removed = app_configure::remove_ui_extension(&mut config, &extension.name);
                    let config_path = app_configure::save(cli.config.as_deref(), &config)?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": true,
                            "removed": removed,
                            "name": extension.name,
                            "config_path": config_path,
                        }))?
                    );
                }
                ConfigureCommand::Extensions => {
                    let extensions = app_configure::list_ui_extensions(&config);
                    println!("{}", serde_json::to_string_pretty(&extensions)?);
                }
                ConfigureCommand::Services => {
                    let services = app_configure::services(&config)?;
                    println!("{}", serde_json::to_string_pretty(&services)?);
                }
                ConfigureCommand::ServiceEnsure(args) => {
                    let names = if args.names.is_empty() {
                        None
                    } else {
                        Some(args.names.as_slice())
                    };
                    let services = app_configure::ensure_services(&config, names)?;
                    println!("{}", serde_json::to_string_pretty(&services)?);
                }
                ConfigureCommand::PackageLedgerScopes(args) => {
                    let scopes = package_ledger_list_scopes(&config, args.limit)?;
                    println!("{}", serde_json::to_string_pretty(&scopes)?);
                }
                ConfigureCommand::PackageLedgerEvents(args) => {
                    let events = package_ledger_list_events(
                        &config,
                        args.scope_key.as_deref(),
                        args.limit,
                    )?;
                    println!("{}", serde_json::to_string_pretty(&events)?);
                }
                ConfigureCommand::Doctor => {
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.doctor.started",
                        &serde_json::json!({}),
                    )?;
                    let report = app_configure::doctor(&config)?;
                    emit_hook_event(
                        &config.hooks,
                        "cli.configure.doctor.completed",
                        &serde_json::json!({ "report_ok": report.ok }),
                    )?;
                    println!("{}", serde_json::to_string_pretty(&report)?);
                }
                ConfigureCommand::Status => {
                    let status = app_configure::status(&config)?;
                    println!("{}", serde_json::to_string_pretty(&status)?);
                }
            }
            Ok(())
        }
        Commands::Ui(args) => {
            let config = load_config(cli.config.as_deref())?;
            emit_hook_event(
                &config.hooks,
                "cli.ui.started",
                &serde_json::json!({
                    "configure": args.configure,
                    "host": args.host,
                    "port": args.port,
                }),
            )?;
            let result = start_ui(&config, args.host.as_deref(), args.port, args.configure);
            match result {
                Ok(()) => {
                    emit_hook_event(&config.hooks, "cli.ui.completed", &serde_json::json!({}))?;
                    Ok(())
                }
                Err(err) => {
                    let _ = emit_hook_event(
                        &config.hooks,
                        "cli.ui.failed",
                        &serde_json::json!({ "error": err.to_string() }),
                    );
                    Err(err)
                }
            }
        }
        Commands::Setup => {
            let config = load_config(cli.config.as_deref())?;
            emit_hook_event(&config.hooks, "cli.setup.started", &serde_json::json!({}))?;
            let report = bootstrap::setup_for_user(&config)?;
            emit_hook_event(
                &config.hooks,
                "cli.setup.completed",
                &serde_json::json!({ "report": &report }),
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Commands::Login => {
            let config = load_config(cli.config.as_deref())?;
            emit_hook_event(
                &config.hooks,
                "cli.auth.login.started",
                &serde_json::json!({}),
            )?;
            let status = auth::login(&config.auth)?;
            emit_hook_event(
                &config.hooks,
                "cli.auth.login.completed",
                &serde_json::json!({ "status": &status }),
            )?;
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
        }
        Commands::Logout => {
            let config = load_config(cli.config.as_deref())?;
            emit_hook_event(
                &config.hooks,
                "cli.auth.logout.started",
                &serde_json::json!({}),
            )?;
            let status = auth::logout(&config.auth)?;
            emit_hook_event(
                &config.hooks,
                "cli.auth.logout.completed",
                &serde_json::json!({ "status": &status }),
            )?;
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
        }
        Commands::AuthStatus => {
            let config = load_config(cli.config.as_deref())?;
            emit_hook_event(
                &config.hooks,
                "cli.auth.status.started",
                &serde_json::json!({}),
            )?;
            let status = auth::current_status(&config.auth)?;
            emit_hook_event(
                &config.hooks,
                "cli.auth.status.completed",
                &serde_json::json!({ "status": &status }),
            )?;
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
        }
        Commands::Agent(args) => agent::run_agent(
            args.socket.as_deref(),
            args.tcp.as_deref(),
            args.stdio,
            args.agent_id.as_deref(),
        ),
        Commands::Micro(args) => agent::run_micro_agent(
            args.socket.as_deref(),
            args.tcp.as_deref(),
            args.stdio,
            args.agent_id.as_deref(),
        ),
    }
}

fn to_action(value: ActionArg) -> CrudAction {
    match value {
        ActionArg::Create => CrudAction::Create,
        ActionArg::Read => CrudAction::Read,
        ActionArg::Update => CrudAction::Update,
        ActionArg::Delete => CrudAction::Delete,
    }
}

fn read_secret_from_stdin(label: &str) -> Result<String> {
    print!("{}: ", label);
    io::stdout().flush().context("failed to flush stdout")?;
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .context("failed to read input")?;
    let value = input.trim().to_string();
    if value.is_empty() {
        anyhow::bail!("{} cannot be empty", label);
    }
    Ok(value)
}
