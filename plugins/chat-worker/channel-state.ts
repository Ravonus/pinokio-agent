import fs from 'node:fs';
import path from 'node:path';
import type { ChatDbConnection } from '../../sdk/typescript/pinokio-sdk.ts';
import {
  resolveChatDbConnection,
  ensureChatSchema,
  listSessions,
  getSessionMessages,
} from '../../sdk/typescript/chat-db.ts';
import { toBool, toInt, asOptionalString } from '../plugin-utils.ts';
import type {
  ChatChannelState,
  ConversationTurn,
  PendingFilesystemState,
  ExplorerTarget,
  BrowserWorkflowState,
} from './types.ts';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function shouldUseChatDb(): boolean {
  return toBool(process.env.PINOKIO_CHAT_DB_ENABLED, true);
}

export function resolveChatDbConnectionWithTimeout(defaultTimeoutMs: number): ChatDbConnection {
  const timeoutMs = toInt(
    process.env.PINOKIO_CHAT_DB_TIMEOUT_MS,
    defaultTimeoutMs,
    500,
    60000
  );
  return resolveChatDbConnection({ timeoutMs });
}

export function sanitizeStateToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
}

export function resolveChannelStatePaths(channel: string): string[] {
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

export function readChannelStateFromPath(statePath: string): ChatChannelState | null {
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

export function normalizePendingFilesystem(value: unknown): PendingFilesystemState | null {
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

export function normalizeConversation(value: unknown): ConversationTurn[] {
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

export function appendConversationTurn(
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

export function buildChannelState(
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

export function loadChannelState(channel: string): ChatChannelState | null {
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

export function writeChannelState(channel: string, state: ChatChannelState): boolean {
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

export function saveChannelState(channel: string, state: ChatChannelState): void {
  const channels = channel === 'default' ? ['default'] : [channel, 'default'];
  for (const stateChannel of channels) {
    if (writeChannelState(stateChannel, state)) {
      continue;
    }
  }
}
