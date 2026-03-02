/**
 * Entry-point helper functions extracted from the playwright-read agent plugin.
 *
 * Contains planner prompt/parse helpers, workflow telemetry builders,
 * discovery notification builders, and timeout/lifecycle resolution utilities.
 */

import {
	asOptionalString,
	normalizeAction,
	parseActionSteps,
	parseApiAttempts,
	parseJsonOutput,
	runChatLlm,
	toBool,
	toInt
} from '../common.ts';
import {
	mapPluginModeToWorkflowTelemetry,
	type SiteProfile,
	type WorkflowTelemetry
} from '../runtime-utils.ts';
import type { PlannerResult, ProbeState } from './types.ts';
import { WORKFLOW_TIMEOUT_POLICY_MS, plannerPayloadSchema } from './types.ts';
import {
	buildNotifyAction,
	buildReadyCheckpointPrompt,
	extractNetworkSummary,
	extractProbeLabels,
	notificationText,
	summarizeNetworkCandidate
} from './page-analysis.ts';
import { resolveSkillHints } from './probe-workflow.ts';

/* ------------------------------------------------------------------ */
/*  Helper functions                                                    */
/* ------------------------------------------------------------------ */

export function formatSecondsFromMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(ms / 1000));
}

export function buildBrowserLifecycleLine(params: {
  discovery: Record<string, unknown>;
  keepOpenAfterDiscoveryMs: number;
  awaitUserCheckpointRequested: boolean;
  useUserContext: boolean;
  headless: boolean;
  nonBlockingKeepOpen: boolean;
}): string | null {
  const {
    discovery,
    keepOpenAfterDiscoveryMs,
    awaitUserCheckpointRequested,
    useUserContext,
    headless,
    nonBlockingKeepOpen
  } = params;

  const checkpoint =
    discovery.user_checkpoint && typeof discovery.user_checkpoint === 'object' && !Array.isArray(discovery.user_checkpoint)
      ? (discovery.user_checkpoint as Record<string, unknown>)
      : null;
  const checkpointReason = asOptionalString(checkpoint?.reason);
  const checkpointAwaited = checkpoint ? toBool(checkpoint.awaited, false) : false;
  const checkpointSatisfied = checkpoint ? toBool(checkpoint.satisfied, false) : false;

  if (checkpointReason === 'page_closed') {
    return 'Browser status: automation window was closed before the checkpoint/discovery flow finished.';
  }

  if (headless || !useUserContext) {
    return null;
  }

  if (!(awaitUserCheckpointRequested || checkpointAwaited)) {
    return 'Browser status: automation ran in a managed browser session for this step.';
  }

  if (!checkpointSatisfied) {
    return 'Browser status: checkpoint is still incomplete. Keep the automation window open and click READY in the injected panel (or reply "READY") after sign-in.';
  }

  if (keepOpenAfterDiscoveryMs > 0) {
    const seconds = formatSecondsFromMs(keepOpenAfterDiscoveryMs);
    if (nonBlockingKeepOpen) {
      return `Browser status: checkpoint completed, discovery captured. The automation window stays open for ~${seconds}s, then auto-closes.`;
    }
    return `Browser status: checkpoint completed, discovery captured, window stayed open ~${seconds}s, then auto-closed.`;
  }

  return 'Browser status: checkpoint completed, discovery captured, then window auto-closed.';
}

