import type { BrowserWorkflowState } from './types.ts';

// ── Shared constants ────────────────────────────────────────────────

export const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

export const BROWSER_WORKFLOW_STATE_VALUES: BrowserWorkflowState[] = [
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

// ── Action normalization ────────────────────────────────────────────

export function normalizeCrudAction(value: unknown): string | null {
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

export function normalizeExplorerAction(value: unknown): string | null {
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

export function isMutationAction(action: string): boolean {
  return action === 'create' || action === 'update' || action === 'delete';
}

// ── Browser workflow state ──────────────────────────────────────────

export function isBrowserWorkflowState(value: unknown): value is BrowserWorkflowState {
  const candidate = String(value || '').trim().toLowerCase();
  return BROWSER_WORKFLOW_STATE_VALUES.includes(candidate as BrowserWorkflowState);
}

export function normalizeBrowserWorkflowState(value: unknown): BrowserWorkflowState {
  const normalized = String(value || '').trim().toLowerCase();
  if (isBrowserWorkflowState(normalized)) {
    return normalized;
  }
  return 'idle';
}

// ── Path syntax detection ───────────────────────────────────────────

export function looksLikeExplicitPathSyntax(message: string): boolean {
  const raw = String(message || '');
  if (!raw.trim()) {
    return false;
  }
  if (/(^|\s)(~\/|\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(raw)) {
    return true;
  }
  return /`[^`]*[\/\\][^`]*`/.test(raw);
}
