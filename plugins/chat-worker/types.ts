/**
 * Type definitions for the chat-worker agent plugin.
 */

export interface TargetMeta {
  [key: string]: unknown;
}

export interface ChatLlmResult {
  text: string;
  profile: string;
  provider: string;
  model: string;
}

export interface ProbeResult {
  ok: boolean;
  host: string | null;
  errors: string[];
}

export interface PluginCatalog {
  schema?: string;
  plugins?: PluginEntry[];
  [key: string]: unknown;
}

export interface PluginEntry {
  manifest_id?: string;
  name?: string;
  description?: string;
  resources?: string[];
  [key: string]: unknown;
}

export interface ExplorerTarget {
  scope_dir?: string;
  desired_action?: string;
  channel?: string;
  dry_run?: boolean;
  response_format?: string;
  path?: string;
  query?: string;
  operation?: string;
  cleanup_profile?: string;
  recursive?: boolean;
  extensions?: string[];
  min_size_bytes?: number;
  kind?: string;
  content?: string;
  new_name?: string;
  destination?: string;
  [key: string]: unknown;
}

export interface ExplorerCall {
  action: string;
  target: ExplorerTarget;
}

export interface ExplorerPlannerDecision {
  route?: string;
  action?: string;
  target?: ExplorerTarget;
  chat_response?: string;
  needs_clarification?: string;
  [key: string]: unknown;
}

export interface PendingFilesystemState {
  action?: string;
  target?: ExplorerTarget;
  question?: string;
  requested_at?: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ChatChannelState {
  last_file_path?: string;
  last_scope_dir?: string;
  pending_filesystem?: PendingFilesystemState | null;
  last_browser_url?: string;
  last_browser_runtime?: string;
  last_browser_desired_action?: string;
  last_browser_cleanup_intent?: boolean;
  last_browser_policy_needed?: boolean;
  last_browser_workflow_state?: string;
  last_browser_workflow_updated_at?: string;
  last_browser_workflow_event?: string;
  last_browser_last_transition?: string;
  last_browser_pending_step?: string;
  last_browser_last_error?: string;
  conversation?: ConversationTurn[];
  last_assistant_question?: string | null;
  updated_at: string;
}

export type BrowserWorkflowState =
  | 'idle'
  | 'needs_ready'
  | 'probing'
  | 'needs_policy'
  | 'needs_pilot_approval'
  | 'needs_user_step'
  | 'executing'
  | 'challenge_detected'
  | 'human_required';

export type BrowserWorkflowEventType =
  | 'RESET'
  | 'REQUIRE_READY'
  | 'START_PROBING'
  | 'REQUIRE_POLICY'
  | 'REQUIRE_PILOT_APPROVAL'
  | 'REQUIRE_USER_STEP'
  | 'START_EXECUTION'
  | 'REQUIRE_CHALLENGE'
  | 'REQUIRE_HUMAN';

export interface PlaywrightTarget {
  [key: string]: unknown;
}

export interface PlaywrightCall {
  action: string;
  target: PlaywrightTarget;
}

export interface PluginIntentDecision {
  resource: 'plugin:playwright_agent' | 'plugin:explorer_agent' | 'chat' | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string | null;
}

export interface BrowserContinuationSignal {
  isFollowUp: boolean;
  event: BrowserWorkflowEventType | null;
}

export interface CleanupPolicyPreset {
  choice: '1' | '2' | '3';
  label: string;
  policyText: string;
}

export interface BuildExplorerOptions {
  channel?: string;
  response_format?: string;
  last_file_path?: string;
}

export interface BuildPlaywrightOptions {
  channel: string;
  responseFormat: string | null;
  lastBrowserUrl?: string | null;
  lastBrowserRuntime?: string | null;
  lastBrowserDesiredAction?: string | null;
  lastBrowserCleanupIntent?: boolean | null;
  lastBrowserPolicyNeeded?: boolean | null;
  lastBrowserWorkflowState?: BrowserWorkflowState | null;
  browserSkillExportRequest?: boolean;
  browserSkillName?: string | null;
  continueBrowserThread?: boolean;
}

export interface ExplorerHeuristicResult {
  should_route: boolean;
  confidence: 'high' | 'low';
  call: ExplorerCall | null;
  source: 'pending' | 'fallback' | 'none';
}

export interface ChatDbMeta {
  response_mode?: string;
  llm_profile?: string;
  llm_provider?: string;
  llm_model?: string;
  routed_resource?: string;
  routed_action?: string;
}

export const EXPLORER_RESOURCE = 'plugin:explorer_agent' as const;
export const PLAYWRIGHT_RESOURCE = 'plugin:playwright_agent' as const;
