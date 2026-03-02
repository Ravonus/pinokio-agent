import { asOptionalString } from '../../plugin-utils.ts';
import type {
  BrowserWorkflowState,
  BrowserWorkflowEventType,
  BrowserContinuationSignal,
} from './types.ts';
import {
  normalizeBrowserWorkflowState,
} from './shared-actions.ts';
import {
  DEFAULT_AUTH_DOMAIN_HINTS,
} from './shared-url-utils.ts';
import {
  looksLikeExplicitNewConversation,
  isBrowserFollowupAckMessage,
  messageHasCleanupPolicyDetails,
  messageHasCleanupExecutionApproval,
  messageRequestsNetworkCandidatePreview,
  messageRequestsProbeLabelMode,
  messageRequestsProbeLabelReset,
  parseCleanupPolicyPreset,
  looksLikeBrowserWorkflowCancelMessage,
  looksLikeBrowserWorkflowResumeMessage,
  looksLikeBrowserWorkflowStatusMessage,
} from './intent-detection.ts';

// Import eventForBrowserWorkflowState from browser-workflow to avoid circular dep;
// it stays in browser-workflow because it is tightly coupled with the state machine.
import { eventForBrowserWorkflowState } from './browser-workflow.ts';

// ---------------------------------------------------------------------------
// inferBrowserContinuationSignal
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
// parseDomainListFromEnv, extractHostFromUrl, domainMatchesAllowlist,
// isLikelyAuthenticatedBrowserTask
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
// mapBrowserModeHintToWorkflowState, resolveBrowserWorkflowEvent
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
