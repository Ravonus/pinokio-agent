/** Request payload parsed from PINOKIO_PLUGIN_REQUEST_JSON. */
export interface PluginRequest {
  resource: string;
  action: string;
  summary?: string;
  target?: string;
  llm_profile?: string;
  runtime?: string;
  channel?: string;
  container_image?: string;
  [key: string]: unknown;
}

/** Agent spec parsed from PINOKIO_PLUGIN_SPEC_JSON. */
export interface PluginSpec {
  plugin?: string;
  [key: string]: unknown;
}

/** Combined plugin context (request + spec). */
export interface PluginContext {
  request: PluginRequest;
  spec: PluginSpec;
}

/** Request payload parsed from PINOKIO_CONNECTION_REQUEST_JSON. */
export interface ConnectionRequest {
  action?: string;
  summary?: string;
  target?: string;
  [key: string]: unknown;
}

/** Connection spec parsed from PINOKIO_CONNECTION_SPEC_JSON. */
export interface ConnectionSpec {
  [key: string]: unknown;
}

/** Combined connection context (request + spec + name). */
export interface ConnectionContext {
  request: ConnectionRequest;
  spec: ConnectionSpec;
  name: string | null;
}

/** Child task spawn request emitted via `spawn_child` key. */
export interface SpawnChildRequest {
  summary: string;
  resource: string;
  action: string;
  target?: string | null;
  runtime?: string;
  container_image?: string | null;
  container_network?: string;
  llm_profile?: string | null;
  [key: string]: unknown;
}

/** Named hook extension request emitted via `hook_request` key. */
export interface HookRequest {
  name: string;
  payload: Record<string, unknown>;
}

/** Socket bus operation request. */
export interface SocketRequest {
  op: 'publish' | 'read' | 'consume';
  channel: string;
  payload?: unknown;
  max_messages?: number;
  since_seq?: number;
  sender_filter?: string;
}

/** Options for socket read/consume operations. */
export interface SocketReadOptions {
  max_messages?: number;
  since_seq?: number;
  sender_filter?: string;
}

/* ------------------------------------------------------------------ */
/*  Chat DB types                                                      */
/* ------------------------------------------------------------------ */

/** Connection parameters for the chat database. */
export interface ChatDbConnection {
  container: string;
  database: string;
  user: string;
  password: string;
  timeoutMs: number;
}

/** A chat session (conversation thread). */
export interface ChatSession {
  id: number;
  session_key: string;
  channel: string;
  agent_id: string | null;
  caller_agent_id: string | null;
  caller_resource: string | null;
  llm_profile: string | null;
  status: string;
  metadata: Record<string, unknown>;
  tags: string[];
  summary: string | null;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A single chat message (conversation turn). */
export interface ChatMessage {
  id: number;
  session_id: number;
  role: string;
  content: string;
  turn_index: number;
  metadata: Record<string, unknown>;
  tags: string[];
  importance: number;
  flagged_for_memory: boolean;
  llm_profile: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  routed_resource: string | null;
  routed_action: string | null;
  response_mode: string | null;
  token_estimate: number | null;
  created_at: string;
}

/** Cross-reference linking a chat message to a memory entry. */
export interface ChatMemoryRef {
  id: number;
  message_id: number;
  session_id: number;
  memory_namespace: string;
  memory_key: string;
  ref_type: string;
  excerpt: string | null;
  created_at: string;
}

/** Options for inserting a chat message. */
export interface InsertMessageOptions {
  session_id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  turn_index: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  importance?: number;
  flagged_for_memory?: boolean;
  llm_profile?: string;
  llm_provider?: string;
  llm_model?: string;
  routed_resource?: string;
  routed_action?: string;
  response_mode?: string;
  token_estimate?: number;
}

/** Options for querying chat messages. */
export interface QueryMessagesOptions {
  session_id?: number;
  channel?: string;
  agent_id?: string;
  role?: string;
  flagged_for_memory?: boolean;
  min_importance?: number;
  tags?: string[];
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/** Options for flagging a chat message for memory. */
export interface FlagMessageOptions {
  message_id: number;
  importance?: number;
  tags?: string[];
  flagged_for_memory?: boolean;
}

/** Options for creating a memory cross-reference. */
export interface CreateMemoryRefOptions {
  message_id: number;
  session_id: number;
  memory_namespace: string;
  memory_key: string;
  ref_type?: string;
  excerpt?: string;
}
