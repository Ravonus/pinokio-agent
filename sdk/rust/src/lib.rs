use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookRequest<T> {
    pub name: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SocketChannelOp {
    Publish,
    Read,
    Consume,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketChannelRequest<T = serde_json::Value> {
    pub op: SocketChannelOp,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildSpawnRequest {
    pub summary: String,
    pub resource: String,
    pub action: String,
    pub target: Option<String>,
    pub runtime: Option<String>,
    pub container_image: Option<String>,
    pub container_network: Option<String>,
    pub llm_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResponse<T> {
    #[serde(flatten)]
    pub data: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_child: Option<ChildSpawnRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_request: Option<HookRequest<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket_request: Option<SocketChannelRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket_requests: Option<Vec<SocketChannelRequest>>,
}

pub fn plugin_request_json() -> Option<String> {
    std::env::var("PINOKIO_PLUGIN_REQUEST_JSON").ok()
}

pub fn connection_request_json() -> Option<String> {
    std::env::var("PINOKIO_CONNECTION_REQUEST_JSON").ok()
}
