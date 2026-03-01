import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createActor, createMachine } from 'xstate';
import { pluginContext, respond, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest, ChatDbConnection, ChatSession } from '../sdk/typescript/pinokio-sdk.ts';
import {
  resolveChatDbConnection,
  ensureChatSchema,
  findOrCreateSession,
  insertMessage,
  updateSessionCounters,
  autoFlagImportance,
  getSessionMessages,
  listSessions,
} from '../sdk/typescript/chat-db.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);
const EXPLORER_RESOURCE: string = 'plugin:explorer_agent';
const PLAYWRIGHT_RESOURCE: string = 'plugin:playwright_agent';
const DEFAULT_AUTH_DOMAIN_HINTS: string[] = [
  'mail.google.com',
  'accounts.google.com',
  'gmail.com',
  'outlook.live.com',
  'login.live.com',
  'live.com',
  'outlook.com',
  'hotmail.com',
  'outlook.office.com',
  'office.com',
  'account.microsoft.com',
  'twitch.tv',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'discord.com',
  'slack.com'
];
const DEFAULT_PLAYWRIGHT_SERVICE_URL_MAP: Array<{ keyword: string; url: string }> = [
  { keyword: 'gmail', url: 'https://mail.google.com/' },
  { keyword: 'hotmail', url: 'https://outlook.live.com/mail/' },
  { keyword: 'outlook', url: 'https://outlook.live.com/mail/' },
  { keyword: 'twitch', url: 'https://www.twitch.tv/' },
  { keyword: 'twitter', url: 'https://x.com/' },
  { keyword: 'x.com', url: 'https://x.com/' },
  { keyword: 'linkedin', url: 'https://www.linkedin.com/' },
  { keyword: 'instagram', url: 'https://www.instagram.com/' },
  { keyword: 'facebook', url: 'https://www.facebook.com/' },
  { keyword: 'youtube', url: 'https://www.youtube.com/' },
  { keyword: 'discord', url: 'https://discord.com/' },
  { keyword: 'slack', url: 'https://app.slack.com/' },
  { keyword: 'notion', url: 'https://www.notion.so/' },
  { keyword: 'jira', url: 'https://www.atlassian.com/software/jira' },
  { keyword: 'asana', url: 'https://app.asana.com/' },
  { keyword: 'trello', url: 'https://trello.com/' },
  { keyword: 'shopify', url: 'https://admin.shopify.com/' }
];
const COMMON_FILE_EXTENSIONS: Set<string> = new Set([
  'txt', 'md', 'pdf', 'csv', 'json', 'yaml', 'yml', 'xml', 'toml', 'ini',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'css', 'scss', 'sass', 'less',
  'rs', 'py', 'java', 'kt', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'php',
  'rb', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'db', 'sqlite',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'avi', 'mkv',
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
]);

interface TargetMeta {
  [key: string]: unknown;
}

interface ChatLlmResult {
  text: string;
  profile: string;
  provider: string;
  model: string;
}

interface ProbeResult {
  ok: boolean;
  host: string | null;
  errors: string[];
}

interface PluginCatalog {
  schema?: string;
  plugins?: PluginEntry[];
  [key: string]: unknown;
}

interface PluginEntry {
  manifest_id?: string;
  name?: string;
  description?: string;
  resources?: string[];
  [key: string]: unknown;
}

interface ExplorerTarget {
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

interface ExplorerCall {
  action: string;
  target: ExplorerTarget;
}

interface ExplorerPlannerDecision {
  route?: string;
  action?: string;
  target?: ExplorerTarget;
  chat_response?: string;
  needs_clarification?: string;
  [key: string]: unknown;
}

interface PendingFilesystemState {
  action?: string;
  target?: ExplorerTarget;
  question?: string;
  requested_at?: string;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

interface ChatChannelState {
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

type BrowserWorkflowState =
  | 'idle'
  | 'needs_ready'
  | 'probing'
  | 'needs_policy'
  | 'needs_pilot_approval'
  | 'needs_user_step'
  | 'executing'
  | 'challenge_detected'
  | 'human_required';

type BrowserWorkflowEventType =
  | 'RESET'
  | 'REQUIRE_READY'
  | 'START_PROBING'
  | 'REQUIRE_POLICY'
  | 'REQUIRE_PILOT_APPROVAL'
  | 'REQUIRE_USER_STEP'
  | 'START_EXECUTION'
  | 'REQUIRE_CHALLENGE'
  | 'REQUIRE_HUMAN';

interface PlaywrightTarget {
  [key: string]: unknown;
}

interface PlaywrightCall {
  action: string;
  target: PlaywrightTarget;
}

interface PluginIntentDecision {
  resource: typeof PLAYWRIGHT_RESOURCE | typeof EXPLORER_RESOURCE | 'chat' | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string | null;
}

function firstJsonStart(text: string): number {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

function parseJsonOutput(raw: unknown): unknown {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = firstJsonStart(trimmed);
    if (start < 0) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function parseTargetMeta(target: unknown): TargetMeta {
  if (typeof target !== 'string') {
    return {};
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.startsWith('{')) {
    return { message: trimmed };
  }
  const parsed = parseJsonOutput(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as TargetMeta;
}

function normalizeMessage(summary: unknown, targetMeta: TargetMeta): string {
  const targetMessage =
    typeof targetMeta.message === 'string' ? targetMeta.message.trim() : '';
  if (targetMessage) {
    return targetMessage;
  }

  const summaryText = typeof summary === 'string' ? summary.trim() : '';
  if (summaryText) {
    return summaryText;
  }

  return 'Hello';
}

function normalizeRuntime(value: unknown): string {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'unsafe_host' || runtime === 'host') {
    return 'unsafe_host';
  }
  return 'container';
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toBool(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(max, Math.max(min, Math.trunc(value)));
  }
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function shouldUseChatDb(): boolean {
  return toBool(process.env.PINOKIO_CHAT_DB_ENABLED, true);
}

function resolveChatDbConnectionWithTimeout(defaultTimeoutMs: number): ChatDbConnection {
  const timeoutMs = toInt(
    process.env.PINOKIO_CHAT_DB_TIMEOUT_MS,
    defaultTimeoutMs,
    500,
    60000
  );
  return resolveChatDbConnection({ timeoutMs });
}

function resolveAgentBinary(): string {
  const candidates: string[] = [
    process.env.PINOKIO_AGENT_BIN,
    'pinokio-agent',
    '/usr/local/bin/pinokio-agent',
    './target/debug/pinokio-agent',
    './target/release/pinokio-agent'
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      env: process.env
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return 'pinokio-agent';
}

function buildContainerLlmEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const childHome =
    typeof env.PINOKIO_CHILD_HOME === 'string' && env.PINOKIO_CHILD_HOME.trim()
      ? env.PINOKIO_CHILD_HOME.trim()
      : '/var/lib/pinokio-oauth';
  const childBins = [`${childHome}/.npm-global/bin`, `${childHome}/.local/bin`];
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';

  env.PINOKIO_CHILD_MODE = '1';
  env.PINOKIO_CHILD_HOME = childHome;
  env.PATH = `${childBins.join(':')}${pathValue ? `:${pathValue}` : ''}`;
  return env;
}

interface RunChatLlmOptions {
  profile: string;
  prompt: string;
  timeoutMs?: number;
}

function runChatLlm({ profile, prompt, timeoutMs = 240000 }: RunChatLlmOptions): ChatLlmResult {
  const agentBin = resolveAgentBinary();
  const out = spawnSync(agentBin, ['llm', '--profile', profile, '--prompt', prompt], {
    encoding: 'utf8',
    env: buildContainerLlmEnv(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 4
  });

  if (out.error) {
    if (out.error && (out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`chat llm timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run ${agentBin} llm: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `chat llm command failed (${out.status}): ${(out.stderr || out.stdout || '').trim()}`
    );
  }

  const payload = parseJsonOutput(out.stdout) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('chat llm command returned non-JSON output');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    throw new Error('chat llm response was empty');
  }

  return {
    text,
    profile,
    provider: typeof payload.provider === 'string' ? payload.provider : 'unknown',
    model: typeof payload.model === 'string' ? payload.model : 'unknown'
  };
}

function resolveProbeHosts(profile: string): string[] {
  const normalized = String(profile || '').trim().toLowerCase();
  if (normalized.includes('claude')) {
    return ['api.anthropic.com', 'claude.ai'];
  }
  if (
    normalized.includes('codex') ||
    normalized.includes('openai') ||
    normalized.includes('chatgpt')
  ) {
    return ['api.openai.com', 'chatgpt.com', 'openai.com'];
  }
  return ['api.openai.com', 'api.anthropic.com', 'openai.com', 'claude.ai'];
}

function probeHttpsHost(host: string, timeoutMs: number = 5000): Promise<void> {
  const effectiveTimeout = Math.max(1000, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const failProbe = (detail: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${host} -> ${detail}`));
    };
    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const req = https.request(
      { host, method: 'HEAD', path: '/', servername: host },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 100) {
          succeed();
          return;
        }
        failProbe(`unexpected HTTPS status ${String(res.statusCode)}`);
      }
    );
    req.on('error', (error: Error & { code?: string }) => {
      const detail =
        error && typeof error === 'object'
          ? `${String(error.code || 'error')}: ${String(error.message || 'unknown error')}`
          : String(error || 'unknown error');
      failProbe(detail);
    });
    req.setTimeout(effectiveTimeout, () => {
      req.destroy();
      failProbe(`timeout after ${effectiveTimeout}ms`);
    });
    req.end();
  });
}

async function probeAnyHttpsHost(hosts: string[], timeoutMs: number = 5000, rounds: number = 2): Promise<ProbeResult> {
  const uniqueHosts = Array.from(new Set((hosts || []).filter(Boolean)));
  if (uniqueHosts.length === 0) {
    return { ok: false, host: null, errors: ['no probe hosts configured'] };
  }

  const failures: string[] = [];
  const totalRounds = Math.max(1, Number.parseInt(String(rounds), 10) || 1);
  for (let round = 1; round <= totalRounds; round += 1) {
    for (const host of uniqueHosts) {
      try {
        await probeHttpsHost(host, timeoutMs);
        return { ok: true, host, errors: failures };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`round ${round}: ${detail}`);
      }
    }
  }

  return { ok: false, host: null, errors: failures };
}

function parseJsonLinesReverse(raw: unknown, maxLines: number = 64): Record<string, unknown>[] {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
    const parsed = parseJsonOutput(lines[i]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.push(parsed as Record<string, unknown>);
    }
  }
  return out;
}

function resolveSocketBusPluginsIndexPath(): string | null {
  const busDir = asOptionalString(process.env.PINOKIO_SOCKET_BUS_DIR);
  if (!busDir) {
    return null;
  }
  return path.join(busDir, 'plugins_index.jsonl');
}

function sanitizeStateToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
}

function resolveChannelStatePaths(channel: string): string[] {
  const stateFile = `chat_state_${sanitizeStateToken(channel)}.json`;
  const childHome = asOptionalString(process.env.PINOKIO_CHILD_HOME);
  const candidates = [
    asOptionalString(process.env.PINOKIO_CHAT_STATE_DIR),
    asOptionalString(process.env.PINOKIO_SOCKET_BUS_DIR),
    asOptionalString(process.env.PINOKIO_STATE_DIR),
    childHome ? path.join(childHome, 'state') : null,
    '/var/lib/pinokio-agent/state',
    '/app/.pinokio-agent/state',
    '/tmp'
  ].filter(Boolean) as string[];

  return Array.from(new Set(candidates)).map((baseDir) => path.join(baseDir, stateFile));
}

function readChannelStateFromPath(statePath: string): ChatChannelState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as ChatChannelState;
}

function normalizePendingFilesystem(value: unknown): PendingFilesystemState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const action = normalizeExplorerAction(raw.action);
  const question = asOptionalString(raw.question);
  const requestedAt = asOptionalString(raw.requested_at);
  const target =
    raw.target && typeof raw.target === 'object' && !Array.isArray(raw.target)
      ? { ...(raw.target as ExplorerTarget) }
      : null;
  if (!action && !question && !requestedAt && !target) {
    return null;
  }
  return {
    action: action || undefined,
    target: target || undefined,
    question: question || undefined,
    requested_at: requestedAt || undefined
  };
}

function normalizeConversation(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ConversationTurn[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const roleRaw = asOptionalString(record.role)?.toLowerCase();
    const role: ConversationTurn['role'] =
      roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : 'user';
    const content = asOptionalString(record.content);
    if (!content) {
      continue;
    }
    const at = asOptionalString(record.at) || new Date().toISOString();
    out.push({ role, content, at });
  }
  return out.slice(-16);
}

function appendConversationTurn(
  turns: ConversationTurn[],
  role: ConversationTurn['role'],
  content: string
): ConversationTurn[] {
  const text = asOptionalString(content);
  if (!text) {
    return turns.slice(-16);
  }
  return [
    ...turns,
    {
      role,
      content: text,
      at: new Date().toISOString()
    }
  ].slice(-16);
}

function conversationSummaryForPrompt(turns: ConversationTurn[], maxTurns: number = 8): string {
  if (!Array.isArray(turns) || turns.length === 0) {
    return '';
  }
  return turns
    .slice(-Math.max(1, maxTurns))
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    .join('\n');
}

function inferAssistantFollowUpQuestion(text: string): string | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const last = lines[lines.length - 1];
  if (!last.endsWith('?')) {
    return null;
  }
  return last.slice(0, 400);
}

function looksLikeExplicitNewConversation(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\bnew\s+(conversation|task|request|topic|question)\b/.test(lower) ||
    /\bdifferent\s+(task|request|topic|question)\b/.test(lower) ||
    /\bstart\s+over\b/.test(lower) ||
    /\breset\b/.test(lower) ||
    /\bnever\s+mind\b/.test(lower) ||
    /\bnvm\b/.test(lower) ||
    /\bignore\s+(that|previous|last)\b/.test(lower)
  );
}

function looksLikeBrowserWorkflowCancelMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(cancel|stop|abort|end|exit|reset|clear)\b/.test(lower) &&
    /\b(playwright|browser|automation|probe|workflow|cleanup)\b/.test(lower)
  );
}

function looksLikeBrowserWorkflowStatusMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(browser|playwright|automation|probe|workflow)\b/.test(lower) &&
    /\b(status|state|progress|where are we|what step)\b/.test(lower)
  );
}

function looksLikeBrowserWorkflowResumeMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(resume|continue|proceed|carry on|keep going|pick up)\b/.test(lower) &&
    /\b(browser|playwright|automation|probe|workflow)\b/.test(lower)
  );
}

function shouldBiasToConversationFollowUp(params: {
  message: string;
  pendingFilesystem: PendingFilesystemState | null;
  lastAssistantQuestion: string | null;
  browserPolicyPending: boolean;
  browserWorkflowEvent?: BrowserWorkflowEventType | null;
}): boolean {
  if (looksLikeExplicitNewConversation(params.message)) {
    return false;
  }
  const browserWorkflowActive =
    Boolean(params.browserWorkflowEvent) && params.browserWorkflowEvent !== 'RESET';
  return Boolean(
    params.pendingFilesystem ||
    params.lastAssistantQuestion ||
    params.browserPolicyPending ||
    browserWorkflowActive
  );
}

interface BrowserContinuationSignal {
  isFollowUp: boolean;
  event: BrowserWorkflowEventType | null;
}

