use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CrudAction {
    Create,
    Read,
    Update,
    Delete,
}

impl CrudAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Read => "read",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IsolationMode {
    Host,
    Container,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionKind {
    PlaywrightRead,
    PluginCommand,
    ConnectionCommand,
    Noop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequest {
    pub id: String,
    pub summary: String,
    pub resource: String,
    pub action: CrudAction,
    pub target: Option<String>,
    pub runtime: Option<String>,
    pub container_image: Option<String>,
    pub container_network: Option<String>,
    pub llm_profile: Option<String>,
    #[serde(default)]
    pub caller_task_id: Option<String>,
    #[serde(default)]
    pub caller_agent_id: Option<String>,
    #[serde(default)]
    pub caller_resource: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildSpawnRequest {
    pub summary: String,
    pub resource: String,
    pub action: CrudAction,
    pub target: Option<String>,
    pub runtime: Option<String>,
    pub container_image: Option<String>,
    pub container_network: Option<String>,
    pub llm_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub id: String,
    pub resource: String,
    pub action: CrudAction,
    pub isolation: IsolationMode,
    pub execution: ExecutionKind,
    pub connector: Option<String>,
    #[serde(default)]
    pub connection: Option<String>,
    #[serde(default)]
    pub connection_command: Option<String>,
    pub plugin: Option<String>,
    pub plugin_command: Option<String>,
    #[serde(default)]
    pub allow_spawn_child: bool,
    #[serde(default)]
    pub allow_hook_requests: bool,
    #[serde(default)]
    pub permissions: AgentPermissions,
    #[serde(default)]
    pub skills: Vec<AgentSkill>,
    pub container_image: Option<String>,
    pub container_network: Option<String>,
    pub llm_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct AgentPermissions {
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub update: bool,
    #[serde(default)]
    pub delete: bool,
    #[serde(default)]
    pub spawn_child: bool,
    #[serde(default)]
    pub hook_extensions: bool,
    #[serde(default)]
    pub network: bool,
    #[serde(default)]
    pub filesystem_read: bool,
    #[serde(default)]
    pub filesystem_write: bool,
    #[serde(default)]
    pub exec: bool,
    #[serde(default)]
    pub memory_read: bool,
    #[serde(default)]
    pub memory_write: bool,
    #[serde(default)]
    pub playwright: bool,
}

impl AgentPermissions {
    pub fn allows_action(&self, action: CrudAction) -> bool {
        match action {
            CrudAction::Create => self.create,
            CrudAction::Read => self.read,
            CrudAction::Update => self.update,
            CrudAction::Delete => self.delete,
        }
    }

    pub fn set_action(&mut self, action: CrudAction, allowed: bool) {
        match action {
            CrudAction::Create => self.create = allowed,
            CrudAction::Read => self.read = allowed,
            CrudAction::Update => self.update = allowed,
            CrudAction::Delete => self.delete = allowed,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiLayerKind {
    OpenaiCompatible,
    AnthropicMessages,
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiLayerRuntime {
    pub kind: ApiLayerKind,
    pub base_url: Option<String>,
    pub credential: Option<LlmCredentialRuntime>,
    pub command: Option<String>,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCredentialRuntime {
    pub name: String,
    pub provider: String,
    pub mode: String,
    pub token: String,
    pub source: String,
    #[serde(default)]
    pub env: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRuntimeProfile {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub max_tokens: u32,
    pub temperature: f32,
    pub fallback: Option<String>,
    pub system_prompt: Option<String>,
    pub layer: ApiLayerRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildRuntimePolicy {
    pub allow_spawn: bool,
    pub allow_hook_requests: bool,
    pub max_depth: u8,
    pub require_container_parent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRequest {
    pub name: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SocketChannelOp {
    Publish,
    Read,
    Consume,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketChannelRequest {
    pub op: SocketChannelOp,
    pub channel: String,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub max_messages: Option<usize>,
    #[serde(default)]
    pub since_seq: Option<u64>,
    #[serde(default)]
    pub sender_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ManagerMessage {
    Run {
        request: TaskRequest,
        spec: AgentSpec,
        llm: Option<LlmRuntimeProfile>,
        child_policy: ChildRuntimePolicy,
    },
    SpawnChildResponse {
        approved: bool,
        report: Option<TaskReport>,
        error: Option<String>,
    },
    HookResponse {
        approved: bool,
        data: Option<Value>,
        error: Option<String>,
    },
    SocketResponse {
        approved: bool,
        data: Option<Value>,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Result {
        agent_id: String,
        summary: String,
        data: Value,
    },
    Error {
        agent_id: String,
        error: String,
    },
    SpawnChildRequest {
        agent_id: String,
        reason: String,
        request: ChildSpawnRequest,
    },
    HookRequest {
        agent_id: String,
        request: HookRequest,
    },
    SocketRequest {
        agent_id: String,
        request: SocketChannelRequest,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResult {
    pub spec: AgentSpec,
    pub summary: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskReport {
    pub task_id: String,
    pub task_summary: String,
    pub agents: Vec<AgentResult>,
}