export function buildChatResponseFromDiscovery(
  discovery: Record<string, unknown>,
  url: string | null,
  options?: {
    keepOpenAfterDiscoveryMs?: number;
    awaitUserCheckpointRequested?: boolean;
    useUserContext?: boolean;
    headless?: boolean;
    nonBlockingKeepOpen?: boolean;
  }
): string {
  const title = asOptionalString(discovery.title) || '(untitled)';
  const currentUrl = asOptionalString(discovery.url) || url || 'about:blank';
  const challenge = asOptionalString((discovery.challenge as Record<string, unknown> | undefined)?.summary);
  const interactiveCount = Number((discovery.interactive as Record<string, unknown> | undefined)?.total || 0);
  const networkSummary = extractNetworkSummary(discovery);
  const apiLikeCount = Number(networkSummary.api_like_events || 0);
  const candidates = Array.isArray(networkSummary.candidates) ? networkSummary.candidates : [];
  const labelCount = extractProbeLabels(discovery).length;
  const topCandidate = candidates.length > 0 && typeof candidates[0] === 'object' && candidates[0] !== null
    ? summarizeNetworkCandidate(candidates[0] as Record<string, unknown>)
    : null;
  const base = challenge
    ? `Discovery complete for ${currentUrl} (${title}). Bot protection detected: ${challenge}`
    : `Discovery complete for ${currentUrl} (${title}). Found ${Number.isFinite(interactiveCount) ? interactiveCount : 0} interactive elements.`;
  const networkLine = Number.isFinite(apiLikeCount) ? ` API-like events: ${apiLikeCount}.` : '';
  const labelLine = labelCount > 0 ? ` Saved labels: ${labelCount}.` : '';
  const candidateLine = topCandidate ? ` Top candidate: ${topCandidate}.` : '';
  const lifecycleLine = buildBrowserLifecycleLine({
    discovery,
    keepOpenAfterDiscoveryMs: toInt(options?.keepOpenAfterDiscoveryMs, 0, 0, 300000),
    awaitUserCheckpointRequested: toBool(options?.awaitUserCheckpointRequested, false),
    useUserContext: toBool(options?.useUserContext, false),
    headless: toBool(options?.headless, false),
    nonBlockingKeepOpen: toBool(options?.nonBlockingKeepOpen, false)
  });
  return `${base}${networkLine}${labelLine}${candidateLine}${lifecycleLine ? ` ${lifecycleLine}` : ''}`.trim();
}

export function timeoutPolicyLabel(state: string): string {
  const ms = WORKFLOW_TIMEOUT_POLICY_MS[state];
  if (!Number.isFinite(ms) || ms <= 0) {
    return 'n/a';
  }
  const minutes = Math.round(ms / 60000);
  return `${minutes}m`;
}

export function buildWorkflowTelemetry(params: {
  mode: string;
  discovery?: Record<string, unknown> | null;
  needsUserStep?: string | null;
  lastError?: string | null;
}): WorkflowTelemetry {
  const challengeDetected = params.discovery
    ? toBool(
        ((params.discovery.challenge as Record<string, unknown> | undefined)?.detected),
        false
      )
    : false;
  return mapPluginModeToWorkflowTelemetry({
    mode: params.mode,
    challengeDetected,
    needsUserStep: params.needsUserStep || null,
    lastError: params.lastError || null
  });
}

export function buildWorkflowTelemetryBlock(telemetry: WorkflowTelemetry): Record<string, unknown> {
  return {
    type: 'playwright_workflow_telemetry',
    title: 'Workflow Telemetry',
    subtitle: 'Current state and recovery policy',
    items: [
      {
        name: `State: ${telemetry.state}`,
        kind: 'entry',
        relative_path: `Pending: ${telemetry.pending_step || 'none'}`
      },
      {
        name: `Last transition: ${telemetry.last_transition}`,
        kind: 'entry',
        relative_path: telemetry.last_error ? `Last error: ${telemetry.last_error}` : 'Last error: none'
      },
      {
        name: `Timeout policy: ${timeoutPolicyLabel(telemetry.state)}`,
        kind: 'entry',
        relative_path:
          telemetry.state === 'challenge_detected'
            ? 'Recovery: complete challenge in browser and click READY.'
            : telemetry.state === 'human_required'
              ? 'Recovery: complete required browser step then click READY.'
              : telemetry.state === 'needs_policy'
                ? 'Recovery: provide policy or pick 1/2/3.'
                : telemetry.state === 'needs_pilot_approval'
                  ? 'Recovery: approve PILOT ARCHIVE 1 or PILOT DELETE 1.'
                  : telemetry.state === 'needs_ready'
                    ? 'Recovery: open target workflow page and click READY.'
                    : 'Recovery: ask browser status or continue workflow.'
      }
    ],
    total_count: 3
  };
}

export function workflowPatchFromTelemetry(
  telemetry: WorkflowTelemetry,
  host: string | null
): Partial<ProbeState> {
  return {
    workflow_state: telemetry.state,
    workflow_pending_step: telemetry.pending_step,
    workflow_last_transition: telemetry.last_transition,
    workflow_last_error: telemetry.last_error,
    site_profile_host: host
  };
}

export function withWorkflowTelemetryBlocks(
  blocks: Record<string, unknown>[],
  telemetry: WorkflowTelemetry
): Record<string, unknown>[] {
  const out = blocks.slice(0, 10);
  out.push(buildWorkflowTelemetryBlock(telemetry));
  return out;
}