function inferBrowserContinuationSignal(params: {
  message: string;
  lastAssistantQuestion: string | null;
  lastBrowserUrl: string | null;
  lastBrowserCleanupIntent: boolean;
  lastBrowserPolicyNeeded: boolean;
  lastBrowserWorkflowState?: BrowserWorkflowState;
}): BrowserContinuationSignal {
  const lower = String(params.message || '').toLowerCase();
  if (!lower.trim()) {
    return { isFollowUp: false, event: null };
  }
  if (!params.lastBrowserUrl || looksLikeExplicitNewConversation(params.message)) {
    return { isFollowUp: false, event: null };
  }
  const question = String(params.lastAssistantQuestion || '').toLowerCase();
  const workflowState = normalizeBrowserWorkflowState(params.lastBrowserWorkflowState);
  const workflowEvent = eventForBrowserWorkflowState(workflowState);
  const activeWorkflowEvent =
    workflowEvent === 'RESET' ? null : workflowEvent;
  const cleanupThreadActive =
    params.lastBrowserCleanupIntent || params.lastBrowserPolicyNeeded;
  const askedBrowserFollowUp =
    question.includes('automation browser') ||
    question.includes('reply "ready"') ||
    question.includes('inbox is open') ||
    question.includes('cleanup actions') ||
    question.includes('what counts as junk') ||
    question.includes('delete vs archive') ||
    question.includes('protected senders');
  if (isBrowserFollowupAckMessage(params.message)) {
    if (workflowEvent === 'REQUIRE_READY' || workflowEvent === 'REQUIRE_USER_STEP') {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
    if (workflowEvent === 'REQUIRE_POLICY') {
      return { isFollowUp: true, event: 'REQUIRE_POLICY' };
    }
    if (workflowEvent === 'REQUIRE_PILOT_APPROVAL') {
      return {
        isFollowUp: true,
        event: messageHasCleanupExecutionApproval(params.message)
          ? 'START_EXECUTION'
          : 'REQUIRE_PILOT_APPROVAL'
      };
    }
    return { isFollowUp: true, event: activeWorkflowEvent || 'START_PROBING' };
  }
  if (workflowEvent === 'REQUIRE_READY') {
    if (
      /^(ready|done|ok|okay|continue|go ahead|next|proceed|yes)\b/.test(lower) ||
      /\b(inbox is open|signed in|logged in|mfa done|captcha done)\b/.test(lower)
    ) {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
    return { isFollowUp: false, event: 'REQUIRE_READY' };
  }
  if (workflowEvent === 'REQUIRE_POLICY') {
    if (
      Boolean(parseCleanupPolicyPreset(params.message)) ||
      messageHasCleanupPolicyDetails(params.message)
    ) {
      return { isFollowUp: true, event: 'REQUIRE_PILOT_APPROVAL' };
    }
    if (
      messageRequestsNetworkCandidatePreview(params.message) ||
      messageRequestsProbeLabelMode(params.message) ||
      messageRequestsProbeLabelReset(params.message)
    ) {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
    return { isFollowUp: false, event: 'REQUIRE_POLICY' };
  }
  if (workflowEvent === 'REQUIRE_PILOT_APPROVAL') {
    if (messageHasCleanupExecutionApproval(params.message)) {
      return { isFollowUp: true, event: 'START_EXECUTION' };
    }
    if (messageRequestsNetworkCandidatePreview(params.message)) {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
    return { isFollowUp: false, event: 'REQUIRE_PILOT_APPROVAL' };
  }
  if (workflowEvent === 'REQUIRE_USER_STEP') {
    return { isFollowUp: true, event: 'REQUIRE_USER_STEP' };
  }
  if (workflowEvent === 'REQUIRE_HUMAN') {
    if (isBrowserFollowupAckMessage(params.message)) {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
    return { isFollowUp: true, event: 'REQUIRE_HUMAN' };
  }
  if (workflowEvent === 'REQUIRE_CHALLENGE') {
    if (isBrowserFollowupAckMessage(params.message)) {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
    if (looksLikeBrowserWorkflowStatusMessage(params.message)) {
      return { isFollowUp: true, event: 'REQUIRE_CHALLENGE' };
    }
    return { isFollowUp: true, event: 'REQUIRE_CHALLENGE' };
  }
  if (workflowEvent === 'START_EXECUTION') {
    if (looksLikeBrowserWorkflowStatusMessage(params.message)) {
      return { isFollowUp: true, event: 'START_EXECUTION' };
    }
    if (looksLikeBrowserWorkflowCancelMessage(params.message)) {
      return { isFollowUp: true, event: 'RESET' };
    }
  }
  if (workflowEvent === 'START_PROBING') {
    if (
      looksLikeBrowserWorkflowStatusMessage(params.message) ||
      looksLikeBrowserWorkflowResumeMessage(params.message)
    ) {
      return { isFollowUp: true, event: 'START_PROBING' };
    }
  }
  if (
    cleanupThreadActive &&
    (
      messageRequestsNetworkCandidatePreview(params.message) ||
      messageRequestsProbeLabelMode(params.message) ||
      messageRequestsProbeLabelReset(params.message)
    )
  ) {
    return { isFollowUp: true, event: 'START_PROBING' };
  }
  if (cleanupThreadActive && messageHasCleanupPolicyDetails(params.message)) {
    return { isFollowUp: true, event: 'REQUIRE_PILOT_APPROVAL' };
  }
  if (
    cleanupThreadActive &&
    /\b(junk|spam|newsletter|promo|promotional|marketing|archive|delete|keep|protect|sender|domain|folder|folders|policy|rule|rules|older than|newer than|days|weeks|months)\b/.test(lower)
  ) {
    return { isFollowUp: true, event: activeWorkflowEvent || 'REQUIRE_POLICY' };
  }
  if (!askedBrowserFollowUp) {
    return { isFollowUp: false, event: activeWorkflowEvent };
  }
  if (parseCleanupPolicyPreset(params.message)) {
    return { isFollowUp: true, event: 'REQUIRE_PILOT_APPROVAL' };
  }
  return {
    isFollowUp: /\b(run|execute|apply|proceed|continue|junk|archive|delete|sender|folder|policy|rule|newsletter|promo)\b/.test(lower),
    event: activeWorkflowEvent
  };
}

function buildChannelState(
  existing: ChatChannelState | null,
  patch: Partial<ChatChannelState>
): ChatChannelState {
  const merged: ChatChannelState = {
    ...(existing || { updated_at: new Date().toISOString() }),
    ...patch
  };
  merged.updated_at = new Date().toISOString();
  return merged;
}

function loadChannelState(channel: string): ChatChannelState | null {
  try {
    for (const statePath of resolveChannelStatePaths(channel)) {
      const parsed = readChannelStateFromPath(statePath);
      if (parsed) {
        const parsedRecord = parsed as unknown as Record<string, unknown>;
        const normalizedPending = normalizePendingFilesystem(
          parsedRecord.pending_filesystem
        );
        if (!normalizedPending) {
          delete parsedRecord.pending_filesystem;
        } else {
          parsed.pending_filesystem = normalizedPending;
        }
        const normalizedConversation = normalizeConversation(parsedRecord.conversation);
        if (normalizedConversation.length === 0) {
          delete parsedRecord.conversation;
        } else {
          parsed.conversation = normalizedConversation;
        }
        parsed.last_assistant_question = asOptionalString(parsedRecord.last_assistant_question) ?? undefined;
        parsed.last_browser_url = asOptionalString(parsedRecord.last_browser_url) ?? undefined;
        parsed.last_browser_runtime = asOptionalString(parsedRecord.last_browser_runtime) ?? undefined;
        parsed.last_browser_desired_action =
          normalizeCrudAction(parsedRecord.last_browser_desired_action) ?? undefined;
        parsed.last_browser_cleanup_intent =
          toBool(parsedRecord.last_browser_cleanup_intent, false);
        parsed.last_browser_policy_needed =
          toBool(parsedRecord.last_browser_policy_needed, false);
        parsed.last_browser_workflow_state =
          normalizeBrowserWorkflowState(parsedRecord.last_browser_workflow_state);
        parsed.last_browser_workflow_updated_at =
          asOptionalString(parsedRecord.last_browser_workflow_updated_at) ?? undefined;
        parsed.last_browser_workflow_event =
          asOptionalString(parsedRecord.last_browser_workflow_event) ?? undefined;
        parsed.last_browser_last_transition =
          asOptionalString(parsedRecord.last_browser_last_transition) ?? undefined;
        parsed.last_browser_pending_step =
          asOptionalString(parsedRecord.last_browser_pending_step) ?? undefined;
        parsed.last_browser_last_error =
          asOptionalString(parsedRecord.last_browser_last_error) ?? undefined;
        return parsed;
      }
    }
    if (channel !== 'default') {
      for (const statePath of resolveChannelStatePaths('default')) {
        const parsed = readChannelStateFromPath(statePath);
        if (parsed) {
          const parsedRecord = parsed as unknown as Record<string, unknown>;
          const normalizedPending = normalizePendingFilesystem(
            parsedRecord.pending_filesystem
          );
          if (!normalizedPending) {
            delete parsedRecord.pending_filesystem;
          } else {
            parsed.pending_filesystem = normalizedPending;
          }
          const normalizedConversation = normalizeConversation(parsedRecord.conversation);
          if (normalizedConversation.length === 0) {
            delete parsedRecord.conversation;
          } else {
            parsed.conversation = normalizedConversation;
          }
          parsed.last_assistant_question = asOptionalString(parsedRecord.last_assistant_question) ?? undefined;
          parsed.last_browser_url = asOptionalString(parsedRecord.last_browser_url) ?? undefined;
          parsed.last_browser_runtime = asOptionalString(parsedRecord.last_browser_runtime) ?? undefined;
          parsed.last_browser_desired_action =
            normalizeCrudAction(parsedRecord.last_browser_desired_action) ?? undefined;
          parsed.last_browser_cleanup_intent =
            toBool(parsedRecord.last_browser_cleanup_intent, false);
          parsed.last_browser_policy_needed =
            toBool(parsedRecord.last_browser_policy_needed, false);
          parsed.last_browser_workflow_state =
            normalizeBrowserWorkflowState(parsedRecord.last_browser_workflow_state);
          parsed.last_browser_workflow_updated_at =
            asOptionalString(parsedRecord.last_browser_workflow_updated_at) ?? undefined;
          parsed.last_browser_workflow_event =
            asOptionalString(parsedRecord.last_browser_workflow_event) ?? undefined;
          parsed.last_browser_last_transition =
            asOptionalString(parsedRecord.last_browser_last_transition) ?? undefined;
          parsed.last_browser_pending_step =
            asOptionalString(parsedRecord.last_browser_pending_step) ?? undefined;
          parsed.last_browser_last_error =
            asOptionalString(parsedRecord.last_browser_last_error) ?? undefined;
          return parsed;
        }
      }
    }
  } catch {
    return null;
  }

  // DB fallback: recover conversation from database when filesystem state is missing
  try {
    if (shouldUseChatDb()) {
      const conn = resolveChatDbConnectionWithTimeout(2500);
      ensureChatSchema(conn);
      const sessions = listSessions(conn, { channel, status: 'active', limit: 1 });
      if (sessions.length > 0) {
        const messages = getSessionMessages(conn, sessions[0].id, { limit: 16 });
        if (messages.length > 0) {
          const conversation: ConversationTurn[] = messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
              at: m.created_at,
            }));
          if (conversation.length > 0) {
            return {
              conversation,
              updated_at: sessions[0].updated_at,
            } as ChatChannelState;
          }
        }
      }
    }
  } catch {
    // DB unavailable, fall through
  }

  return null;
}

function writeChannelState(channel: string, state: ChatChannelState): boolean {
  for (const statePath of resolveChannelStatePaths(channel)) {
    try {
      const parent = path.dirname(statePath);
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf8', flag: 'w' });
      return true;
    } catch {
      // Try next candidate location.
    }
  }
  return false;
}

function saveChannelState(channel: string, state: ChatChannelState): void {
  const channels = channel === 'default' ? ['default'] : [channel, 'default'];
  for (const stateChannel of channels) {
    if (writeChannelState(stateChannel, state)) {
      continue;
    }
  }
}

function messageReferencesPriorFile(message: string): boolean {
  const raw = String(message || '');
  if (/\b(?:that|this|the|last|previous)\s+(?:text\s+)?(?:file|document)\b/i.test(raw)) {
    return true;
  }
  if (/\blast\s+file\s+(?:created|made|generated)\b/i.test(raw)) {
    return true;
  }
  return /\b(?:write|put|insert|append|update|edit|replace)\b[\s\S]{0,120}\bit\b/i.test(raw);
}

function loadPluginCatalogFromSocketBus(): PluginCatalog | null {
  const indexPath = resolveSocketBusPluginsIndexPath();
  if (!indexPath || !fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const candidates = parseJsonLinesReverse(raw, 80);
    for (const candidate of candidates) {
      const directPayload =
        candidate && typeof candidate === 'object' && candidate.schema === 'pinokio.plugins.index/v1'
          ? candidate as PluginCatalog
          : null;
      const envelopePayload =
        candidate &&
        typeof candidate === 'object' &&
        candidate.payload &&
        typeof candidate.payload === 'object' &&
        !Array.isArray(candidate.payload) &&
        (candidate.payload as Record<string, unknown>).schema === 'pinokio.plugins.index/v1'
          ? candidate.payload as PluginCatalog
          : null;
      if (directPayload) {
        return directPayload;
      }
      if (envelopePayload) {
        return envelopePayload;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function summarizePluginCatalog(catalog: PluginCatalog | null): string {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return 'Plugin catalog unavailable in this turn.';
  }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  if (plugins.length === 0) {
    return 'Plugin catalog is available but currently empty.';
  }

  const lines: string[] = [];
  for (const plugin of plugins.slice(0, 20)) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      continue;
    }
    const manifestId = asOptionalString(plugin.manifest_id) || 'unknown';
    const name = asOptionalString(plugin.name) || manifestId;
    const description = asOptionalString(plugin.description) || 'no description';
    const resources = Array.isArray(plugin.resources)
      ? plugin.resources.filter((item: unknown) => typeof item === 'string').slice(0, 6).join(', ')
      : 'none';
    lines.push(`- ${name} (${manifestId}): ${description} [resources: ${resources}]`);
  }

  if (plugins.length > 20) {
    lines.push(`- ...and ${plugins.length - 20} more`);
  }

  return lines.length > 0 ? lines.join('\n') : 'Plugin catalog parsed but no readable entries.';
}

function hasResourceInCatalog(catalog: PluginCatalog | null, resource: string): boolean {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return false;
  }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const normalizedResource = String(resource || '').trim().toLowerCase();
  if (!normalizedResource) {
    return false;
  }
  return plugins.some((plugin) => {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      return false;
    }
    const resources = Array.isArray(plugin.resources)
      ? plugin.resources.filter((item: unknown) => typeof item === 'string') as string[]
      : [];
    return resources.some((item) => item.trim().toLowerCase() === normalizedResource);
  });
}

function summarizePluginRoutingHints(catalog: PluginCatalog | null): string {
  const hints: string[] = [];
  if (hasResourceInCatalog(catalog, PLAYWRIGHT_RESOURCE)) {
    hints.push(
      '- Browser/web app tasks (Gmail, Hotmail/Outlook, Twitch, social sites) should route to plugin:playwright_agent.'
    );
    hints.push(
      '- Do not route browser website tasks to Directory Plugin unless the user explicitly asks for local file operations.'
    );
  }
  if (hasResourceInCatalog(catalog, EXPLORER_RESOURCE)) {
    hints.push(
      '- Local host file/folder operations should route to plugin:explorer_agent.'
    );
  }
  return hints.join('\n');
}

function looksLikeBrowserAutomationIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }

  if (/\bwhat\s+is\s+playwright\b/.test(lower)) {
    return false;
  }
  if (/\b(?:use|via|through)\s+playwright\b/.test(lower)) {
    return true;
  }
  if (lower.includes('plugin:playwright_agent') || lower.includes('playwright')) {
    return true;
  }
  if (inferPlaywrightUrlFromMessage(message)) {
    return true;
  }

  const serviceKeywords: string[] = [
    'gmail',
    'hotmail',
    'outlook',
    'outlook.com',
    'outlook.live.com',
    'mail.google.com',
    'inbox',
    'mailbox',
    'twitch',
    'twitter',
    'x.com',
    'linkedin',
    'instagram',
    'facebook',
    'youtube',
    'discord',
    'slack',
    'website',
    'web app',
    'webapp',
    'site',
    'service',
    'platform',
    'portal',
    'dashboard',
    'console',
    'admin',
    'settings',
    'account',
    'workspace',
    'tenant',
    'website',
    'browser',
    'cloudflare',
    'captcha'
  ];
  const automationKeywords: string[] = [
    'organize',
    'automation',
    'automate',
    'triage',
    'reply',
    'respond',
    'post',
    'send',
    'check',
    'go through',
    'scrape',
    'discover',
    'non-headless',
    'headless',
    'login',
    'sign in',
    'mfa',
    '2fa',
    'monitor',
    'classify',
    'tag',
    'label',
    'workflow',
    'rules',
    'filter'
  ];
  const hasServiceKeyword = serviceKeywords.some((keyword) => lower.includes(keyword));
  const hasAutomationKeyword = automationKeywords.some((keyword) => lower.includes(keyword));
  if (hasServiceKeyword && hasAutomationKeyword) {
    return true;
  }
  if (hasServiceKeyword && /\b(?:email|emails|messages|message)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:email|emails)\b/.test(lower) && hasAutomationKeyword) {
    return true;
  }
  if (hasServiceKeyword && /\b(?:login|log in|sign in|mfa|2fa|captcha|cloudflare)\b/.test(lower)) {
    return true;
  }
  return false;
}

