import { createActor, createMachine } from 'xstate';
import { asOptionalString, toBool, toInt, parseJsonOutput } from '../plugin-utils.ts';
import type {
  BrowserWorkflowState,
  BrowserWorkflowEventType,
  BrowserContinuationSignal,
  PlaywrightCall,
  PlaywrightTarget,
  BuildPlaywrightOptions,
  PendingFilesystemState,
  CleanupPolicyPreset,
} from './types.ts';
import {
  shouldBiasToConversationFollowUp,
  looksLikeBrowserWorkflowCancelMessage,
  looksLikeBrowserWorkflowResumeMessage,
  inferCleanupIntentFromMessage,
  messageHasCleanupPolicyDetails,
  isBrowserFollowupAckMessage,
  looksLikeBrowserSkillExportIntent,
  messageRequestsProbeLabelMode,
  messageRequestsUseSavedLabels,
  messageRequestsProbeLabelReset,
  messageRequestsNetworkCandidatePreview,
  looksLikeBrowserWorkflowControlMessage,
  messageHasCleanupExecutionApproval,
  inferCleanupExecutionMode,
  parseCleanupPolicyPreset,
  DEFAULT_AUTH_DOMAIN_HINTS,
  DEFAULT_PLAYWRIGHT_SERVICE_URL_MAP,
  looksLikeExplicitNewConversation,
  looksLikeBrowserWorkflowStatusMessage,
  looksLikeBrowserAutomationIntent,
} from './intent-detection.ts';

// ---------------------------------------------------------------------------
// inferBrowserContinuationSignal (source lines 723-867)
// ---------------------------------------------------------------------------

export function inferBrowserContinuationSignal(params: {
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

// ---------------------------------------------------------------------------
// normalizeDetectedUrlCandidate, parseServiceUrlMapFromEnv,
// inferPlaywrightUrlFromMessage, inferPlaywrightDesiredActionFromMessage,
// normalizeCrudAction (source lines 1244-1386)
// ---------------------------------------------------------------------------

export function normalizeDetectedUrlCandidate(value: string): string | null {
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

export function parseServiceUrlMapFromEnv(): Array<{ keyword: string; url: string }> {
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

export function inferPlaywrightUrlFromMessage(message: string): string | null {
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

export function inferPlaywrightDesiredActionFromMessage(message: string, fallbackAction: string): string {
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

// ---------------------------------------------------------------------------
// BROWSER_WORKFLOW_STATE_VALUES, browserWorkflowMachine, and related
// functions (source lines 1388-1598)
// ---------------------------------------------------------------------------

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

export const browserWorkflowMachine = createMachine({
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

export function eventForBrowserWorkflowState(state: BrowserWorkflowState): BrowserWorkflowEventType {
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

export function transitionBrowserWorkflowState(
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

export function resolveBrowserWorkflowStateTimeoutMs(state: BrowserWorkflowState): number {
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

export function browserWorkflowRecoveryAction(state: BrowserWorkflowState): string {
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

export function parseTimestampMs(value: unknown): number | null {
  const raw = asOptionalString(value);
  if (!raw) {
    return null;
  }
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

export function isBrowserWorkflowStateStale(state: BrowserWorkflowState, updatedAt: string | null): boolean {
  if (!isActiveBrowserWorkflowState(state)) {
    return false;
  }
  const updatedMs = parseTimestampMs(updatedAt);
  if (!updatedMs) {
    return false;
  }
  return Date.now() - updatedMs > resolveBrowserWorkflowStateTimeoutMs(state);
}

export function isActiveBrowserWorkflowState(value: BrowserWorkflowState): boolean {
  return value !== 'idle';
}

export function describeBrowserWorkflowStatus(params: {
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

// ---------------------------------------------------------------------------
// parseDomainListFromEnv, extractHostFromUrl, domainMatchesAllowlist,
// isLikelyAuthenticatedBrowserTask (source lines 1898-1987)
// ---------------------------------------------------------------------------

export function parseDomainListFromEnv(key: string, fallback: string[]): string[] {
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

export function extractHostFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function domainMatchesAllowlist(host: string, allowlist: string[]): boolean {
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

export function isLikelyAuthenticatedBrowserTask(message: string, url: string | null): boolean {
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

// ---------------------------------------------------------------------------
// mapBrowserModeHintToWorkflowState, resolveBrowserWorkflowEvent,
// buildPlaywrightCallFromMessage (source lines 1988-2294)
// ---------------------------------------------------------------------------

export function mapBrowserModeHintToWorkflowState(params: {
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

export function resolveBrowserWorkflowEvent(params: {
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

export function buildPlaywrightCallFromMessage(
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