export function buildDiscoveryNotification(params: {
  discovery: Record<string, unknown>;
  fallbackUrl: string | null;
  lifecycleText: string;
}): Record<string, unknown> {
  const url = asOptionalString(params.discovery.url) || params.fallbackUrl || 'the target site';
  const interactive =
    params.discovery.interactive && typeof params.discovery.interactive === 'object' && !Array.isArray(params.discovery.interactive)
      ? (params.discovery.interactive as Record<string, unknown>)
      : {};
  const totalInteractive = Number(interactive.total || 0);
  const networkSummary = extractNetworkSummary(params.discovery);
  const apiLike = Number(networkSummary.api_like_events || 0);
  const body = notificationText(
    `Map ready for ${url}: ${Number.isFinite(totalInteractive) ? totalInteractive : 0} interactive elements, ${Number.isFinite(apiLike) ? apiLike : 0} API-like events. ${params.lifecycleText}`,
    220
  );
  return {
    title: 'Pinokio: Browser Map Ready',
    body,
    tag: 'pinokio-playwright-map-ready',
    url: '/ui/chat',
    prompt: 'SHOW CANDIDATES',
    actions: [
      buildNotifyAction('show_candidates', 'Show candidates', 'SHOW CANDIDATES', '/ui/chat?run_prompt=SHOW%20CANDIDATES&auto_run=1'),
      buildNotifyAction('enable_label_mode', 'Enable label mode', `Enable label mode on ${url} and let me tag fields`, '/ui/chat')
    ]
  };
}