function normalizeDetectedUrlCandidate(value: string): string | null {
  let trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^["'`(<\[]+/, '').replace(/[>"'`)\].,;!?]+$/, '');
  if (!trimmed) {
    return null;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function parseServiceUrlMapFromEnv(): Array<{ keyword: string; url: string }> {
  const raw = asOptionalString(process.env.PINOKIO_PLAYWRIGHT_SERVICE_URL_MAP);
  if (!raw) {
    return [];
  }
  const out: Array<{ keyword: string; url: string }> = [];
  const parsed = parseJsonOutput(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const keyword = String(key || '').trim().toLowerCase();
      const normalizedUrl = normalizeDetectedUrlCandidate(String(value || ''));
      if (!keyword || !normalizedUrl) {
        continue;
      }
      out.push({ keyword, url: normalizedUrl });
    }
    return out;
  }
  const rows = raw.split(/[,\n]+/g).map((item) => item.trim()).filter(Boolean);
  for (const row of rows) {
    const idx = row.indexOf('=');
    if (idx <= 0 || idx >= row.length - 1) {
      continue;
    }
    const keyword = row.slice(0, idx).trim().toLowerCase();
    const normalizedUrl = normalizeDetectedUrlCandidate(row.slice(idx + 1));
    if (!keyword || !normalizedUrl) {
      continue;
    }
    out.push({ keyword, url: normalizedUrl });
  }
  return out;
}

function inferPlaywrightUrlFromMessage(message: string): string | null {
  const raw = String(message || '');
  const explicit = raw.match(/\bhttps?:\/\/[^\s"'`<>]+/i);
  if (explicit && explicit[0]) {
    return normalizeDetectedUrlCandidate(explicit[0]);
  }
  const bareDomain = raw.match(
    /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})(\/[^\s"'`<>]*)?/i
  );
  if (bareDomain && bareDomain[0] && !bareDomain[0].includes('@')) {
    const normalized = normalizeDetectedUrlCandidate(bareDomain[0]);
    if (normalized) {
      return normalized;
    }
  }
  const lower = raw.toLowerCase();
  const allMappings = [...parseServiceUrlMapFromEnv(), ...DEFAULT_PLAYWRIGHT_SERVICE_URL_MAP];
  for (const mapping of allMappings) {
    if (!lower.includes(mapping.keyword)) {
      continue;
    }
    const normalized = normalizeDetectedUrlCandidate(mapping.url);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function inferPlaywrightDesiredActionFromMessage(message: string, fallbackAction: string): string {
  const lower = String(message || '').toLowerCase();
  const explicitDeleteIntent =
    lower.includes('delete') ||
    lower.includes('remove') ||
    lower.includes('purge') ||
    lower.includes('trash');
  if (
    lower.includes('organize') ||
    lower.includes('automation') ||
    lower.includes('automate') ||
    lower.includes('triage') ||
    lower.includes('reply') ||
    lower.includes('respond') ||
    lower.includes('send') ||
    lower.includes('post') ||
    lower.includes('manage') ||
    lower.includes('clean up') ||
    lower.includes('cleanup')
  ) {
    return 'update';
  }
  if (lower.includes('plan') && looksLikeBrowserAutomationIntent(message)) {
    return 'update';
  }
  if (
    lower.includes('read') ||
    lower.includes('show') ||
    lower.includes('check') ||
    lower.includes('summarize') ||
    lower.includes('list')
  ) {
    return 'read';
  }
  if (explicitDeleteIntent) {
    return 'delete';
  }
  if (fallbackAction === 'create' || fallbackAction === 'update' || fallbackAction === 'delete') {
    return fallbackAction;
  }
  return 'read';
}

function normalizeCrudAction(value: unknown): string | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'write' || normalized === 'act' || normalized === 'post' || normalized === 'reply') {
    return 'update';
  }
  if (normalized === 'inspect' || normalized === 'discover' || normalized === 'info' || normalized === 'list') {
    return 'read';
  }
  if (normalized === 'create' || normalized === 'read' || normalized === 'update' || normalized === 'delete') {
    return normalized;
  }
  return null;
}

const BROWSER_WORKFLOW_STATE_VALUES: BrowserWorkflowState[] = [
  'idle',
  'needs_ready',
  'probing',
  'needs_policy',
  'needs_pilot_approval',
  'needs_user_step',
  'executing',
  'challenge_detected',
  'human_required'
];

const browserWorkflowMachine = createMachine({
  id: 'browserWorkflow',
  initial: 'idle',
  states: {
    idle: {},
    needs_ready: {},
    probing: {},
    needs_policy: {},
    needs_pilot_approval: {},
    needs_user_step: {},
    executing: {},
    challenge_detected: {},
    human_required: {}
  },
  on: {
    RESET: { target: '.idle' },
    REQUIRE_READY: { target: '.needs_ready' },
    START_PROBING: { target: '.probing' },
    REQUIRE_POLICY: { target: '.needs_policy' },
    REQUIRE_PILOT_APPROVAL: { target: '.needs_pilot_approval' },
    REQUIRE_USER_STEP: { target: '.needs_user_step' },
    START_EXECUTION: { target: '.executing' },
    REQUIRE_CHALLENGE: { target: '.challenge_detected' },
    REQUIRE_HUMAN: { target: '.human_required' }
  }
});

function isBrowserWorkflowState(value: unknown): value is BrowserWorkflowState {
  const candidate = String(value || '').trim().toLowerCase();
  return BROWSER_WORKFLOW_STATE_VALUES.includes(candidate as BrowserWorkflowState);
}

function normalizeBrowserWorkflowState(value: unknown): BrowserWorkflowState {
  const normalized = String(value || '').trim().toLowerCase();
  if (isBrowserWorkflowState(normalized)) {
    return normalized;
  }
  return 'idle';
}

function eventForBrowserWorkflowState(state: BrowserWorkflowState): BrowserWorkflowEventType {
  if (state === 'needs_ready') {
    return 'REQUIRE_READY';
  }
  if (state === 'probing') {
    return 'START_PROBING';
  }
  if (state === 'needs_policy') {
    return 'REQUIRE_POLICY';
  }
  if (state === 'needs_pilot_approval') {
    return 'REQUIRE_PILOT_APPROVAL';
  }
  if (state === 'needs_user_step') {
    return 'REQUIRE_USER_STEP';
  }
  if (state === 'executing') {
    return 'START_EXECUTION';
  }
  if (state === 'challenge_detected') {
    return 'REQUIRE_CHALLENGE';
  }
  if (state === 'human_required') {
    return 'REQUIRE_HUMAN';
  }
  return 'RESET';
}

function transitionBrowserWorkflowState(
  current: BrowserWorkflowState,
  eventType: BrowserWorkflowEventType
): BrowserWorkflowState {
  const actor = createActor(browserWorkflowMachine);
  actor.start();
  if (current !== 'idle') {
    actor.send({ type: eventForBrowserWorkflowState(current) });
  }
  actor.send({ type: eventType });
  const nextValue = actor.getSnapshot().value;
  return normalizeBrowserWorkflowState(nextValue);
}

function resolveBrowserWorkflowStateTimeoutMs(state: BrowserWorkflowState): number {
  if (state === 'needs_ready') {
    return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_READY_MS, 10 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
  }
  if (state === 'needs_policy') {
    return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_POLICY_MS, 15 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
  }
  if (state === 'needs_user_step' || state === 'human_required') {
    return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_USER_STEP_MS, 20 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
  }
  if (state === 'needs_pilot_approval') {
    return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_PILOT_MS, 10 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
  }
  if (state === 'challenge_detected') {
    return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_CHALLENGE_MS, 8 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
  }
  if (state === 'executing') {
    return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_EXEC_MS, 10 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
  }
  return toInt(process.env.PINOKIO_BROWSER_TIMEOUT_PROBING_MS, 12 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
}

function browserWorkflowRecoveryAction(state: BrowserWorkflowState): string {
  if (state === 'needs_ready') {
    return 'Recovery: open target workflow page and click READY.';
  }
  if (state === 'needs_policy') {
    return 'Recovery: provide cleanup policy (or choose 1/2/3).';
  }
  if (state === 'needs_pilot_approval') {
    return 'Recovery: approve one pilot action (PILOT ARCHIVE 1 or PILOT DELETE 1).';
  }
  if (state === 'needs_user_step' || state === 'human_required') {
    return 'Recovery: complete requested browser step, then click READY.';
  }
  if (state === 'challenge_detected') {
    return 'Recovery: complete challenge/captcha in automation browser, then click READY.';
  }
  if (state === 'executing') {
    return 'Recovery: ask browser status, then continue or re-run pilot.';
  }
  return 'Recovery: continue workflow or start a fresh browser task.';
}

function parseTimestampMs(value: unknown): number | null {
  const raw = asOptionalString(value);
  if (!raw) {
    return null;
  }
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function isBrowserWorkflowStateStale(state: BrowserWorkflowState, updatedAt: string | null): boolean {
  if (!isActiveBrowserWorkflowState(state)) {
    return false;
  }
  const updatedMs = parseTimestampMs(updatedAt);
  if (!updatedMs) {
    return false;
  }
  return Date.now() - updatedMs > resolveBrowserWorkflowStateTimeoutMs(state);
}

function isActiveBrowserWorkflowState(value: BrowserWorkflowState): boolean {
  return value !== 'idle';
}

function describeBrowserWorkflowStatus(params: {
  state: BrowserWorkflowState;
  url: string | null;
  cleanupIntent: boolean;
  policyNeeded: boolean;
  pendingStep?: string | null;
  lastTransition?: string | null;
  lastError?: string | null;
}): string {
  const state = params.state;
  const workflowEvent = eventForBrowserWorkflowState(state);
  const location = params.url ? ` on ${params.url}` : '';
  if (workflowEvent === 'RESET' && !params.url) {
    return 'No active browser automation workflow for this chat channel.';
  }
  const telemetrySuffix = [
    params.pendingStep ? ` Pending step: ${params.pendingStep}` : '',
    params.lastTransition ? ` Last transition: ${params.lastTransition}` : '',
    params.lastError ? ` Last error: ${params.lastError}` : ''
  ].join('');
  if (workflowEvent === 'REQUIRE_READY') {
    return `Browser workflow status: waiting for READY${location}. Open the automation browser, complete login/MFA/CAPTCHA, then reply "READY". Timeout: ${Math.round(resolveBrowserWorkflowStateTimeoutMs(state) / 60000)}m. ${browserWorkflowRecoveryAction(state)}${telemetrySuffix}`;
  }
  if (workflowEvent === 'REQUIRE_POLICY') {
    return `Browser workflow status: waiting for cleanup policy${location}. Tell me what counts as junk, delete vs archive behavior, time scope, and protected senders/folders. Timeout: ${Math.round(resolveBrowserWorkflowStateTimeoutMs(state) / 60000)}m. ${browserWorkflowRecoveryAction(state)}${telemetrySuffix}`;
  }
  if (workflowEvent === 'REQUIRE_PILOT_APPROVAL') {
    return `Browser workflow status: waiting for pilot approval${location}. Reply "SHOW CANDIDATES", "PILOT ARCHIVE 1", or "PILOT DELETE 1". Timeout: ${Math.round(resolveBrowserWorkflowStateTimeoutMs(state) / 60000)}m. ${browserWorkflowRecoveryAction(state)}${telemetrySuffix}`;
  }
  if (workflowEvent === 'REQUIRE_USER_STEP') {
    return `Browser workflow status: waiting for your manual input${location}. Reply with the requested step or say "READY" after completing it. Timeout: ${Math.round(resolveBrowserWorkflowStateTimeoutMs(state) / 60000)}m. ${browserWorkflowRecoveryAction(state)}${telemetrySuffix}`;
  }
  if (workflowEvent === 'REQUIRE_HUMAN') {
    return `Browser workflow status: human action required${location}. Complete the requested action in automation browser and reply "READY". Timeout: ${Math.round(resolveBrowserWorkflowStateTimeoutMs(state) / 60000)}m. ${browserWorkflowRecoveryAction(state)}${telemetrySuffix}`;
  }
  if (workflowEvent === 'REQUIRE_CHALLENGE') {
    return `Browser workflow status: anti-bot challenge detected${location}. Complete verification/captcha in automation browser, then reply "READY". Timeout: ${Math.round(resolveBrowserWorkflowStateTimeoutMs(state) / 60000)}m. ${browserWorkflowRecoveryAction(state)}${telemetrySuffix}`;
  }
  if (workflowEvent === 'START_EXECUTION') {
    return `Browser workflow status: execution plan in progress${location}. Say "browser status" for updates, or "cancel browser automation workflow" to stop.${telemetrySuffix}`;
  }
  if (workflowEvent === 'START_PROBING') {
    if (params.cleanupIntent || params.policyNeeded) {
      return `Browser workflow status: probe/discovery active${location}, with cleanup context enabled. Say "continue browser automation workflow" to proceed or "cancel browser automation workflow" to reset.${telemetrySuffix}`;
    }
    return `Browser workflow status: probe/discovery active${location}. Say "continue browser automation workflow" to proceed or "cancel browser automation workflow" to reset.${telemetrySuffix}`;
  }
  return `Browser workflow status: ${state}${location}.${telemetrySuffix}`;
}

function inferCleanupIntentFromMessage(message: string, desiredAction: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (
    lower.includes('cleanup') ||
    lower.includes('clean up') ||
    lower.includes('organize') ||
    lower.includes('triage') ||
    lower.includes('junk') ||
    lower.includes('spam') ||
    lower.includes('inbox zero')
  ) {
    return true;
  }
  const messagingContext =
    lower.includes('email') ||
    lower.includes('emails') ||
    lower.includes('inbox') ||
    lower.includes('mailbox') ||
    lower.includes('messages') ||
    lower.includes('dm');
  const workflowVerb =
    lower.includes('go through') ||
    lower.includes('sort') ||
    lower.includes('filter') ||
    lower.includes('classify') ||
    lower.includes('archive') ||
    lower.includes('delete');
  if (messagingContext && workflowVerb) {
    return true;
  }
  return desiredAction === 'delete' && messagingContext;
}

function messageHasCleanupPolicyDetails(message: string): boolean {
  const raw = String(message || '');
  const lower = raw.toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (parseCleanupPolicyPreset(message)) {
    return true;
  }
  const policySignals: RegExp[] = [
    /\bolder than\b/,
    /\bnewer than\b/,
    /\blast \d+\s*(?:day|days|week|weeks|month|months|year|years)\b/,
    /\bfrom\s+[@\w.-]+\b/,
    /\bsender\b/,
    /\bsubject\b/,
    /\bcontains\b/,
    /\bkeyword\b/,
    /\barchive\b/,
    /\bdelete\b/,
    /\bkeep\b/,
    /\bnever delete\b/,
    /\bprotect\b/,
    /\ballowlist\b/,
    /\bwhitelist\b/,
    /\blabel\b/,
    /\bcategory\b/,
    /\bfolder\b/,
    /\bunread\b/,
    /\bread\b/
  ];
  if (policySignals.some((re) => re.test(lower))) {
    return true;
  }
  return /[:\n].{10,}/.test(raw) && (lower.includes('junk') || lower.includes('rule'));
}

function isBrowserFollowupAckMessage(message: string): boolean {
  const normalized = String(message || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\bnot\s+ready\b/.test(normalized)) {
    return false;
  }
  if (/^(ready|done|ok|okay|continue|go ahead|next|proceed|yes)\b/.test(normalized)) {
    return true;
  }
  if (/\b(i am|i'm|im|we are|we're)\s+ready\b/.test(normalized)) {
    return true;
  }
  return /\bready\b/.test(normalized);
}

function looksLikeBrowserSkillExportIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim() || !lower.includes('skill')) {
    return false;
  }
  if (
    /\b(convert|save|turn|make|export|create|generate|publish)\b/.test(lower) &&
    /\b(skill|workflow)\b/.test(lower)
  ) {
    return true;
  }
  return /\buse this as a skill\b/.test(lower) || /\bskill from this\b/.test(lower);
}

function parseSkillNameFromMessage(message: string): string | null {
  const raw = String(message || '');
  const quoted =
    raw.match(/\b(?:skill\s+name|named|called)\s*[:=]?\s*["'`]([^"'`]{2,80})["'`]/i) ||
    raw.match(/\bas\s+skill\s+["'`]([^"'`]{2,80})["'`]/i);
  const direct =
    raw.match(/\b(?:skill\s+name|named|called)\s*[:=]?\s*([a-z0-9][a-z0-9_.-]{2,80})/i) ||
    raw.match(/\bas\s+([a-z0-9][a-z0-9_.-]{2,80})\s+skill\b/i);
  const candidate = quoted?.[1] || direct?.[1] || '';
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return normalized.length >= 3 ? normalized.slice(0, 80) : null;
}

function messageRequestsProbeLabelMode(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (/\b(enable|start|turn on|open|use)\s+(?:label mode|labels?|annotation mode)\b/.test(lower)) {
    return true;
  }
  if (/\b(label|annotate|mark|tag)\b/.test(lower) && /\b(field|input|button|element|selector|login)\b/.test(lower)) {
    return true;
  }
  return /\bclick-to-label\b/.test(lower);
}

function messageRequestsUseSavedLabels(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\buse\s+(?:my|the)\s+saved\s+labels?\b/.test(lower) ||
    /\bapply\s+(?:my|the)\s+saved\s+labels?\b/.test(lower) ||
    /\bcontinue\b[\s\S]{0,40}\bsaved\s+labels?\b/.test(lower)
  );
}

function messageRequestsProbeLabelReset(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(clear|reset|remove|wipe)\s+(?:saved\s+)?labels?\b/.test(lower) ||
    /\bforget\b[\s\S]{0,40}\blabels?\b/.test(lower)
  );
}

function messageRequestsNetworkCandidatePreview(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\bshow\s+(?:api|network)\s+candidates\b/.test(lower) ||
    /\bshow\s+candidates\b/.test(lower) ||
    /\bnetwork\s+(?:requests?|calls?|analysis|summary)\b/.test(lower) ||
    /\bapi\s+(?:calls?|requests?|candidates?)\b/.test(lower) ||
    /\b(?:show|build|gather|get)\s+(?:a\s+)?(?:site|automation|network|request)?\s*map\b/.test(lower) ||
    /\bmap\s+(?:the|this)\s+(?:site|workflow|flow|requests?|network)\b/.test(lower)
  );
}

function looksLikeBrowserWorkflowControlMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (messageRequestsNetworkCandidatePreview(message)) {
    return true;
  }
  if (messageRequestsProbeLabelMode(message) || messageRequestsProbeLabelReset(message)) {
    return true;
  }
  if (messageRequestsUseSavedLabels(message)) {
    return true;
  }
  if (/\bcontinue\s+with\s+(?:the\s+)?plan\b/.test(lower)) {
    return true;
  }
  if (/\bresume\s+workflow\b/.test(lower) || /\bcancel\s+workflow\b/.test(lower)) {
    return true;
  }
  if (/\bsave\s+probe\s+as\s+skill\b/.test(lower)) {
    return true;
  }
  return false;
}

function messageHasCleanupExecutionApproval(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (/\bpilot\s+(delete|archive)\b/.test(lower)) {
    return true;
  }
  if (
    /\b(approve|approved|go ahead|proceed|run it|execute|do it)\b/.test(lower) &&
    /\b(cleanup|clean up|delete|archive|junk|spam|message|messages|email|emails|inbox)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

function inferCleanupExecutionMode(message: string): string | null {
  const lower = String(message || '').toLowerCase();
  if (/\bpilot\s+delete\b/.test(lower)) {
    return 'pilot_delete';
  }
  if (/\bpilot\s+archive\b/.test(lower)) {
    return 'pilot_archive';
  }
  if (/\bpilot\b/.test(lower)) {
    return 'pilot';
  }
  if (/\barchive\b/.test(lower)) {
    return 'archive';
  }
  if (/\bdelete\b/.test(lower)) {
    return 'delete';
  }
  return null;
}

interface CleanupPolicyPreset {
  choice: '1' | '2' | '3';
  label: string;
  policyText: string;
}

function parseCleanupPolicyPreset(message: string): CleanupPolicyPreset | null {
  const raw = String(message || '').trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  const compact = lower
    .replace(/^[\s"'`([{]+/, '')
    .replace(/[\s"'`)\]}.,:;!?-]+$/, '')
    .trim();

  const isSimpleChoice = compact.length <= 24;
  const isChoice1 =
    (isSimpleChoice && /^(?:option|policy)?\s*1$/.test(compact)) ||
    (isSimpleChoice && /^one$/.test(compact)) ||
    /\bconservative\b/.test(lower);
  const isChoice2 =
    (isSimpleChoice && /^(?:option|policy)?\s*2$/.test(compact)) ||
    (isSimpleChoice && /^two$/.test(compact)) ||
    /\bbalanced\b/.test(lower);
  const isChoice3 =
    (isSimpleChoice && /^(?:option|policy)?\s*3$/.test(compact)) ||
    (isSimpleChoice && /^three$/.test(compact)) ||
    /\baggressive\b/.test(lower);

  if (isChoice1) {
    return {
      choice: '1',
      label: 'conservative',
      policyText:
        'Conservative cleanup policy: archive-only (no permanent delete). Preview candidates first. Treat promotional/newsletter/social/no-reply mail as junk candidates older than 30 days. Keep flagged mail, protected senders/folders, and recent important threads.'
    };
  }
  if (isChoice2) {
    return {
      choice: '2',
      label: 'balanced',
      policyText:
        'Balanced cleanup policy: archive promotional/newsletter/social/no-reply candidates older than 30 days. Delete Junk Email older than 7 days and Deleted Items older than 14 days. Keep flagged mail and protected senders/folders. Run candidate preview and pilot before broader actions.'
    };
  }
  if (isChoice3) {
    return {
      choice: '3',
      label: 'aggressive',
      policyText:
        'Aggressive cleanup policy: after preview, bulk-delete junk candidates by age (promotional/newsletter/social/no-reply older than 30 days, Junk Email older than 7 days, Deleted Items older than 14 days). Preserve protected senders/folders and flagged important mail.'
    };
  }
  return null;
}

function parseDomainListFromEnv(key: string, fallback: string[]): string[] {
  const raw = asOptionalString(process.env[key]);
  if (!raw) {
    return [...fallback];
  }
  const parsed = raw
    .split(/[,\n]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (parsed.length === 0) {
    return [...fallback];
  }
  return Array.from(new Set(parsed));
}

function extractHostFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/^\.+/, '');
  if (!normalizedHost) {
    return false;
  }
  for (const rawPattern of allowlist) {
    const pattern = rawPattern.trim().toLowerCase().replace(/^\.+/, '');
    if (!pattern) {
      continue;
    }
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      if (
        normalizedHost === suffix ||
        normalizedHost.endsWith(`.${suffix}`)
      ) {
        return true;
      }
      continue;
    }
    if (pattern.includes('*')) {
      const escaped = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const re = new RegExp(`^${escaped}$`, 'i');
      if (re.test(normalizedHost)) {
        return true;
      }
      continue;
    }
    if (
      normalizedHost === pattern ||
      normalizedHost.endsWith(`.${pattern}`)
    ) {
      return true;
    }
  }
  return false;
}

function isLikelyAuthenticatedBrowserTask(message: string, url: string | null): boolean {
  const hints = parseDomainListFromEnv('PINOKIO_PLAYWRIGHT_AUTH_DOMAIN_HINTS', DEFAULT_AUTH_DOMAIN_HINTS);
  const host = extractHostFromUrl(url);
  if (host && domainMatchesAllowlist(host, hints)) {
    return true;
  }
  const lower = String(message || '').toLowerCase();
  const keywords: string[] = [
    'gmail',
    'hotmail',
    'outlook',
    'inbox',
    'email',
    'messages',
    'dm',
    'account',
    'profile',
    'login',
    'sign in'
  ];
  return keywords.some((keyword) => lower.includes(keyword));
}

function mapBrowserModeHintToWorkflowState(params: {
  mode: string | null;
  challengeDetected: boolean;
  pendingStep: string | null;
  fallbackState: BrowserWorkflowState;
}): BrowserWorkflowState {
  const mode = String(params.mode || '').trim().toLowerCase();
  if (!mode) {
    return params.fallbackState;
  }
  if (mode === 'discover' || mode === 'plan_only') {
    return params.challengeDetected ? 'challenge_detected' : 'probing';
  }
  if (mode === 'discovery_needs_user' || mode === 'human_required') {
    if (params.challengeDetected) {
      return 'challenge_detected';
    }
    if (params.pendingStep && /\b(policy|junk|archive|delete|protected sender|older than)\b/i.test(params.pendingStep)) {
      return 'needs_policy';
    }
    if (params.pendingStep && /\bpilot\b/i.test(params.pendingStep)) {
      return 'needs_pilot_approval';
    }
    if (params.pendingStep && /\bready|login|mfa|captcha|checkpoint\b/i.test(params.pendingStep)) {
      return 'needs_ready';
    }
    return 'human_required';
  }
  if (mode === 'needs_pilot_approval') {
    return 'needs_pilot_approval';
  }
  if (mode === 'challenge_detected') {
    return 'challenge_detected';
  }
  if (mode === 'read_then_write' || mode === 'execute') {
    return params.challengeDetected ? 'challenge_detected' : 'executing';
  }
  if (mode === 'browser_workflow_status') {
    return params.fallbackState;
  }
  return params.fallbackState;
}

function resolveBrowserWorkflowEvent(params: {
  browserSkillExportRequest: boolean;
  inheritedWorkflowState: BrowserWorkflowState;
  needsReadyFlow: boolean;
  isFollowupAck: boolean;
  forceReadOnlyProbe: boolean;
  cleanupWorkflowContext: boolean;
  cleanupPolicyProvided: boolean;
  cleanupExecutionApproved: boolean;
  desiredAction: string;
}): BrowserWorkflowEventType {
  if (params.browserSkillExportRequest) {
    return 'START_PROBING';
  }
  if (params.inheritedWorkflowState === 'challenge_detected' && !params.isFollowupAck) {
    return 'REQUIRE_CHALLENGE';
  }
  if (params.inheritedWorkflowState === 'challenge_detected' && params.isFollowupAck) {
    return 'START_PROBING';
  }
  if (params.inheritedWorkflowState === 'human_required' && !params.isFollowupAck) {
    return 'REQUIRE_HUMAN';
  }
  if (params.inheritedWorkflowState === 'human_required' && params.isFollowupAck) {
    return 'START_PROBING';
  }
  if (params.inheritedWorkflowState === 'needs_user_step' && !params.isFollowupAck) {
    return 'REQUIRE_USER_STEP';
  }
  if (params.needsReadyFlow && !params.isFollowupAck) {
    return 'REQUIRE_READY';
  }
  if (params.forceReadOnlyProbe) {
    return 'START_PROBING';
  }
  if (params.cleanupWorkflowContext && !params.cleanupPolicyProvided) {
    return 'REQUIRE_POLICY';
  }
  if (
    params.cleanupWorkflowContext &&
    params.cleanupPolicyProvided &&
    !params.cleanupExecutionApproved
  ) {
    return 'REQUIRE_PILOT_APPROVAL';
  }
  if (params.desiredAction !== 'read') {
    return 'START_EXECUTION';
  }
  return 'START_PROBING';
}

function buildPlaywrightCallFromMessage(
  message: string,
  requestedAction: string,
  options: BuildPlaywrightOptions
): PlaywrightCall {
  const lower = String(message || '').toLowerCase();
  const continueBrowserThread = toBool(options.continueBrowserThread, false);
  const browserSkillExportRequest = toBool(options.browserSkillExportRequest, false);
  const browserSkillName = asOptionalString(options.browserSkillName);
  const inheritedPolicyNeeded = toBool(options.lastBrowserPolicyNeeded, false);
  const inheritedWorkflowState = normalizeBrowserWorkflowState(options.lastBrowserWorkflowState);
  const isFollowupAck = isBrowserFollowupAckMessage(message);
  const labelModeRequested = messageRequestsProbeLabelMode(message);
  const useSavedLabelsRequested = messageRequestsUseSavedLabels(message);
  const labelResetRequested = messageRequestsProbeLabelReset(message);
  const showNetworkCandidates = messageRequestsNetworkCandidatePreview(message);
  const forceReadOnlyProbe = labelModeRequested || showNetworkCandidates || useSavedLabelsRequested;
  const needsReadyFlow = inheritedWorkflowState === 'needs_ready';
  const stateImpliesCleanup =
    inheritedWorkflowState === 'needs_policy' ||
    inheritedWorkflowState === 'needs_pilot_approval';
  const inheritedDesiredAction = normalizeCrudAction(options.lastBrowserDesiredAction);
  const inferredDesiredAction = inferPlaywrightDesiredActionFromMessage(message, requestedAction);
  const desiredAction = browserSkillExportRequest
    ? 'read'
    : forceReadOnlyProbe
      ? 'read'
    : inheritedWorkflowState === 'needs_pilot_approval' && !messageHasCleanupExecutionApproval(message)
      ? 'read'
    : (isFollowupAck || continueBrowserThread) && inheritedDesiredAction
      ? inheritedDesiredAction
      : inferredDesiredAction;
  const inheritedCleanupIntent = toBool(options.lastBrowserCleanupIntent, false);
  const inheritedUrl = asOptionalString(options.lastBrowserUrl);
  const inheritedRuntime = asOptionalString(options.lastBrowserRuntime);
  const inferredUrl = browserSkillExportRequest ? null : inferPlaywrightUrlFromMessage(message);
  const url = inferredUrl || ((isFollowupAck || continueBrowserThread || browserSkillExportRequest) ? inheritedUrl : null);
  const inferredCleanupIntent = inferCleanupIntentFromMessage(message, desiredAction);
  const cleanupPolicyPreset = browserSkillExportRequest ? null : parseCleanupPolicyPreset(message);
  const cleanupWorkflowContext = browserSkillExportRequest
    ? false
    : inferredCleanupIntent ||
      stateImpliesCleanup ||
      ((isFollowupAck || continueBrowserThread) && inheritedCleanupIntent);
  const cleanupIntent = browserSkillExportRequest
    ? false
    : inferredCleanupIntent ||
      stateImpliesCleanup ||
      (
        (isFollowupAck || continueBrowserThread) &&
        inheritedCleanupIntent &&
        inheritedPolicyNeeded
      );
  const cleanupExecutionApproved =
    cleanupWorkflowContext &&
    !showNetworkCandidates &&
    messageHasCleanupExecutionApproval(message);
  const cleanupExecutionMode = cleanupExecutionApproved
    ? inferCleanupExecutionMode(message)
    : null;
  const cleanupPolicyProvided = browserSkillExportRequest
    ? true
    : cleanupWorkflowContext &&
      (
        Boolean(cleanupPolicyPreset) ||
        messageHasCleanupPolicyDetails(message) ||
        (inheritedWorkflowState === 'needs_policy' && messageHasCleanupPolicyDetails(message)) ||
        ((isFollowupAck || continueBrowserThread) && !inheritedPolicyNeeded)
      );
  const inferredAuthenticatedTask = isLikelyAuthenticatedBrowserTask(message, url);
  const defaultUseUserContext = toBool(
    process.env.PINOKIO_PLAYWRIGHT_DEFAULT_USE_USER_CONTEXT,
    true
  );
  const containerFallbackNonAuth = toBool(
    process.env.PINOKIO_PLAYWRIGHT_CONTAINER_FALLBACK_NON_AUTH,
    true
  );
  const userContextAllowlist = parseDomainListFromEnv(
    'PINOKIO_PLAYWRIGHT_USER_CONTEXT_DOMAIN_ALLOWLIST',
    DEFAULT_AUTH_DOMAIN_HINTS
  );
  const allowAnyUserContextDomain = toBool(
    process.env.PINOKIO_PLAYWRIGHT_ALLOW_USER_CONTEXT_ANY_DOMAIN,
    true
  );
  const host = extractHostFromUrl(url);
  const allowlistedDomain = host ? domainMatchesAllowlist(host, userContextAllowlist) : false;
  const domainEligible =
    allowlistedDomain ||
    (allowAnyUserContextDomain && Boolean(host)) ||
    (allowAnyUserContextDomain && !host);
  let shouldUseUserContext =
    defaultUseUserContext &&
    (!containerFallbackNonAuth || inferredAuthenticatedTask) &&
    domainEligible;
  if ((isFollowupAck || continueBrowserThread) && inheritedRuntime === 'host' && inheritedUrl) {
    shouldUseUserContext = true;
  }
  let runtimePreference = shouldUseUserContext ? 'host' : 'container';
  if ((isFollowupAck || continueBrowserThread) && inheritedRuntime) {
    runtimePreference = inheritedRuntime;
  }
  const workflowEvent = resolveBrowserWorkflowEvent({
    browserSkillExportRequest,
    inheritedWorkflowState,
    needsReadyFlow,
    isFollowupAck,
    forceReadOnlyProbe,
    cleanupWorkflowContext,
    cleanupPolicyProvided,
    cleanupExecutionApproved,
    desiredAction
  });
  const workflowState = transitionBrowserWorkflowState(inheritedWorkflowState, workflowEvent);
  const defaultHeadless = toBool(
    process.env.PINOKIO_PLAYWRIGHT_DEFAULT_HEADLESS,
    false
  );
  const keepOpenAfterDiscoveryMs = toInt(
    process.env.PINOKIO_PLAYWRIGHT_UI_KEEP_OPEN_AFTER_DISCOVERY_MS,
    120000,
    0,
    300000
  );
  const workflowControlIntent =
    labelModeRequested ||
    useSavedLabelsRequested ||
    labelResetRequested ||
    showNetworkCandidates ||
    isFollowupAck ||
    continueBrowserThread ||
    /\bcontinue\s+with\s+(?:the\s+)?plan\b/.test(lower) ||
    /\bresume\s+workflow\b/.test(lower);
  const planningIntent =
    !workflowControlIntent &&
    /\b(plan|system|strategy|workflow|setup|set up)\b/.test(lower) &&
    !/\b(now|right now|immediately|run it|do it now|execute)\b/.test(lower);
  const screenshotIntent =
    /\b(screenshot|screen\s*shot|capture\s*screen|preview\s*image)\b/.test(lower);
  const target: PlaywrightTarget = {
    desired_action: desiredAction,
    mutate: browserSkillExportRequest ? false : desiredAction !== 'read',
    plan_with_llm: true,
    probe_mode: true,
    probe_convert_to_skill: browserSkillExportRequest,
    probe_auto_register_skill: true,
    use_user_context: shouldUseUserContext,
    allow_user_context: shouldUseUserContext,
    use_stealth: true,
    capture_screenshot: screenshotIntent,
    probe_overlay_enabled: true,
    probe_overlay_auto_activate: labelModeRequested,
    probe_overlay_reset: labelResetRequested,
    use_saved_labels: useSavedLabelsRequested,
    show_network_candidates: showNetworkCandidates,
    prefer_network_first: true,
    execution_headless: defaultHeadless,
    authenticated_task: inferredAuthenticatedTask,
    container_fallback_non_auth: containerFallbackNonAuth,
    user_context_allowlisted_domain: allowlistedDomain,
    user_context_any_domain_allowed: allowAnyUserContextDomain,
    await_user_checkpoint: isFollowupAck,
    user_checkpoint_timeout_ms: isFollowupAck ? 180000 : 0,
    keep_open_after_discovery_ms:
      isFollowupAck && shouldUseUserContext && !defaultHeadless
        ? keepOpenAfterDiscoveryMs
        : 0,
    auth_expected_host: host || undefined,
    delegate_runtime: runtimePreference,
    channel: options.channel,
    response_format: options.responseFormat || 'ui_blocks',
    task_summary: message,
    plan_only: browserSkillExportRequest ? true : planningIntent,
    cleanup_intent: browserSkillExportRequest ? false : cleanupWorkflowContext,
    cleanup_policy_provided: cleanupPolicyProvided,
    cleanup_execution_approved: cleanupExecutionApproved,
    cleanup_preview_requested: showNetworkCandidates,
    workflow_state: workflowState,
    skill_hints: [
      'Prefer first-party settings/rules before repetitive manual UI clicks.',
      'For email organization, propose safe staged actions before applying bulk changes.'
    ]
  };
  if (cleanupExecutionMode) {
    target.cleanup_execution_mode = cleanupExecutionMode;
  }
  if (browserSkillName) {
    target.probe_skill_name = browserSkillName;
  }
  if (
    cleanupPolicyProvided &&
    !browserSkillExportRequest &&
    !cleanupExecutionApproved &&
    (messageHasCleanupPolicyDetails(message) || Boolean(cleanupPolicyPreset))
  ) {
    target.cleanup_policy_text = (
      cleanupPolicyPreset?.policyText || String(message)
    ).slice(0, 4000);
    if (cleanupPolicyPreset) {
      target.cleanup_policy_choice = cleanupPolicyPreset.choice;
      target.cleanup_policy_label = cleanupPolicyPreset.label;
    }
  }
  if (url) {
    target.url = url;
  }

  return {
    action: desiredAction === 'update' ? 'update' : desiredAction === 'delete' ? 'delete' : desiredAction === 'create' ? 'create' : 'read',
    target
  };
}

function hasLikelyFilenameToken(message: string): boolean {
  const tokens = String(message || '')
    .split(/\s+/g)
    .map((token) =>
      token
        .trim()
        .replace(/^["'`(<\[]+/, '')
        .replace(/[>"'`)\].,;!?]+$/, '')
    )
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^https?:\/\//i.test(token) || token.startsWith('www.')) {
      continue;
    }
    if (token.includes('@')) {
      continue;
    }
    const basename = token.split(/[\\/]/g).pop() || token;
    const match = basename.match(/^[\w .-]+\.(\w{1,10})$/i);
    if (!match) {
      continue;
    }
    const ext = String(match[1] || '').toLowerCase();
    if (COMMON_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}

function looksLikeFilesystemIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower) {
    return false;
  }
  const explicitPathSyntax = looksLikeExplicitPathSyntax(message);
  const messagingContext =
    /\b(?:email|emails|inbox|mailbox|message|messages|gmail|outlook|hotmail|dm)\b/.test(lower);
  if (messagingContext && !explicitPathSyntax) {
    return false;
  }
  if (
    (lower.includes('playwright') || lower.includes('browser') || lower.includes('gmail') || lower.includes('hotmail') || lower.includes('outlook')) &&
    /\b(?:not|dont|don't)\s+(?:folder|folders|explorer)\b/.test(lower)
  ) {
    return false;
  }
  if (hasLikelyFilenameToken(message)) {
    return true;
  }
  const keywords: string[] = [
    'file',
    'files',
    'folder',
    'folders',
    'directory',
    'directories',
    'rename',
    'move',
    'delete',
    'remove',
    'create file',
    'create folder',
    'list files',
    'show files',
    'folder size',
    'directory size',
    'how big',
    'clean up',
    'cleanup',
    'zip',
    'archive',
    'compress',
    'rar',
    '.rar',
    'documents folder',
    'documents',
    'downloads',
    'desktop',
    'use explorer',
    'explorer'
  ];
  return keywords.some((keyword) => lower.includes(keyword));
}

function inferCrudActionFromMessage(message: string, fallback: string = 'read'): string {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('delete') || lower.includes('remove')) {
    return 'delete';
  }
  if (
    lower.includes('rename') ||
    lower.includes('move') ||
    lower.includes('edit') ||
    lower.includes('update') ||
    lower.includes('append') ||
    lower.includes('write to') ||
    lower.includes('write into') ||
    lower.includes('put into') ||
    lower.includes('insert into')
  ) {
    return 'update';
  }
  if (
    lower.includes('create') ||
    lower.includes('make ') ||
    lower.includes('new file') ||
    lower.includes('new folder') ||
    /\b(name|call)\s+it\s+[\w .-]+\.[a-z0-9]{2,8}\b/.test(lower) ||
    /\b(save|saved)\s+(it\s+)?as\s+[\w .-]+\.[a-z0-9]{2,8}\b/.test(lower)
  ) {
    return 'create';
  }
  return SUPPORTED_ACTIONS.has(fallback) ? fallback : 'read';
}

function sanitizeInferredPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  let trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  trimmed = trimmed.replace(/^["'`]+/, '').replace(/["'`]+$/, '');

  // Natural language often appends punctuation to paths (for example "/host/Desktop:").
  while (/[,:;.!?]+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  while (trimmed.endsWith(')') && !trimmed.includes('(')) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  while (trimmed.endsWith(']') && !trimmed.includes('[')) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  // Users often wrap filenames in parentheses in natural language.
  if (trimmed.startsWith('(') && trimmed.endsWith(')') && trimmed.length > 2) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed || null;
}

function inferPathFromMessage(message: string): string | null {
  const raw = String(message || '');
  const backtickMatch = raw.match(/`([^`]+)`/);
  if (backtickMatch && backtickMatch[1]) {
    return sanitizeInferredPath(backtickMatch[1]);
  }

  const namedFileMatch = raw.match(
    /\b(?:name|call)\s+it\s+([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8}))/i
  );
  if (namedFileMatch && namedFileMatch[1]) {
    return sanitizeInferredPath(namedFileMatch[1]);
  }

  const saveAsMatch = raw.match(
    /\b(?:save|saved)\s+(?:it\s+)?as\s+([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8}))/i
  );
  if (saveAsMatch && saveAsMatch[1]) {
    return sanitizeInferredPath(saveAsMatch[1]);
  }

  const unixPathMatch = raw.match(/(~\/[^\s,;]+|\/[^\s,;]+)/);
  if (unixPathMatch && unixPathMatch[1]) {
    return sanitizeInferredPath(unixPathMatch[1]);
  }

  const windowsPathMatch = raw.match(/[A-Za-z]:\\[^\s,;]+/);
  if (windowsPathMatch && windowsPathMatch[0]) {
    return sanitizeInferredPath(windowsPathMatch[0]);
  }

  const filenameMatch = raw.match(/\b([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8}))\b/);
  if (filenameMatch && filenameMatch[1]) {
    return sanitizeInferredPath(filenameMatch[1]);
  }

  return null;
}

function looksLikeExplicitPathSyntax(message: string): boolean {
  const raw = String(message || '');
  if (!raw.trim()) {
    return false;
  }
  if (/(^|\s)(~\/|\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(raw)) {
    return true;
  }
  return /`[^`]*[\/\\][^`]*`/.test(raw);
}

function parseInlineCreateContent(message: string): string | null {
  const raw = String(message || '');
  const contentMatch = raw.match(/(?:content|text)\s*[:=]\s*([\s\S]+)$/i);
  if (contentMatch && contentMatch[1]) {
    const value = contentMatch[1].trim();
    if (value) {
      return value;
    }
  }
  const putInsideMatch = raw.match(
    /\b(?:put|write|insert)\s+(?:(?:inside|into)(?:\s+of)?\s+)?(?:(?:the|that|this)\s+)?(?:text\s+file|file|document)\s*[>:. -]?\s*([\s\S]+)$/i
  );
  if (putInsideMatch && putInsideMatch[1]) {
    let value = putInsideMatch[1].trim().replace(/^[>.:;\-\s]+/, '').trim();
    value = value
      .replace(/\s+and\s+save\s+(?:it\s+)?as\s+[^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8})?.*$/i, '')
      .trim();
    if (value) {
      return value;
    }
  }
  const putTextInsideItMatch = raw.match(
    /\b(?:put|write|insert)\s+(?:this|the)?\s*text\s+(?:inside|into)\s+(?:of\s+)?(?:it|that|this)\s*[>:. -]?\s*([\s\S]+)$/i
  );
  if (putTextInsideItMatch && putTextInsideItMatch[1]) {
    const value = putTextInsideItMatch[1].trim().replace(/^[>.:;\-\s]+/, '').trim();
    if (value) {
      return value;
    }
  }
  const saysMatch = raw.match(
    /\bsay(?:s|ing)?\s+(.+?)(?:\s+(?:on|in|at)\s+(?:my\s+)?(?:desktop|documents|downloads)\b[\s\S]*)?$/i
  );
  if (saysMatch && saysMatch[1]) {
    let value = saysMatch[1].trim();
    value = value
      .replace(/\s+and\s+save\s+(?:it\s+)?as\s+[^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8})?.*$/i, '')
      .trim();
    if (value) {
      return value;
    }
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length >= 2) {
    const trailing = lines.slice(1).join('\n').trim();
    if (trailing) {
      return trailing;
    }
  }
  return null;
}

function parseRenameNewNameFromMessage(message: string): string | null {
  const raw = String(message || '');
  const quoted = raw.match(
    /\brename\b[\s\S]*?\bto\s+["'`]\s*([^"'`\\/]+(?:\.[a-zA-Z0-9]{1,10})?)\s*["'`]/i
  );
  if (quoted && quoted[1]) {
    return sanitizeInferredPath(quoted[1]);
  }
  const plain = raw.match(/\brename\b[\s\S]*?\bto\s+([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{1,10})?)/i);
  if (plain && plain[1]) {
    return sanitizeInferredPath(plain[1]);
  }
  return null;
}

function formatTimestampForFileName(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}

function inferDefaultCreateFileName(message: string): string {
  const lower = String(message || '').toLowerCase();
  const extension =
    lower.includes('pdf') ? '.pdf'
      : lower.includes('json') ? '.json'
      : lower.includes('markdown') || lower.includes('.md') ? '.md'
      : '.txt';
  return `document-${formatTimestampForFileName(new Date())}${extension}`;
}

function parseSizeToBytes(rawSize: string, rawUnit: string): number | null {
  const n = Number.parseFloat(String(rawSize || '').trim());
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = String(rawUnit || 'b').trim().toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    byte: 1,
    bytes: 1,
    kb: 1024,
    k: 1024,
    mb: 1024 * 1024,
    m: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    g: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
    t: 1024 * 1024 * 1024 * 1024
  };
  const multiplier = multipliers[unit] || 1;
  return Math.max(1, Math.floor(n * multiplier));
}

function parseMinSizeBytesFromMessage(message: string): number | null {
  const raw = String(message || '');
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(bytes?|kb|mb|gb|tb|[kmgt]b?|b)\b/i);
  if (!match) {
    return null;
  }
  return parseSizeToBytes(match[1], match[2]);
}

function parseExtensionListFromMessage(message: string): string[] {
  const lower = String(message || '').toLowerCase();
  const extensionMatches = lower.match(/\.([a-z0-9]{1,10})/g) || [];
  const out = extensionMatches
    .map((token) => token.replace('.', '').trim())
    .filter(Boolean);
  if (/\brars?\b/.test(lower)) {
    out.push('rar');
  }
  if (/\bzips?\b/.test(lower)) {
    out.push('zip');
  }
  return Array.from(new Set(out));
}

function formatHumanBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units: string[] = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex < 0) {
    return `${bytes} B`;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function maybeReadableBytesReply(message: string): string | null {
  const raw = String(message || '');
  const lower = raw.toLowerCase();
  if (!lower.includes('readable') && !lower.includes('human')) {
    return null;
  }
  const match = raw.match(/(\d{1,18})\s*bytes?\b/i);
  if (!match || !match[1]) {
    return null;
  }
  const bytes = Number.parseInt(match[1], 10);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  const human = formatHumanBytes(bytes);
  if (!human) {
    return null;
  }
  return `${bytes.toLocaleString()} bytes (${human})`;
}

function inferScopeFromMessage(lower: string, fallbackScope: string, hostDocumentsScope: string, hostDesktopScope: string): string {
  if (lower.includes('desktop')) {
    return hostDesktopScope;
  }
  if (lower.includes('documents')) {
    return hostDocumentsScope;
  }
  return fallbackScope;
}

interface BuildExplorerOptions {
  channel?: string;
  response_format?: string;
  last_file_path?: string;
}

interface BuildPlaywrightOptions {
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

interface ExplorerHeuristicResult {
  should_route: boolean;
  confidence: 'high' | 'low';
  call: ExplorerCall | null;
  source: 'pending' | 'fallback' | 'none';
}

function buildExplorerTargetFromMessage(message: string, requestedAction: string, options: BuildExplorerOptions = {}): ExplorerCall | null {
  const lower = String(message || '').toLowerCase();
  const defaultScope = asOptionalString(process.env.PINOKIO_EXPLORER_SCOPE) || '/app';
  const hostDocumentsScope =
    asOptionalString(process.env.PINOKIO_HOST_DOCUMENTS_SCOPE) || defaultScope;
  const hostDesktopScope =
    asOptionalString(process.env.PINOKIO_HOST_DESKTOP_SCOPE) || '/host/Desktop';
  const channel = asOptionalString(options.channel) || 'default';
  const responseFormat = asOptionalString(options.response_format);
  const lastFilePath = asOptionalString(options.last_file_path);
  const scopeDir = inferScopeFromMessage(
    lower,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope
  );
  const inferredAction = inferCrudActionFromMessage(message, requestedAction);
  const inferredPath = inferPathFromMessage(message);
  const renameIntent = lower.includes('rename');
  const renameNewName = parseRenameNewNameFromMessage(message);
  const referencesLastFile = messageReferencesPriorFile(message);
  const inferredPathIsBareFilename =
    Boolean(inferredPath) &&
    !String(inferredPath).includes('/') &&
    !String(inferredPath).includes('\\') &&
    !String(inferredPath).startsWith('~');
  const listIntent =
    lower.includes('list') ||
    lower.includes('show') ||
    lower.includes('display') ||
    lower.includes('get a list');
  const infoIntent =
    lower.includes('size') ||
    lower.includes('folder size') ||
    lower.includes('directory size') ||
    lower.includes('how big') ||
    lower.includes('disk usage') ||
    lower.includes('details for') ||
    lower.includes('info about');
  const cleanupIntent =
    lower.includes('clean up') || lower.includes('cleanup') || lower.includes('organize');
  const zipIntent =
    lower.includes('zip') || lower.includes('archive') || lower.includes('compress');
  const deleteAllExtIntent =
    (lower.includes('delete') || lower.includes('remove')) &&
    (lower.includes('all') || lower.includes('every')) &&
    (lower.includes('.rar') || lower.includes('rars') || lower.includes('extensions'));
  const extensionsFromMessage = parseExtensionListFromMessage(message);
  const minSizeBytes = parseMinSizeBytesFromMessage(message);

  if (infoIntent && inferredAction === 'read') {
    const target: ExplorerTarget = {
      scope_dir: scopeDir,
      desired_action: 'info',
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    if (inferredPath) {
      target.path = inferredPath;
    } else {
      target.path = scopeDir;
    }
    return {
      action: 'read',
      target
    };
  }

  if (cleanupIntent && lower.includes('desktop')) {
    const target: ExplorerTarget = {
      scope_dir: hostDesktopScope,
      desired_action: 'update',
      operation: 'cleanup',
      cleanup_profile: 'desktop',
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'update',
      target
    };
  }

  if (deleteAllExtIntent || (extensionsFromMessage.length > 0 && lower.includes('delete'))) {
    const target: ExplorerTarget = {
      scope_dir: scopeDir,
      desired_action: 'delete',
      operation: 'delete_by_extension',
      extensions: extensionsFromMessage.length > 0 ? extensionsFromMessage : ['rar'],
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'delete',
      target
    };
  }

  if (zipIntent && minSizeBytes) {
    const target: ExplorerTarget = {
      scope_dir: scopeDir,
      desired_action: 'update',
      operation: 'zip_files_over_size',
      min_size_bytes: minSizeBytes,
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'update',
      target
    };
  }

  const target: ExplorerTarget = {
    scope_dir: scopeDir,
    desired_action: inferredAction,
    channel,
    dry_run: false
  };
  if (responseFormat) {
    target.response_format = responseFormat;
  }

  const useLastFileAsRenameSource =
    Boolean(lastFilePath) &&
    renameIntent &&
    Boolean(renameNewName) &&
    (
      !inferredPath ||
      referencesLastFile ||
      lower.includes('last file') ||
      lower.includes('previous file') ||
      String(inferredPath).toLowerCase() === String(renameNewName).toLowerCase()
    );

  if (useLastFileAsRenameSource && lastFilePath) {
    target.path = lastFilePath;
    target.scope_dir = path.dirname(lastFilePath);
  } else if (inferredPath) {
    if (inferredPathIsBareFilename) {
      target.path = path.join(scopeDir, inferredPath);
    } else {
      target.path = inferredPath;
    }
  } else if (lastFilePath && referencesLastFile) {
    target.path = lastFilePath;
    target.scope_dir = path.dirname(lastFilePath);
  }

  if (typeof target.path === 'string' && path.isAbsolute(target.path)) {
    target.scope_dir = path.dirname(target.path);
  }

  if (!inferredPath && inferredAction === 'read') {
    const directFolderListing =
      listIntent &&
      (lower.includes('documents') || lower.includes('downloads') || lower.includes('desktop'));
    if (!directFolderListing) {
      target.query = message;
    }
  }

  if (inferredAction === 'create') {
    if (lower.includes('folder') || lower.includes('directory')) {
      target.kind = 'directory';
    } else {
      target.kind = 'file';
    }
    const targetPath = typeof target.path === 'string' ? target.path.toLowerCase() : '';
    if (targetPath.endsWith('.pdf') || lower.includes('pdf')) {
      target.operation = 'create_pdf';
      target.kind = 'file';
    }
    const inlineContent = parseInlineCreateContent(message);
    if (inlineContent) {
      target.content = inlineContent;
    }
    if (!target.path) {
      target.path = path.join(scopeDir, inferDefaultCreateFileName(message));
    }
  }

  if (inferredAction === 'update') {
    if (renameIntent && renameNewName) {
      target.operation = 'rename';
      target.new_name = renameNewName;
      if (!target.path && lastFilePath) {
        target.path = lastFilePath;
        target.scope_dir = path.dirname(lastFilePath);
      }
    }
    const inlineContent = parseInlineCreateContent(message);
    if (inlineContent) {
      target.content = inlineContent;
      if (!target.operation) {
        target.operation = lower.includes('append') ? 'append' : 'write';
      }
    }
  }

  if (inferredAction === 'delete' && lower.includes('recursive')) {
    target.recursive = true;
  }

  if ((inferredAction === 'create' || inferredAction === 'update' || inferredAction === 'delete') && !target.path) {
    return null;
  }

  return {
    action: inferredAction,
    target
  };
}

function chooseHeuristicExplorerRoute(params: {
  message: string;
  filesystemIntent: boolean;
  pendingFilesystem: PendingFilesystemState | null;
  pendingExplorerCall: ExplorerCall | null;
  fallbackExplorerCall: ExplorerCall | null;
  lastFilePath: string | null;
}): ExplorerHeuristicResult {
  const {
    message,
    filesystemIntent,
    pendingFilesystem,
    pendingExplorerCall,
    fallbackExplorerCall,
    lastFilePath
  } = params;
  const hasPending = Boolean(pendingFilesystem);
  const hasExplicitPathSyntax = looksLikeExplicitPathSyntax(message);
  const shouldConsiderFilesystemRouting = filesystemIntent || hasPending || hasExplicitPathSyntax;

  if (!shouldConsiderFilesystemRouting) {
    return {
      should_route: false,
      confidence: 'low',
      call: null,
      source: 'none'
    };
  }

  if (pendingExplorerCall) {
    const pathHint = asOptionalString(pendingExplorerCall.target.path);
    if (isMutationAction(pendingExplorerCall.action) && !pathHint) {
      return {
        should_route: true,
        confidence: 'low',
        call: pendingExplorerCall,
        source: 'pending'
      };
    }
    if (
      pendingExplorerCall.action === 'update' &&
      isExplicitPriorFileWriteIntent(message, lastFilePath) &&
      !asOptionalString(pendingExplorerCall.target.content)
    ) {
      return {
        should_route: true,
        confidence: 'low',
        call: pendingExplorerCall,
        source: 'pending'
      };
    }
    return {
      should_route: true,
      confidence: 'high',
      call: pendingExplorerCall,
      source: 'pending'
    };
  }

  if (fallbackExplorerCall) {
    const pathHint = asOptionalString(fallbackExplorerCall.target.path);
    const queryHint = asOptionalString(fallbackExplorerCall.target.query);
    const desiredAction = asOptionalString(fallbackExplorerCall.target.desired_action);

    if (isMutationAction(fallbackExplorerCall.action)) {
      if (!pathHint) {
        return {
          should_route: true,
          confidence: 'low',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      if (
        fallbackExplorerCall.action === 'update' &&
        isExplicitPriorFileWriteIntent(message, lastFilePath) &&
        !asOptionalString(fallbackExplorerCall.target.content)
      ) {
        return {
          should_route: true,
          confidence: 'low',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      return {
        should_route: true,
        confidence: 'high',
        call: fallbackExplorerCall,
        source: 'fallback'
      };
    }

    if (desiredAction === 'info') {
      return {
        should_route: true,
        confidence: 'high',
        call: fallbackExplorerCall,
        source: 'fallback'
      };
    }

    if (fallbackExplorerCall.action === 'read') {
      if (pathHint && !queryHint) {
        return {
          should_route: true,
          confidence: 'high',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      if (!queryHint && filesystemIntent) {
        return {
          should_route: true,
          confidence: 'high',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      return {
        should_route: true,
        confidence: 'low',
        call: fallbackExplorerCall,
        source: 'fallback'
      };
    }
  }

  if (filesystemIntent || hasPending) {
    return {
      should_route: true,
      confidence: 'low',
      call: null,
      source: 'none'
    };
  }

  return {
    should_route: false,
    confidence: 'low',
    call: null,
    source: 'none'
  };
}

function isMutationAction(action: string): boolean {
  return action === 'create' || action === 'update' || action === 'delete';
}

function isExplicitPriorFileWriteIntent(message: string, lastFilePath: string | null): boolean {
  if (!lastFilePath) {
    return false;
  }
  const lower = String(message || '').toLowerCase();
  if (
    lower.includes('create') ||
    lower.includes('make ') ||
    lower.includes('new file') ||
    lower.includes('new document') ||
    lower.includes('text document')
  ) {
    return false;
  }
  if (!messageReferencesPriorFile(message)) {
    return false;
  }
  return /\b(?:write|put|insert|append|update|edit|replace)\b/.test(lower);
}

function shouldPreferFallbackExplorerCall(params: {
  llmCall: ExplorerCall;
  fallbackCall: ExplorerCall | null;
  message: string;
  lastFilePath: string | null;
}): boolean {
  const { llmCall, fallbackCall, message, lastFilePath } = params;
  if (!fallbackCall) {
    return false;
  }

  const explicitWriteFollowup = isExplicitPriorFileWriteIntent(message, lastFilePath);
  if (explicitWriteFollowup) {
    const llmPath = sanitizeInferredPath(llmCall.target.path);
    const expectedPath = sanitizeInferredPath(lastFilePath);
    const llmContent = asOptionalString(llmCall.target.content);
    if (llmCall.action !== 'update') {
      return true;
    }
    if (!expectedPath || llmPath !== expectedPath) {
      return true;
    }
    if (!llmContent) {
      return true;
    }
  }

  if (isMutationAction(fallbackCall.action) && !isMutationAction(llmCall.action)) {
    return true;
  }

  const renameIntent = /\brename\b/i.test(String(message || ''));
  if (renameIntent && fallbackCall.action === 'update') {
    const fallbackOperation = asOptionalString(fallbackCall.target.operation)?.toLowerCase();
    const llmOperation = asOptionalString(llmCall.target.operation)?.toLowerCase();
    const fallbackNewName = asOptionalString(fallbackCall.target.new_name);
    const llmNewName = asOptionalString(llmCall.target.new_name);
    if (fallbackOperation === 'rename' && fallbackNewName && (!llmNewName || llmOperation !== 'rename')) {
      return true;
    }
  }

  if (isMutationAction(fallbackCall.action)) {
    const fallbackPath = sanitizeInferredPath(fallbackCall.target.path);
    const llmPath = sanitizeInferredPath(llmCall.target.path);
    if (fallbackPath && !llmPath) {
      return true;
    }
  }

  return false;
}

function enforcePriorFileWriteCall(call: ExplorerCall, message: string, lastFilePath: string | null): ExplorerCall {
  if (!isExplicitPriorFileWriteIntent(message, lastFilePath) || !lastFilePath) {
    return call;
  }

  const enforcedTarget: ExplorerTarget = {
    ...call.target,
    desired_action: 'update',
    path: lastFilePath,
    scope_dir: path.dirname(lastFilePath),
    dry_run: false
  };
  const inlineContent = parseInlineCreateContent(message);
  if (inlineContent) {
    enforcedTarget.content = inlineContent;
  }
  if (!asOptionalString(enforcedTarget.operation) && asOptionalString(enforcedTarget.content)) {
    enforcedTarget.operation = String(message || '').toLowerCase().includes('append') ? 'append' : 'write';
  }

  return {
    action: 'update',
    target: enforcedTarget
  };
}

function normalizeExplorerAction(value: unknown): string | null {
  let action = String(value || '').trim().toLowerCase();
  if (action === 'create_file' || action === 'new_file' || action === 'mkdir') {
    action = 'create';
  } else if (action === 'write' || action === 'replace' || action === 'append' || action === 'edit') {
    action = 'update';
  } else if (action === 'remove' || action === 'rm') {
    action = 'delete';
  } else if (action === 'info' || action === 'stat' || action === 'size') {
    action = 'read';
  }
  if (!SUPPORTED_ACTIONS.has(action)) {
    return null;
  }
  return action;
}

function normalizePlannerTarget(
  rawTarget: unknown,
  action: string,
  channel: string,
  responseFormat: string | null,
  message: string,
  lastFilePath: string | null
): ExplorerTarget | null {
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    return null;
  }
  const target: ExplorerTarget = { ...(rawTarget as ExplorerTarget) };
  if (!target.channel) {
    target.channel = channel;
  }
  if (!target.response_format && responseFormat) {
    target.response_format = responseFormat;
  }
  if (typeof target.dry_run !== 'boolean') {
    target.dry_run = false;
  }
  const desiredRaw = asOptionalString(target.desired_action);
  if (desiredRaw) {
    let desired = desiredRaw.toLowerCase();
    if (desired === 'create_file' || desired === 'new_file' || desired === 'mkdir') {
      desired = 'create';
    } else if (desired === 'write' || desired === 'replace' || desired === 'append' || desired === 'edit') {
      desired = 'update';
    } else if (desired === 'remove' || desired === 'rm') {
      desired = 'delete';
    } else if (desired === 'stat' || desired === 'size') {
      desired = 'info';
    }
    if (!['create', 'read', 'update', 'delete', 'info'].includes(desired)) {
      target.desired_action = action;
    } else {
      target.desired_action = desired;
    }
  } else {
    target.desired_action = action;
  }
  if (typeof target.path === 'string') {
    const sanitized = sanitizeInferredPath(target.path);
    if (sanitized) {
      target.path = sanitized;
    }
    if (target.path && path.isAbsolute(target.path) && (action !== 'read' || !target.scope_dir)) {
      target.scope_dir = path.dirname(target.path);
    }
  } else if (lastFilePath && messageReferencesPriorFile(message)) {
    target.path = lastFilePath;
    target.scope_dir = path.dirname(lastFilePath);
  }
  return target;
}

function buildExplorerPlannerPrompt(params: {
  message: string;
  requestedAction: string;
  channel: string;
  responseFormat: string | null;
  systemContext: string;
  pluginCatalogSummary: string;
  defaultScope: string;
  hostDocumentsScope: string;
  hostDesktopScope: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): string {
  const {
    message,
    requestedAction,
    channel,
    responseFormat,
    systemContext,
    pluginCatalogSummary,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope,
    lastFilePath,
    lastScopeDir,
    pendingFilesystem,
    conversationSummary,
    lastAssistantQuestion,
    followUpBias
  } = params;
  const pendingSerialized = pendingFilesystem
    ? JSON.stringify(pendingFilesystem)
    : 'null';
  return [
    'You are the routing/planning brain for Pinokio chat.',
    'Return JSON only. No markdown, no prose outside JSON.',
    'Choose one schema:',
    '{"route":"chat"}',
    '{"route":"explorer","action":"create|read|update|delete","target":{...},"chat_response":"short user-facing plan"}',
    'Or:',
    '{"route":"explorer","needs_clarification":"short question","target":{...}}',
    'Rules:',
    '- Decide whether this is a new request or a follow-up to pending filesystem context.',
    '- If message answers a pending clarification, route=explorer and fill the missing fields.',
    '- Trust-but-verify: if there is pending filesystem context, assume the next user message is a follow-up unless they explicitly start a new topic.',
    '- Do not ask for content if user already provided content.',
    '- If user asks to create a text document on desktop/documents with no filename, generate one automatically.',
    '- Always set target.desired_action.',
    '- Always set target.channel and target.dry_run=false.',
    '- Use absolute host paths under /host/Desktop or /host/Documents when user asks for desktop/documents.',
    '- For creating/updating file contents, include target.content.',
    '- If user says "put inside" or "say", treat that as file content.',
    '- For read/list/search requests, action should be read.',
    '- For directory size/info requests, action should be read and target.desired_action="info".',
    `- Default scopes: desktop=${hostDesktopScope}, documents=${hostDocumentsScope}, fallback=${defaultScope}.`,
    `- Requested chat action: ${requestedAction}.`,
    `- Channel: ${channel}.`,
    `- Response format: ${responseFormat || 'text'}.`,
    `- Last known file path: ${lastFilePath || 'none'}.`,
    `- Last known scope dir: ${lastScopeDir || 'none'}.`,
    `- Pending filesystem state: ${pendingSerialized}.`,
    `- Last assistant follow-up question: ${lastAssistantQuestion || 'none'}.`,
    `- Follow-up bias active: ${followUpBias ? 'yes' : 'no'}.`,
    conversationSummary ? `Recent conversation:\n${conversationSummary}` : '',
    pluginCatalogSummary ? `Plugin catalog context:\n${pluginCatalogSummary}` : '',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function planExplorerCallWithLlm(params: {
  message: string;
  requestedAction: string;
  requestedProfile: string;
  channel: string;
  responseFormat: string | null;
  systemContext: string;
  pluginCatalogSummary: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): Promise<{ route: 'explorer' | 'chat' | null; call: ExplorerCall | null; chatResponse: string | null; needsClarification: string | null; pendingTarget: ExplorerTarget | null }> {
  const {
    message,
    requestedAction,
    requestedProfile,
    channel,
    responseFormat,
    systemContext,
    pluginCatalogSummary,
    lastFilePath,
    lastScopeDir,
    pendingFilesystem,
    conversationSummary,
    lastAssistantQuestion,
    followUpBias
  } = params;
  const lower = String(message || '').toLowerCase();
  const defaultScope = asOptionalString(process.env.PINOKIO_EXPLORER_SCOPE) || '/app';
  const hostDocumentsScope = asOptionalString(process.env.PINOKIO_HOST_DOCUMENTS_SCOPE) || defaultScope;
  const hostDesktopScope = asOptionalString(process.env.PINOKIO_HOST_DESKTOP_SCOPE) || '/host/Desktop';
  const plannerPrompt = buildExplorerPlannerPrompt({
    message,
    requestedAction,
    channel,
    responseFormat,
    systemContext,
    pluginCatalogSummary,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope,
    lastFilePath,
    lastScopeDir,
    pendingFilesystem,
    conversationSummary,
    lastAssistantQuestion,
    followUpBias
  });

  try {
    const plan = runChatLlm({
      profile: requestedProfile,
      prompt: plannerPrompt,
      timeoutMs: Math.min(resolveTimeoutMs(), 15000)
    });
    const parsed = parseJsonOutput(plan.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { route: null, call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
    }

    const decision = parsed as ExplorerPlannerDecision;
    const route = asOptionalString(decision.route)?.toLowerCase();
    if (route === 'chat') {
      return { route: 'chat', call: null, chatResponse: asOptionalString(decision.chat_response), needsClarification: null, pendingTarget: null };
    }
    const normalizedRoute: 'explorer' | 'chat' | null = route === 'explorer' ? 'explorer' : null;
    const needsClarification = asOptionalString(decision.needs_clarification);
    if (needsClarification) {
      const pendingTarget = normalizePlannerTarget(
        decision.target,
        normalizeExplorerAction(decision.action) || normalizeExplorerAction(requestedAction) || 'read',
        channel,
        responseFormat,
        message,
        lastFilePath
      );
      return {
        route: normalizedRoute || 'explorer',
        call: null,
        chatResponse: asOptionalString(decision.chat_response),
        needsClarification,
        pendingTarget: pendingTarget || null
      };
    }

    const action = normalizeExplorerAction(decision.action);
    if (!action) {
      return { route: normalizedRoute, call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
    }
    const target = normalizePlannerTarget(
      decision.target,
      action,
      channel,
      responseFormat,
      message,
      lastFilePath
    );
    if (!target) {
      return { route: normalizedRoute || 'explorer', call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
    }

    // Keep planner target sane if it omitted scope for common user intents.
    if (!target.scope_dir) {
      if (lower.includes('desktop')) {
        target.scope_dir = hostDesktopScope;
      } else if (lower.includes('documents')) {
        target.scope_dir = hostDocumentsScope;
      } else {
        target.scope_dir = defaultScope;
      }
    }

    return {
      route: normalizedRoute || 'explorer',
      call: { action, target },
      chatResponse: asOptionalString(decision.chat_response),
      needsClarification: null,
      pendingTarget: null
    };
  } catch {
    return { route: null, call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
  }
}

function buildChatPrompt(
  message: string,
  systemContext: string,
  pluginCatalogSummary: string,
  pluginRoutingHints: string,
  conversationSummary: string,
  lastAssistantQuestion: string | null,
  followUpBias: boolean
): string {
  const blocks: string[] = [
    'You are a dedicated plugin-first chat coordinator for Pinokio.',
    'Reply directly to the user in a concise, practical style.',
    'Always evaluate available plugins/systems before saying you cannot do something.',
    'If a request maps to an installed plugin, propose using that plugin path first.',
    'For filesystem requests, prefer Directory Plugin (plugin:explorer_agent) via manager flow.',
    'For browser/webapp tasks (Hotmail/Outlook/Gmail/Twitch/social sites), prefer Playwright Plugin (plugin:playwright_agent), not Directory Plugin.',
    'For message/post cleanup tasks, first discover and summarize organization options and junk candidates, then ask the user to confirm policy before destructive actions.',
    'Never claim "no access" until you checked plugin context below.',
    'Do not mention MCP server requirements for built-in plugins in this system.',
    'Do not run shell commands yourself.',
    'Trust-but-verify follow-up behavior: when a follow-up question is pending, assume next user turn is the follow-up unless the user clearly starts a new topic.',
    'Return only the chat reply text.',
    `Follow-up bias active: ${followUpBias ? 'yes' : 'no'}.`,
    `Last assistant follow-up question: ${lastAssistantQuestion || 'none'}.`,
    conversationSummary ? `Recent conversation:\n${conversationSummary}` : '',
    pluginRoutingHints ? `Routing hints:\n${pluginRoutingHints}` : '',
    pluginCatalogSummary ? `Plugin catalog context:\n${pluginCatalogSummary}` : '',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ];
  return blocks.filter(Boolean).join('\n\n');
}

function buildPluginIntentPrompt(params: {
  message: string;
  systemContext: string;
  pluginCatalogSummary: string;
  pluginRoutingHints: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): string {
  const pendingSerialized = params.pendingFilesystem
    ? JSON.stringify(params.pendingFilesystem)
    : 'null';
  return [
    'You are a plugin routing arbiter for Pinokio chat.',
    'Return strict JSON only.',
    'Schema:',
    '{"resource":"plugin:playwright_agent|plugin:explorer_agent|chat","confidence":"high|medium|low","reason":"short"}',
    'Rules:',
    '- Use language nuance from the user message.',
    '- Browser/web account tasks (Outlook/Hotmail, Gmail, Twitch, websites, social media) => plugin:playwright_agent.',
    '- Requests to go through messages/posts or cleanup inbox/mailbox/social queues should route to plugin:playwright_agent (discovery first, policy clarification before mutation).',
    '- Local filesystem tasks (files/folders/path/rename/delete/move/create/list) => plugin:explorer_agent.',
    '- If the user asks for a plan that is clearly tied to a specific web account/workflow, still choose plugin:playwright_agent.',
    '- Use chat only for purely conceptual conversation not tied to any executable plugin workflow.',
    '- Respect negations (example: "not folders", "dont use explorer").',
    '- Prefer nuanced intent over keyword matching.',
    '- Trust-but-verify: if follow-up bias is active, assume this message continues the current conversation unless there is explicit new-topic intent.',
    '- Choose one resource only.',
    `Follow-up bias active: ${params.followUpBias ? 'yes' : 'no'}.`,
    `Last assistant follow-up question: ${params.lastAssistantQuestion || 'none'}.`,
    params.conversationSummary ? `Recent conversation:\n${params.conversationSummary}` : '',
    params.pluginRoutingHints ? `Routing hints:\n${params.pluginRoutingHints}` : '',
    params.pluginCatalogSummary ? `Plugin catalog context:\n${params.pluginCatalogSummary}` : '',
    params.systemContext ? `System context:\n${params.systemContext}` : '',
    `Last known file path: ${params.lastFilePath || 'none'}`,
    `Last known scope dir: ${params.lastScopeDir || 'none'}`,
    `Pending filesystem state: ${pendingSerialized}`,
    `User message:\n${params.message}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function planPluginIntentWithLlm(params: {
  message: string;
  requestedProfile: string;
  systemContext: string;
  pluginCatalogSummary: string;
  pluginRoutingHints: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): Promise<PluginIntentDecision | null> {
  const prompt = buildPluginIntentPrompt({
    message: params.message,
    systemContext: params.systemContext,
    pluginCatalogSummary: params.pluginCatalogSummary,
    pluginRoutingHints: params.pluginRoutingHints,
    lastFilePath: params.lastFilePath,
    lastScopeDir: params.lastScopeDir,
    pendingFilesystem: params.pendingFilesystem,
    conversationSummary: params.conversationSummary,
    lastAssistantQuestion: params.lastAssistantQuestion,
    followUpBias: params.followUpBias
  });
  try {
    const plan = runChatLlm({
      profile: params.requestedProfile,
      prompt,
      timeoutMs: Math.min(resolveTimeoutMs(), 10000)
    });
    const parsed = parseJsonOutput(plan.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const rawResource = asOptionalString(row.resource)?.toLowerCase() || 'chat';
    const resource: PluginIntentDecision['resource'] =
      rawResource === PLAYWRIGHT_RESOURCE
        ? PLAYWRIGHT_RESOURCE
        : rawResource === EXPLORER_RESOURCE
          ? EXPLORER_RESOURCE
          : rawResource === 'chat'
            ? 'chat'
            : null;
    if (!resource) {
      return null;
    }
    const rawConfidence = asOptionalString(row.confidence)?.toLowerCase();
    const confidence: PluginIntentDecision['confidence'] =
      rawConfidence === 'high' || rawConfidence === 'medium' || rawConfidence === 'low'
        ? rawConfidence
        : 'low';
    return {
      resource,
      confidence,
      reason: asOptionalString(row.reason)
    };
  } catch {
    return null;
  }
}

function resolveTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.PINOKIO_CHAT_LLM_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 10000) {
    return Math.min(raw, 600000);
  }
  return 240000;
}

function shouldFailOnProbe(): boolean {
  const raw = String(process.env.PINOKIO_STRICT_EGRESS_PROBE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function buildExplorerCallFromPending(
  pending: PendingFilesystemState | null,
  message: string,
  channel: string,
  responseFormat: string | null
): ExplorerCall | null {
  if (!pending) {
    return null;
  }
  const action = normalizeExplorerAction(pending.action) || 'update';
  const baseTarget: ExplorerTarget =
    pending.target && typeof pending.target === 'object' && !Array.isArray(pending.target)
      ? { ...(pending.target as ExplorerTarget) }
      : {};
  if (!baseTarget.channel) {
    baseTarget.channel = channel;
  }
  if (!baseTarget.response_format && responseFormat) {
    baseTarget.response_format = responseFormat;
  }
  if (typeof baseTarget.dry_run !== 'boolean') {
    baseTarget.dry_run = false;
  }
  if (!asOptionalString(baseTarget.desired_action)) {
    baseTarget.desired_action = action;
  }

  const inlineContent = parseInlineCreateContent(message);
  if (inlineContent) {
    baseTarget.content = inlineContent;
  } else if (!looksLikeFilesystemIntent(message)) {
    const raw = asOptionalString(message);
    if (raw && !asOptionalString(baseTarget.content)) {
      baseTarget.content = raw;
    }
  }
  if (action === 'update' && asOptionalString(baseTarget.content) && !asOptionalString(baseTarget.operation)) {
    baseTarget.operation = 'write';
  }

  if (isMutationAction(action) && !asOptionalString(baseTarget.path)) {
    return null;
  }
  return { action, target: baseTarget };
}

function resolveNextLastFilePath(
  call: ExplorerCall,
  previousLastFilePath: string | null
): string | null {
  const routedPath = asOptionalString(call.target.path);
  const operation = asOptionalString(call.target.operation)?.toLowerCase();

  if (call.action === 'delete') {
    if (routedPath && previousLastFilePath) {
      const samePath = path.resolve(routedPath) === path.resolve(previousLastFilePath);
      if (samePath) {
        return null;
      }
    }
    return previousLastFilePath;
  }

  if (call.action === 'update' && operation === 'rename') {
    const newName = asOptionalString(call.target.new_name);
    if (routedPath && newName && !newName.includes('/') && !newName.includes('\\')) {
      return path.join(path.dirname(routedPath), newName);
    }
  }

  if (call.action === 'update' && operation === 'move') {
    const destination = asOptionalString(call.target.destination);
    if (routedPath && destination) {
      if (path.isAbsolute(destination)) {
        return destination;
      }
      return path.join(path.dirname(routedPath), destination);
    }
  }

  return routedPath || previousLastFilePath;
}

(async () => {
try {
  const { request } = pluginContext();
  const action = String(request.action || '').toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`chat_worker_agent plugin does not support action '${action}'`);
  }

  const targetMeta = parseTargetMeta(request.target);

  // --- load_history: return chat history from DB without LLM call ---
  const op = typeof targetMeta.op === 'string' ? (targetMeta.op as string).trim().toLowerCase() : '';
  if (op === 'load_history') {
    const historyChannel = asOptionalString(targetMeta.channel) || 'default';
    const historyLimit = Math.min(Math.max(Number(targetMeta.limit) || 50, 1), 200);
    try {
      if (shouldUseChatDb()) {
        const conn = resolveChatDbConnectionWithTimeout(4000);
        ensureChatSchema(conn);
        const sessions = listSessions(conn, { channel: historyChannel, status: 'active', limit: 1 });
        if (sessions.length > 0) {
          const dbMessages = getSessionMessages(conn, sessions[0].id, { limit: historyLimit });
          respond({
            ok: true,
            plugin: 'chat_worker_agent',
            mode: 'load_history',
            source: 'database',
            channel: historyChannel,
            session_id: sessions[0].id,
            session_key: sessions[0].session_key,
            messages: dbMessages.map((m) => ({
              role: m.role,
              content: m.content,
              created_at: m.created_at,
              importance: m.importance,
              response_mode: m.response_mode,
              routed_resource: m.routed_resource,
            })),
          });
          return;
        }
      }
      // No DB sessions (or DB disabled) — try filesystem state
      const fsState = loadChannelState(historyChannel);
      const conversation = normalizeConversation(fsState?.conversation);
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'load_history',
        source: conversation.length > 0 ? 'filesystem' : 'none',
        channel: historyChannel,
        messages: conversation.map((turn) => ({
          role: turn.role,
          content: turn.content,
          created_at: turn.at,
        })),
      });
    } catch {
      // DB failed — fall back to filesystem
      const fsState = loadChannelState(historyChannel);
      const conversation = normalizeConversation(fsState?.conversation);
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'load_history',
        source: conversation.length > 0 ? 'filesystem_fallback' : 'none',
        channel: historyChannel,
        messages: conversation.map((turn) => ({
          role: turn.role,
          content: turn.content,
          created_at: turn.at,
        })),
      });
    }
    return;
  }

  const message = normalizeMessage(request.summary, targetMeta);
  const requestedProfile =
    (typeof targetMeta.profile === 'string' && targetMeta.profile.trim()) ||
    (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
    'codex';
  const systemContext =
    typeof targetMeta.system === 'string' ? targetMeta.system.trim() : '';
  const runtime = normalizeRuntime(targetMeta.runtime);
  const channel = asOptionalString(targetMeta.channel) || 'default';
  const channelState = loadChannelState(channel);
  const priorConversation = normalizeConversation(channelState?.conversation);
  const conversationWithUser = appendConversationTurn(priorConversation, 'user', message);
  const lastFilePath = asOptionalString(channelState?.last_file_path);
  const lastScopeDir = asOptionalString(channelState?.last_scope_dir);
  const lastBrowserUrl = asOptionalString(channelState?.last_browser_url);
  const lastBrowserRuntime = asOptionalString(channelState?.last_browser_runtime);
  const lastBrowserDesiredAction = normalizeCrudAction(channelState?.last_browser_desired_action);
  let lastBrowserCleanupIntent = toBool(channelState?.last_browser_cleanup_intent, false);
  let lastBrowserPolicyNeeded = toBool(channelState?.last_browser_policy_needed, false);
  let lastBrowserWorkflowState = normalizeBrowserWorkflowState(
    channelState?.last_browser_workflow_state
  );
  let lastBrowserWorkflowEventHint = asOptionalString(channelState?.last_browser_workflow_event);
  let lastBrowserPendingStep = asOptionalString(channelState?.last_browser_pending_step);
  let lastBrowserLastTransition = asOptionalString(channelState?.last_browser_last_transition);
  let lastBrowserLastError = asOptionalString(channelState?.last_browser_last_error);
  const lastBrowserWorkflowUpdatedAt =
    asOptionalString(channelState?.last_browser_workflow_updated_at) ||
    asOptionalString(channelState?.updated_at);
  if (isBrowserWorkflowStateStale(lastBrowserWorkflowState, lastBrowserWorkflowUpdatedAt)) {
    lastBrowserWorkflowState = 'idle';
    lastBrowserCleanupIntent = false;
    lastBrowserPolicyNeeded = false;
  }
  const browserModeHint = asOptionalString(targetMeta.browser_mode_hint);
  const browserStateHintRaw = asOptionalString(targetMeta.browser_workflow_state_hint);
  const browserPendingStepHint = asOptionalString(targetMeta.browser_pending_step_hint);
  const browserLastTransitionHint = asOptionalString(targetMeta.browser_last_transition_hint);
  const browserLastErrorHint = asOptionalString(targetMeta.browser_last_error_hint);
  const browserChallengeHint = toBool(targetMeta.browser_challenge_detected_hint, false);
  const browserPolicyNeededHintValue = targetMeta.browser_policy_needed_hint;
  const browserPolicyNeededHint =
    browserPolicyNeededHintValue === undefined
      ? null
      : toBool(browserPolicyNeededHintValue, lastBrowserPolicyNeeded);
  const browserCleanupIntentHintValue = targetMeta.browser_cleanup_intent_hint;
  const browserCleanupIntentHint =
    browserCleanupIntentHintValue === undefined
      ? null
      : toBool(browserCleanupIntentHintValue, lastBrowserCleanupIntent);
  if (browserModeHint || browserStateHintRaw || browserPendingStepHint || browserLastErrorHint || browserLastTransitionHint) {
    const hintState = browserStateHintRaw
      ? normalizeBrowserWorkflowState(browserStateHintRaw)
      : mapBrowserModeHintToWorkflowState({
          mode: browserModeHint,
          challengeDetected: browserChallengeHint,
          pendingStep: browserPendingStepHint,
          fallbackState: lastBrowserWorkflowState
        });
    lastBrowserWorkflowState = hintState;
    if (browserPolicyNeededHint !== null) {
      lastBrowserPolicyNeeded = browserPolicyNeededHint;
    }
    if (browserCleanupIntentHint !== null) {
      lastBrowserCleanupIntent = browserCleanupIntentHint;
    }
    lastBrowserWorkflowEventHint = eventForBrowserWorkflowState(hintState);
    if (browserPendingStepHint) {
      lastBrowserPendingStep = browserPendingStepHint;
    }
    if (browserLastTransitionHint) {
      lastBrowserLastTransition = browserLastTransitionHint;
    } else if (browserModeHint) {
      lastBrowserLastTransition = `mode:${browserModeHint}`;
    }
    if (browserLastErrorHint) {
      lastBrowserLastError = browserLastErrorHint;
    }
  }
  const lastBrowserWorkflowEvent = eventForBrowserWorkflowState(lastBrowserWorkflowState);
  const pendingFilesystem = normalizePendingFilesystem(channelState?.pending_filesystem);
  const lastAssistantQuestion = asOptionalString(channelState?.last_assistant_question);
  const conversationSummary = conversationSummaryForPrompt(conversationWithUser);
  const followUpBias = shouldBiasToConversationFollowUp({
    message,
    pendingFilesystem,
    lastAssistantQuestion,
    browserPolicyPending: Boolean(lastBrowserUrl) && lastBrowserPolicyNeeded,
    browserWorkflowEvent: lastBrowserWorkflowEvent
  });

  // --- Chat DB persistence (best-effort, never blocks response) ---
  let chatDbConnection: ChatDbConnection | null = null;
  let chatDbSession: ChatSession | null = null;
  let chatDbEnabled = false;
  try {
    if (shouldUseChatDb()) {
      chatDbConnection = resolveChatDbConnectionWithTimeout(6000);
      ensureChatSchema(chatDbConnection);
      chatDbSession = findOrCreateSession(chatDbConnection, {
        channel,
        agent_id: process.env.PINOKIO_SOCKET_AGENT_ID || null,
        caller_agent_id: process.env.PINOKIO_CALLER_AGENT_ID || null,
        caller_resource: process.env.PINOKIO_SOCKET_RESOURCE || null,
        max_age_minutes: 30,
      });
      chatDbEnabled = true;
    }
  } catch {
    chatDbEnabled = false;
  }

  interface ChatDbMeta {
    response_mode?: string;
    llm_profile?: string;
    llm_provider?: string;
    llm_model?: string;
    routed_resource?: string;
    routed_action?: string;
  }

  const persistConversationState = (
    assistantText: string | null,
    patch: Partial<ChatChannelState> = {},
    dbMeta?: ChatDbMeta
  ): void => {
    // --- Filesystem persistence (existing, unchanged) ---
    const conversation = assistantText
      ? appendConversationTurn(conversationWithUser, 'assistant', assistantText)
      : conversationWithUser;
    const questionFromAssistant = assistantText
      ? inferAssistantFollowUpQuestion(assistantText)
      : null;
    saveChannelState(
      channel,
      buildChannelState(channelState, {
        conversation,
        last_assistant_question: questionFromAssistant,
        last_browser_workflow_event:
          lastBrowserWorkflowEventHint ||
          eventForBrowserWorkflowState(lastBrowserWorkflowState),
        last_browser_last_transition: lastBrowserLastTransition || undefined,
        last_browser_pending_step: lastBrowserPendingStep || undefined,
        last_browser_last_error: lastBrowserLastError || undefined,
        ...patch
      })
    );

    // --- Database persistence (best-effort) ---
    if (chatDbEnabled && chatDbConnection && chatDbSession) {
      try {
        const turnIndex = chatDbSession.message_count;
        const userFlags = autoFlagImportance(message, 'user', dbMeta?.response_mode || null);
        insertMessage(chatDbConnection, {
          session_id: chatDbSession.id,
          role: 'user',
          content: message,
          turn_index: turnIndex,
          importance: userFlags.importance,
          flagged_for_memory: userFlags.flagged_for_memory,
          tags: userFlags.auto_tags,
          response_mode: dbMeta?.response_mode,
        });
        if (assistantText) {
          const assistantFlags = autoFlagImportance(
            assistantText, 'assistant', dbMeta?.response_mode || null
          );
          insertMessage(chatDbConnection, {
            session_id: chatDbSession.id,
            role: 'assistant',
            content: assistantText,
            turn_index: turnIndex + 1,
            importance: assistantFlags.importance,
            flagged_for_memory: assistantFlags.flagged_for_memory,
            tags: assistantFlags.auto_tags,
            llm_profile: dbMeta?.llm_profile,
            llm_provider: dbMeta?.llm_provider,
            llm_model: dbMeta?.llm_model,
            routed_resource: dbMeta?.routed_resource,
            routed_action: dbMeta?.routed_action,
            response_mode: dbMeta?.response_mode,
          });
        }
        updateSessionCounters(chatDbConnection, chatDbSession.id);
      } catch {
        // DB write failure is non-fatal; filesystem state is primary
      }
    }
  };
  if (looksLikeBrowserWorkflowCancelMessage(message)) {
    const hadActiveBrowserWorkflow =
      isActiveBrowserWorkflowState(lastBrowserWorkflowState) ||
      Boolean(lastBrowserUrl) ||
      Boolean(lastBrowserPolicyNeeded) ||
      Boolean(lastBrowserCleanupIntent);
    const cancellationResponse = hadActiveBrowserWorkflow
      ? 'Stopped the active browser automation workflow for this chat channel. You can start a fresh browser task anytime.'
      : 'There is no active browser automation workflow to stop in this chat channel.';
    persistConversationState(cancellationResponse, {
      pending_filesystem: null,
      last_browser_url: undefined,
      last_browser_runtime: undefined,
      last_browser_desired_action: undefined,
      last_browser_cleanup_intent: false,
      last_browser_policy_needed: false,
      last_browser_workflow_state: 'idle',
      last_browser_workflow_updated_at: new Date().toISOString(),
      last_browser_workflow_event: 'RESET',
      last_browser_last_transition: 'cancelled',
      last_browser_pending_step: undefined,
      last_browser_last_error: undefined
    }, { response_mode: 'browser_workflow_cancelled' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'browser_workflow_cancelled',
      runtime: 'container',
      chat_response: cancellationResponse
    });
    return;
  }
  if (looksLikeBrowserWorkflowStatusMessage(message)) {
    const statusResponse = describeBrowserWorkflowStatus({
      state: lastBrowserWorkflowState,
      url: lastBrowserUrl,
      cleanupIntent: lastBrowserCleanupIntent,
      policyNeeded: lastBrowserPolicyNeeded,
      pendingStep: lastBrowserPendingStep,
      lastTransition: lastBrowserLastTransition,
      lastError: lastBrowserLastError
    });
    persistConversationState(statusResponse, {
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'browser_workflow_status' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'browser_workflow_status',
      runtime: 'container',
      chat_response: statusResponse
    });
    return;
  }
  const responseFormat = asOptionalString(targetMeta.response_format);
  const pluginCatalog = loadPluginCatalogFromSocketBus();
  const pluginCatalogKnown = Boolean(pluginCatalog);
  const pluginCatalogSummary = summarizePluginCatalog(pluginCatalog);
  const pluginRoutingHints = summarizePluginRoutingHints(pluginCatalog);
  const playwrightAvailable = hasResourceInCatalog(pluginCatalog, PLAYWRIGHT_RESOURCE);
  const explorerAvailable = hasResourceInCatalog(pluginCatalog, EXPLORER_RESOURCE);
  const playwrightUsable = playwrightAvailable || !pluginCatalogKnown;
  const explorerUsable = explorerAvailable || !pluginCatalogKnown;
  const browserWorkflowControlRequest = looksLikeBrowserWorkflowControlMessage(message);
  const browserPolicyPresetChoice =
    Boolean(lastBrowserUrl) &&
    !looksLikeExplicitNewConversation(message) &&
    (lastBrowserPolicyNeeded || lastBrowserWorkflowState === 'needs_policy') &&
    Boolean(parseCleanupPolicyPreset(message));
  const pluginIntentDecision =
    browserPolicyPresetChoice
      ? {
          resource: PLAYWRIGHT_RESOURCE,
          confidence: 'high',
          reason: 'cleanup policy preset selected'
        }
      : browserWorkflowControlRequest && Boolean(lastBrowserUrl)
      ? {
          resource: PLAYWRIGHT_RESOURCE,
          confidence: 'high',
          reason: 'explicit browser workflow control command'
        }
      : playwrightAvailable || explorerAvailable
      ? await planPluginIntentWithLlm({
          message,
          requestedProfile,
          systemContext,
          pluginCatalogSummary,
          pluginRoutingHints,
          lastFilePath: lastFilePath ?? null,
          lastScopeDir: lastScopeDir ?? null,
          pendingFilesystem,
          conversationSummary,
          lastAssistantQuestion: lastAssistantQuestion ?? null,
          followUpBias
        })
      : null;
  const biasToPendingFilesystem =
    followUpBias &&
    Boolean(pendingFilesystem) &&
    explorerUsable &&
    (
      !pluginIntentDecision ||
      pluginIntentDecision.confidence !== 'high' ||
      pluginIntentDecision.resource === EXPLORER_RESOURCE
    );
  const llmWantsPlaywright =
    !biasToPendingFilesystem && pluginIntentDecision?.resource === PLAYWRIGHT_RESOURCE;
  const llmWantsExplorer =
    pluginIntentDecision?.resource === EXPLORER_RESOURCE || biasToPendingFilesystem;
  const llmWantsChat =
    !biasToPendingFilesystem && pluginIntentDecision?.resource === 'chat';
  const browserResumeRequest = looksLikeBrowserWorkflowResumeMessage(message);
  const browserAutomationIntent = looksLikeBrowserAutomationIntent(message);
  const browserFollowupAck = isBrowserFollowupAckMessage(message);
  const browserSkillExportRequest = looksLikeBrowserSkillExportIntent(message);
  const browserSkillName = parseSkillNameFromMessage(message);
  const browserContinuationSignal = inferBrowserContinuationSignal({
    message,
    lastAssistantQuestion,
    lastBrowserUrl: lastBrowserUrl ?? null,
    lastBrowserCleanupIntent,
    lastBrowserPolicyNeeded,
    lastBrowserWorkflowState
  });
  const browserPolicyFollowUp = browserContinuationSignal.isFollowUp;
  const explicitPathSyntax = looksLikeExplicitPathSyntax(message);
  const browserThreadContinuation =
    Boolean(lastBrowserUrl) &&
    !looksLikeExplicitNewConversation(message) &&
    (browserFollowupAck ||
      browserResumeRequest ||
      browserSkillExportRequest ||
      browserPolicyFollowUp ||
      (Boolean(browserContinuationSignal.event) &&
        browserContinuationSignal.event !== 'RESET') ||
      (lastBrowserPolicyNeeded && messageHasCleanupPolicyDetails(message)));
  const heuristicFilesystemIntent =
    looksLikeFilesystemIntent(message) &&
    !(browserAutomationIntent && !explicitPathSyntax) &&
    !(browserThreadContinuation && !explicitPathSyntax);
  const filesystemIntent = llmWantsExplorer
    ? true
    : llmWantsChat
      ? false
      : heuristicFilesystemIntent;
  const readableBytesReply = maybeReadableBytesReply(message);

  if (readableBytesReply) {
    persistConversationState(readableBytesReply, {
      last_browser_workflow_state: 'idle',
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'local_readable_bytes' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'local_readable_bytes',
      runtime: 'container',
      chat_response: readableBytesReply
    });
    return;
  }

  const shouldRoutePlaywright =
    playwrightUsable &&
    (llmWantsPlaywright ||
      (browserResumeRequest && Boolean(lastBrowserUrl)) ||
      (browserWorkflowControlRequest && Boolean(lastBrowserUrl)) ||
      (!pluginIntentDecision && browserAutomationIntent) ||
      (browserFollowupAck && Boolean(lastBrowserUrl)) ||
      browserSkillExportRequest ||
      browserPolicyFollowUp);

  if ((browserResumeRequest || browserWorkflowControlRequest) && !lastBrowserUrl && !browserAutomationIntent) {
    const resumeResponse =
      'There is no active browser workflow to resume in this chat channel. Start a new browser task first.';
    persistConversationState(resumeResponse, {
      last_browser_workflow_state: 'idle',
      last_browser_workflow_event: 'RESET',
      last_browser_last_transition: 'resume_missing',
      last_browser_pending_step: undefined,
      last_browser_last_error: undefined,
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'browser_workflow_resume_missing' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'browser_workflow_resume_missing',
      runtime: 'container',
      chat_response: resumeResponse
    });
    return;
  }

  if (shouldRoutePlaywright) {
    const playwrightCall = buildPlaywrightCallFromMessage(message, action, {
      channel,
      responseFormat,
      lastBrowserUrl,
      lastBrowserRuntime,
      lastBrowserDesiredAction,
      lastBrowserCleanupIntent,
      lastBrowserPolicyNeeded,
      lastBrowserWorkflowState,
      browserSkillExportRequest,
      browserSkillName,
      continueBrowserThread:
        browserResumeRequest ||
        browserPolicyFollowUp ||
        browserSkillExportRequest ||
        isActiveBrowserWorkflowState(lastBrowserWorkflowState)
    });
    const playwrightRuntime =
      asOptionalString(playwrightCall.target.delegate_runtime) ??
      asOptionalString(playwrightCall.target.runtime) ??
      undefined;
    const routedUrl = asOptionalString(playwrightCall.target.url);
    const routedCleanupIntent = toBool(
      playwrightCall.target.cleanup_intent,
      lastBrowserCleanupIntent
    ) || (browserThreadContinuation && lastBrowserCleanupIntent);
    const routedCleanupPolicyProvided = toBool(
      playwrightCall.target.cleanup_policy_provided,
      false
    );
    const playwrightChatResponse = routedUrl
      ? `Routing via Playwright Plugin on ${routedUrl}.`
      : 'Routing via Playwright Plugin.';
    persistConversationState(playwrightChatResponse, {
      pending_filesystem: null,
      last_browser_url: routedUrl || lastBrowserUrl || undefined,
      last_browser_runtime: playwrightRuntime || lastBrowserRuntime || undefined,
      last_browser_desired_action:
        normalizeCrudAction(playwrightCall.target.desired_action) ||
        lastBrowserDesiredAction ||
        undefined,
      last_browser_cleanup_intent: routedCleanupIntent,
      last_browser_policy_needed:
        routedCleanupIntent && !routedCleanupPolicyProvided,
      last_browser_workflow_state:
        normalizeBrowserWorkflowState(playwrightCall.target.workflow_state),
      last_browser_workflow_event:
        eventForBrowserWorkflowState(
          normalizeBrowserWorkflowState(playwrightCall.target.workflow_state)
        ),
      last_browser_last_transition: 'route:playwright',
      last_browser_pending_step:
        asOptionalString(targetMeta.browser_pending_step_hint) || undefined,
      last_browser_last_error:
        asOptionalString(targetMeta.browser_last_error_hint) || undefined,
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'plugin_first_playwright', routed_resource: PLAYWRIGHT_RESOURCE, routed_action: playwrightCall.action, llm_profile: requestedProfile });
    spawnChild(
      {
        summary: `browser request: ${message}`,
        resource: PLAYWRIGHT_RESOURCE,
        action: playwrightCall.action,
        target: JSON.stringify(playwrightCall.target),
        container_image: null,
        llm_profile: requestedProfile
      },
      {
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'plugin_first_playwright',
        runtime: 'container',
        routed_resource: PLAYWRIGHT_RESOURCE,
        routed_action: playwrightCall.action,
        routed_target: playwrightCall.target,
        chat_response: playwrightChatResponse
      }
    );
    return;
  }

  if ((llmWantsPlaywright || browserAutomationIntent) && !playwrightUsable) {
    const missingPlaywrightResponse =
      "Playwright Plugin isn't available right now. Install/enable `pinokio.playwright` in /ui/plugins, then retry.";
    persistConversationState(missingPlaywrightResponse, {
      last_browser_workflow_state: 'idle',
      last_browser_workflow_event: 'RESET',
      last_browser_last_transition: 'plugin_missing_playwright',
      last_browser_pending_step: undefined,
      last_browser_last_error: undefined,
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'plugin_missing_playwright' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'plugin_missing_playwright',
      runtime: 'container',
      chat_response: missingPlaywrightResponse
    });
    return;
  }

  if (explorerUsable && !llmWantsPlaywright && (!llmWantsChat || Boolean(pendingFilesystem))) {
    const fallbackExplorerCall = buildExplorerTargetFromMessage(message, action, {
      channel,
      response_format: responseFormat ?? undefined,
      last_file_path: lastFilePath ?? undefined
    });
    const pendingExplorerCall = buildExplorerCallFromPending(
      pendingFilesystem,
      message,
      channel,
      responseFormat ?? null
    );
    const heuristicRoute = chooseHeuristicExplorerRoute({
      message,
      filesystemIntent,
      pendingFilesystem,
      pendingExplorerCall,
      fallbackExplorerCall,
      lastFilePath
    });

    const llmPlan =
      heuristicRoute.should_route && heuristicRoute.confidence === 'low'
        ? await planExplorerCallWithLlm({
            message,
            requestedAction: action,
            requestedProfile,
            channel,
            responseFormat: responseFormat ?? null,
            systemContext,
            pluginCatalogSummary,
            lastFilePath,
            lastScopeDir: lastScopeDir ?? null,
            pendingFilesystem,
            conversationSummary,
            lastAssistantQuestion: lastAssistantQuestion ?? null,
            followUpBias
          })
        : {
            route: null as 'explorer' | 'chat' | null,
            call: null as ExplorerCall | null,
            chatResponse: null as string | null,
            needsClarification: null as string | null,
            pendingTarget: null as ExplorerTarget | null
          };

    const shouldRouteExplorer =
      heuristicRoute.confidence === 'high'
        ? heuristicRoute.should_route
        : Boolean(heuristicRoute.call) ||
          Boolean(llmPlan.call) ||
          llmPlan.route === 'explorer' ||
          (heuristicRoute.should_route && llmPlan.route !== 'chat');

    if (shouldRouteExplorer) {
      if (llmPlan.needsClarification && !llmPlan.call && !pendingExplorerCall && !fallbackExplorerCall) {
        const pendingAction =
          normalizeExplorerAction(
            llmPlan.pendingTarget?.desired_action || pendingFilesystem?.action || action
          ) || 'read';
        const pendingTarget: ExplorerTarget = {
          ...(pendingFilesystem?.target || {}),
          ...(llmPlan.pendingTarget || {}),
          channel,
          dry_run: false
        };
        persistConversationState(llmPlan.needsClarification, {
          pending_filesystem: {
            action: pendingAction,
            target: pendingTarget,
            question: llmPlan.needsClarification,
            requested_at: new Date().toISOString()
          },
          last_browser_workflow_state: 'idle',
          last_browser_workflow_updated_at: new Date().toISOString()
        }, { response_mode: 'plugin_filesystem_needs_details' });
        respond({
          ok: true,
          plugin: 'chat_worker_agent',
          mode: 'plugin_filesystem_needs_details',
          runtime: 'container',
          chat_response: llmPlan.needsClarification
        });
        return;
      }

      let usedLlmPlan = Boolean(llmPlan.call);
      let explorerCall = llmPlan.call || heuristicRoute.call;
      if (llmPlan.call && shouldPreferFallbackExplorerCall({
        llmCall: llmPlan.call,
        fallbackCall: heuristicRoute.call,
        message,
        lastFilePath
      })) {
        explorerCall = heuristicRoute.call;
        usedLlmPlan = false;
      }

      if (explorerCall) {
        explorerCall = enforcePriorFileWriteCall(explorerCall, message, lastFilePath);
        const routedPath = asOptionalString(explorerCall.target.path);
        if (isMutationAction(explorerCall.action) && !routedPath) {
          const clarification = /\brename\b/i.test(String(message || ''))
            ? 'Which file should I rename? You can give a full path or say "rename that file to <name>".'
            : 'Which file/path should I apply this change to?';
          persistConversationState(clarification, {
            pending_filesystem: {
              action: explorerCall.action,
              target: explorerCall.target,
              question: clarification,
              requested_at: new Date().toISOString()
            },
            last_browser_workflow_state: 'idle',
            last_browser_workflow_updated_at: new Date().toISOString()
          }, { response_mode: 'plugin_filesystem_needs_details' });
          respond({
            ok: true,
            plugin: 'chat_worker_agent',
            mode: 'plugin_filesystem_needs_details',
            runtime: 'container',
            chat_response: clarification
          });
          return;
        }
        if (
          isExplicitPriorFileWriteIntent(message, lastFilePath) &&
          !asOptionalString(explorerCall.target.content)
        ) {
          const clarification = 'What text should I write into that file?';
          persistConversationState(clarification, {
            pending_filesystem: {
              action: explorerCall.action,
              target: explorerCall.target,
              question: clarification,
              requested_at: new Date().toISOString()
            },
            last_browser_workflow_state: 'idle',
            last_browser_workflow_updated_at: new Date().toISOString()
          }, { response_mode: 'plugin_filesystem_needs_details' });
          respond({
            ok: true,
            plugin: 'chat_worker_agent',
            mode: 'plugin_filesystem_needs_details',
            runtime: 'container',
            chat_response: clarification
          });
          return;
        }
        const nextLastFilePath = resolveNextLastFilePath(
          explorerCall,
          asOptionalString(channelState?.last_file_path)
        );
        const directoryChatResponse =
          (usedLlmPlan ? llmPlan.chatResponse : null) ||
          (usedLlmPlan
            ? 'Planned and executing this through Directory Plugin.'
            : 'Executing through Directory Plugin.');
        persistConversationState(directoryChatResponse, {
          last_file_path: nextLastFilePath || undefined,
          last_scope_dir:
            (nextLastFilePath ? path.dirname(nextLastFilePath) : null) ||
            asOptionalString(explorerCall.target.scope_dir) ||
            (routedPath ? path.dirname(routedPath) : channelState?.last_scope_dir),
          pending_filesystem: null,
          last_browser_workflow_state: 'idle',
          last_browser_workflow_updated_at: new Date().toISOString()
        }, { response_mode: usedLlmPlan ? 'plugin_first_directory_llm' : 'plugin_first_directory', routed_resource: EXPLORER_RESOURCE, routed_action: explorerCall.action, llm_profile: requestedProfile });
        spawnChild(
          {
            summary: `directory request: ${message}`,
            resource: EXPLORER_RESOURCE,
            action: explorerCall.action,
            target: JSON.stringify(explorerCall.target),
            container_image: null,
            llm_profile: requestedProfile
          },
          {
            ok: true,
            plugin: 'chat_worker_agent',
            mode: usedLlmPlan ? 'plugin_first_directory_llm' : 'plugin_first_directory',
            runtime: 'container',
            routed_resource: EXPLORER_RESOURCE,
            routed_action: explorerCall.action,
            routed_target: explorerCall.target,
            chat_response: directoryChatResponse
          }
        );
        return;
      }

      const clarification =
        llmPlan.needsClarification ||
        'I can run that through Directory Plugin, but I need a concrete target path or filename (and content for file creation when needed).';
      persistConversationState(clarification, {
        pending_filesystem: {
          action: normalizeExplorerAction(action) || 'read',
          target: pendingFilesystem?.target || llmPlan.pendingTarget || undefined,
          question: clarification,
          requested_at: new Date().toISOString()
        },
        last_browser_workflow_state: 'idle',
        last_browser_workflow_updated_at: new Date().toISOString()
      }, { response_mode: 'plugin_filesystem_needs_details' });
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'plugin_filesystem_needs_details',
        runtime: 'container',
        chat_response: clarification
      });
      return;
    }
  }

  if (filesystemIntent && !explorerUsable) {
    const missingDirectoryResponse =
      "Directory Plugin isn't available right now. Install/enable `pinokio.explorer` in /ui/plugins, then retry.";
    persistConversationState(missingDirectoryResponse, {
      last_browser_workflow_state: 'idle',
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'plugin_missing_directory' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'plugin_missing_directory',
      runtime: 'container',
      chat_response: missingDirectoryResponse
    });
    return;
  }

  if (runtime === 'unsafe_host') {
    const mode =
      typeof targetMeta.mode === 'string' && (targetMeta.mode as string).trim().toLowerCase() === 'command'
        ? 'command'
        : 'llm';
    const delegateTarget: Record<string, unknown> = {
      mode,
      message,
      profile: requestedProfile,
      system: systemContext
    };
    if (mode === 'command') {
      const command = typeof targetMeta.command === 'string' ? (targetMeta.command as string).trim() : '';
      if (!command) {
        fail('unsafe host command mode requires target.command');
      }
      delegateTarget.command = command;
    }
    const unsafeHostResponse =
      mode === 'command'
        ? 'Delegating this command to the unsafe host agent.'
        : 'Delegating this request to the unsafe host agent.';
    persistConversationState(unsafeHostResponse, {
      pending_filesystem: null,
      last_browser_workflow_state: 'idle',
      last_browser_workflow_updated_at: new Date().toISOString()
    }, { response_mode: 'spawn_child_unsafe_host' });

    spawnChild(
      {
        summary: message,
        resource: 'plugin:unsafe_host_agent',
        action: 'read',
        target: JSON.stringify(delegateTarget),
        container_image: null,
        llm_profile: requestedProfile
      },
      {
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'spawn_child_unsafe_host',
        runtime: 'unsafe_host',
        chat_response: unsafeHostResponse
      }
    );
  } else {
    const prompt = buildChatPrompt(
      message,
      systemContext,
      pluginCatalogSummary,
      pluginRoutingHints,
      conversationSummary,
      lastAssistantQuestion,
      followUpBias
    );
    const probeHosts = resolveProbeHosts(requestedProfile);
    const probe = await probeAnyHttpsHost(probeHosts, 8000, 2);
    if (!probe.ok && shouldFailOnProbe()) {
      throw new Error(
        [
          `container outbound HTTPS probe failed for provider profile '${requestedProfile}'.`,
          `hosts checked: ${probeHosts.join(', ')}`,
          `probe detail: ${probe.errors[probe.errors.length - 1] || 'unknown'}.`,
          'This container runtime cannot reliably reach provider APIs from inside Docker.',
          `If you are using Colima, verify VM egress with: colima ssh -- curl -I -m 8 https://${probeHosts[0]}`
        ].join(' ')
      );
    }

    try {
      const timeoutMs = resolveTimeoutMs();
      const chat = runChatLlm({ profile: requestedProfile, prompt, timeoutMs });
      persistConversationState(chat.text, {
        pending_filesystem: null,
        last_browser_workflow_state: 'idle',
        last_browser_workflow_updated_at: new Date().toISOString()
      }, { response_mode: 'chat', llm_profile: chat.profile, llm_provider: chat.provider, llm_model: chat.model });
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'chat',
        runtime: 'container',
        profile: chat.profile,
        provider: chat.provider,
        model: chat.model,
        chat_prompt: message,
        chat_response: chat.text,
        network_probe: {
          ok: probe.ok,
          host: probe.host,
          checked_hosts: probeHosts
        }
      });
    } catch (error) {
      if (!probe.ok) {
        const llmError = error instanceof Error ? error.message : String(error);
        throw new Error(
          [
            llmError,
            `egress probe also failed across hosts: ${probeHosts.join(', ')}.`,
            `last probe error: ${probe.errors[probe.errors.length - 1] || 'unknown'}.`
          ].join(' ')
        );
      }
      throw error;
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
})();