export function buildPlannerPrompt(params: {
  userTask: string;
  desiredAction: string;
  url: string | null;
  discovery: Record<string, unknown>;
  skillHints: string[];
  siteProfile?: SiteProfile | null;
}): string {
  const { userTask, desiredAction, url, discovery, skillHints, siteProfile } = params;
  const discoveryText = JSON.stringify(discovery).slice(0, 12000);
  const networkSummary = extractNetworkSummary(discovery);
  const networkCandidates = Array.isArray(networkSummary.candidates)
    ? networkSummary.candidates
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 24) as Array<Record<string, unknown>>
    : [];
  const networkCandidateLines =
    networkCandidates.length > 0
      ? networkCandidates.map((candidate) => `- ${summarizeNetworkCandidate(candidate)}`).join('\n')
      : '- none';
  const probeLabels = extractProbeLabels(discovery).slice(0, 40);
  const probeLabelLines =
    probeLabels.length > 0
      ? probeLabels
          .map((item) => {
            const label = asOptionalString(item.label) || 'label';
            const selectorHint = asOptionalString(item.selector_hint) || asOptionalString(item.tag) || 'unknown';
            return `- ${label}: ${selectorHint}`;
          })
          .join('\n')
      : '- none';
  const siteLabelLines =
    siteProfile && Array.isArray(siteProfile.labels) && siteProfile.labels.length > 0
      ? siteProfile.labels
          .slice(0, 24)
          .map((item) => `- ${item.label}: ${item.selector_hint}`)
          .join('\n')
      : '- none';
  const siteCandidateLines =
    siteProfile && Array.isArray(siteProfile.network_candidates) && siteProfile.network_candidates.length > 0
      ? siteProfile.network_candidates
          .slice(0, 18)
          .map((item) => `- ${item.methods.join('|') || 'ANY'} ${item.origin}${item.path_template} (count=${item.count})`)
          .join('\n')
      : '- none';
  return [
    'You are the Playwright READ planner for Pinokio.',
    'Your output must be strict JSON only.',
    'Goal: plan safe browser automation where READ agent discovers and WRITE agent executes.',
    'Prioritize network/API attempts first when feasible, then UI automation actions.',
    'If bot protection/challenge appears, ask user for required interaction and recommend non-headless + user context.',
    'Schema:',
    '{"mode":"run_actions|needs_user_step","question":"...", "notes":"...", "api_attempts":[{"url":"...","method":"GET|POST","headers":{},"body":...}], "actions":[{"type":"goto|click|fill|press|wait_for_selector|extract_text|api_request","...": "..."}]}',
    'Rules:',
    '- Keep actions concise and deterministic.',
    '- Never execute actions here. Only plan.',
    '- For create/update/delete browser tasks, use mode=run_actions when enough info exists.',
    '- If user credentials/2FA/manual checkpoint needed, use mode=needs_user_step with exact user instruction.',
    '- For authenticated sites, tell user to reply "READY" so automation opens its own browser context; do not tell user to use a separate normal browser profile.',
    '- For cleanup/organization tasks on messages/inbox/mailbox, ask clarifying policy questions before destructive actions (what is junk, delete vs archive, scope/time window, protected senders/folders).',
    '- For cleanup tasks with policy confirmed, request 2-3 manual examples (junk, keep, delete/archive) and wait for READY before bulk mutations.',
    '- When uncertain selectors exist, include wait_for_selector + extract_text validation step before mutation step.',
    '- Use probe labels when available. Map user intent to label names first, then selector_hint.',
    '- Always include `label_key` for click/fill/wait steps when possible.',
    '- Selector fallback stack order: label_key -> role/text -> attribute selectors.',
    '- For API attempts without explicit URL, include `path_template` or `candidate_key` to resolve via site profile.',
    '- Avoid fragile selectors like nth-child or positional card indices.',
    '- If network candidates exist, generate api_attempts before UI actions whenever possible.',
    '- Honor pilot-first safety for delete/cleanup intents: prepare one pilot action path before bulk writes.',
    `Desired action: ${desiredAction}`,
    `Target URL: ${url || 'unknown'}`,
    `Probe labels:\n${probeLabelLines}`,
    `Site profile labels:\n${siteLabelLines}`,
    `Site profile API candidates:\n${siteCandidateLines}`,
    `Network candidates:\n${networkCandidateLines}`,
    skillHints.length > 0 ? `Skill hints:\n${skillHints.map((item) => `- ${item}`).join('\n')}` : '',
    `User task:\n${userTask}`,
    `Discovery snapshot:\n${discoveryText}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parsePlannerResult(raw: string): PlannerResult {
  const parsed = parseJsonOutput(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { actions: [], apiAttempts: [], needsUserStep: null, notes: null };
  }
  const validated = plannerPayloadSchema.safeParse(parsed);
  if (!validated.success) {
    return { actions: [], apiAttempts: [], needsUserStep: null, notes: null };
  }
  const row = validated.data as Record<string, unknown>;
  const mode = normalizeAction(row.mode || 'run_actions');
  const actions = parseActionSteps(row.actions);
  const apiAttempts = parseApiAttempts(row.api_attempts);
  const notes = asOptionalString(row.notes);
  const needsUserStep = mode === 'needs_user_step'
    ? asOptionalString(row.question) || 'Manual browser interaction is needed before automation can continue.'
    : null;
  return { actions, apiAttempts, needsUserStep, notes };
}

export function resolvePlannerTimeoutMs(targetMeta: Record<string, unknown>): number {
  const envDefault = toInt(
    process.env.PINOKIO_PLAYWRIGHT_PLAN_TIMEOUT_MS,
    15000,
    5000,
    120000
  );
  return toInt(targetMeta.plan_timeout_ms, envDefault, 5000, 120000);
}

export function resolveKeepOpenAfterDiscoveryMs(params: {
  targetMeta: Record<string, unknown>;
  awaitUserCheckpointRequested: boolean;
  useUserContext: boolean;
  headless: boolean;
}): number {
  const explicit = params.targetMeta.keep_open_after_discovery_ms;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return toInt(explicit, 0, 0, 300000);
  }
  if (!params.awaitUserCheckpointRequested || !params.useUserContext || params.headless) {
    return 0;
  }
  return toInt(
    process.env.PINOKIO_PLAYWRIGHT_KEEP_OPEN_AFTER_DISCOVERY_MS,
    120000,
    0,
    300000
  );
}

export function fallbackPlannerResult(params: {
  desiredAction: string;
  url: string | null;
  inferredAuthenticatedTask: boolean;
  authenticatedReady?: boolean;
}): PlannerResult {
  const { desiredAction, url, inferredAuthenticatedTask, authenticatedReady } = params;
  if (inferredAuthenticatedTask) {
    if (toBool(authenticatedReady, false)) {
      return {
        actions: parseActionSteps([
          { type: 'wait_for_selector', selector: 'body', timeout_ms: 8000 },
          { type: 'extract_text', selector: 'main' }
        ]),
        apiAttempts: [],
        notes:
          'Checkpoint is already satisfied. Running a read-only probe inventory first, then we can apply one pilot change.',
        needsUserStep: null
      };
    }
    return {
      actions: [],
      apiAttempts: [],
      notes:
        'Prepared a staged browser plan using timeout-safe fallback. We will inventory rules/folders first, then apply one pilot rule before any bulk changes.',
      needsUserStep: buildReadyCheckpointPrompt(url)
    };
  }
  return {
    actions: [],
    apiAttempts: [],
    notes:
      `Prepared a timeout-safe plan for ${url || 'the target site'}. Next step is discovery/read-only validation, then controlled actions.`,
    needsUserStep: null
  };
}
