/**
 * Dispatch handler functions extracted from the playwright-read agent plugin.
 *
 * Each handler takes a context object and returns `true` if it handled the
 * request (caller should exit), `false` if the caller should continue to the
 * next handler.
 */

import { respond } from '../../../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../../../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  extractUrlHost,
  runChatLlm,
  toBool
} from '../common.ts';
import type { PlaywrightExecutionPolicy } from '../common.ts';
import {
  type SiteProfile,
  type WorkflowTelemetry
} from '../runtime-utils.ts';
import type {
  PlannerResult,
  ProbeState,
  ProbeWalkthroughPlan
} from './types.ts';
import {
  resolveSkillHints,
  buildCleanupClarificationMessage,
  buildProbeFollowupMessage,
  persistProbeState,
  inferSkillNameFromTask,
  buildProbeSkillMarkdown,
  writeProbeSkillFile,
  runSkillRegistration
} from './probe-workflow.ts';
import {
  extractNetworkSummary,
  extractProbeLabels,
  extractDiscoveryNetworkCandidates,
  mapSiteProfileLabelsToProbeLabels,
  mapSiteProfileNetworkCandidatesToDiscovery,
  dedupeProbeLabels,
  dedupeNetworkCandidates,
  buildUiBlocks,
  buildSuggestedPrompts,
  buildNotifyPayload,
  shouldSendUserNotification,
  notifyUser,
  buildReadyCheckpointPrompt
} from './page-analysis.ts';

/* ------------------------------------------------------------------ */
/*  Shared helpers imported from helpers.ts (previously duplicated)     */
/* ------------------------------------------------------------------ */

import {
  buildPlannerPrompt,
  workflowPatchFromTelemetry,
  withWorkflowTelemetryBlocks,
  parsePlannerResult,
  fallbackPlannerResult
} from './helpers.ts';

/* ------------------------------------------------------------------ */
/*  Context interfaces                                                 */
/* ------------------------------------------------------------------ */

export interface DispatchContext {
  request: PluginRequest;
  action: string;
  targetMeta: Record<string, unknown>;
  userTask: string;
  effectiveUserTask: string;
  desiredAction: string;
  mutate: boolean;
  url: string | null;
  timeoutMs: number;
  channel: string;
  responseFormat: string;
  useStealth: boolean;
  targetHost: string | null;
  siteProfile: SiteProfile | null;
  probeState: ProbeState | null;
  policy: PlaywrightExecutionPolicy;
  useUserContext: boolean;
  headless: boolean;
  captureScreenshot: boolean;
  autoInstallChromium: boolean;
  autoInstallDeps: boolean;
  installCommand: string | null;
  installDepsCommand: string | null;
  userDataDir: string | null;
  planOnly: boolean;
  plannerTimeoutMs: number;
  requestedProfile: string;
  probeMode: boolean;
  probeOverlayEnabled: boolean;
  probeOverlayAutoActivate: boolean;
  probeOverlayReset: boolean;
  probeConvertToSkill: boolean;
  probeAutoRegisterSkill: boolean;
  requestedProbeSkillName: string;
  awaitUserCheckpointRequested: boolean;
  keepOpenAfterDiscoveryMs: number;
  nonBlockingKeepOpen: boolean;
  serviceTimeoutMs: number;
  checkpointReady: boolean;
  cleanupIntentEarly: boolean;
  cleanupPolicyProvidedEarly: boolean;
  cleanupExecutionApprovedEarly: boolean;
  probeTrainingModeRequested: boolean;
  activeWalkthroughPlan: ProbeWalkthroughPlan | null;
  priorNeedsUserStepRaw: string | null;
  cleanupTrainingPending: boolean;
  readyFollowup: boolean;
  telemetryFor: (params: {
    mode: string;
    discovery?: Record<string, unknown> | null;
    needsUserStep?: string | null;
    lastError?: string | null;
  }) => WorkflowTelemetry;
}

export interface PostDiscoveryContext extends DispatchContext {
  discovery: Record<string, unknown>;
  chatResponse: string;
  discoveryLabels: Array<Record<string, unknown>>;
  discoveryCandidates: Array<Record<string, unknown>>;
  uiBlocks: Record<string, unknown>[];
  discoveryTelemetry: WorkflowTelemetry;
  suggestedPrompts: Array<Record<string, unknown>>;
  checkpointSatisfied: boolean;
  checkpointAwaited: boolean;
  checkpointReason: string | null;
  checkpointWaitedMs: number;
  authenticatedDiscovery: boolean;
}

/* ------------------------------------------------------------------ */
/*  Shared utility used by multiple handlers                           */
/* ------------------------------------------------------------------ */

export function policyBlock(ctx: DispatchContext): Record<string, unknown> {
  return {
    use_user_context: ctx.useUserContext,
    inferred_authenticated_task: ctx.policy.inferredAuthenticatedTask,
    container_fallback_non_auth: ctx.policy.containerFallbackNonAuth,
    allowlisted_domain: ctx.policy.allowlistedDomain,
    permission_granted: ctx.policy.permissionGranted,
    reason: ctx.policy.reason
  };
}

/* ------------------------------------------------------------------ */
/*  Pre-discovery handlers                                             */
/* ------------------------------------------------------------------ */

/**
 * Handles showNetworkCandidatesRequested || useSavedLabelsRequested.
 * Lines 686-773 of index.ts.
 */
export function handleShowNetworkCandidates(ctx: DispatchContext): boolean {
  const showNetworkCandidatesRequested = toBool(ctx.targetMeta.show_network_candidates, false);
  const useSavedLabelsRequested = toBool(ctx.targetMeta.use_saved_labels, false);
  if (!(showNetworkCandidatesRequested || useSavedLabelsRequested)) {
    return false;
  }

  const cachedDiscovery =
    ctx.probeState?.discovery && typeof ctx.probeState.discovery === 'object' && !Array.isArray(ctx.probeState.discovery)
      ? (ctx.probeState.discovery as Record<string, unknown>)
      : {};
  const cachedUrl =
    asOptionalString(cachedDiscovery.url) ||
    ctx.url ||
    asOptionalString(ctx.probeState?.url) ||
    null;
  const mergedLabels = dedupeProbeLabels([
    ...extractProbeLabels(cachedDiscovery),
    ...mapSiteProfileLabelsToProbeLabels(ctx.siteProfile, cachedUrl)
  ]);
  const mergedCandidates = dedupeNetworkCandidates([
    ...extractDiscoveryNetworkCandidates(cachedDiscovery),
    ...mapSiteProfileNetworkCandidatesToDiscovery(ctx.siteProfile)
  ]);
  const existingNetworkSummary = extractNetworkSummary(cachedDiscovery);
  const cachedApiLikeEvents = Number(existingNetworkSummary.api_like_events || 0);
  const syntheticDiscovery: Record<string, unknown> = {
    ...cachedDiscovery,
    url: cachedUrl,
    title: asOptionalString(cachedDiscovery.title) || 'Cached Discovery',
    probe_labels: mergedLabels,
    network_summary: {
      ...existingNetworkSummary,
      api_like_events: Math.max(cachedApiLikeEvents, mergedCandidates.length),
      candidates: mergedCandidates
    }
  };
  const needsReadyStep =
    mergedLabels.length === 0 && mergedCandidates.length === 0
      ? 'No saved candidates yet for this site. Open the exact workflow page, complete login if needed, then reply "READY".'
      : null;
  const telemetry = ctx.telemetryFor({
    mode: needsReadyStep ? 'discovery_needs_user' : 'discover',
    discovery: syntheticDiscovery,
    needsUserStep: needsReadyStep
  });
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: cachedUrl,
      discovery: syntheticDiscovery,
      needs_user_step: needsReadyStep,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  const uiBlocksBase =
    ctx.responseFormat === 'ui_blocks' || ctx.channel.includes('ui')
      ? buildUiBlocks(syntheticDiscovery, ctx.desiredAction)
      : [];
  const uiBlocks = withWorkflowTelemetryBlocks(uiBlocksBase, telemetry);
  const suggestedPrompts = buildSuggestedPrompts({
    url: cachedUrl,
    discovery: syntheticDiscovery
  });
  const chatResponse = needsReadyStep
    ? needsReadyStep
    : showNetworkCandidatesRequested
      ? `Loaded saved map${ctx.targetHost ? ` for ${ctx.targetHost}` : ''}: ${mergedCandidates.length} API candidate(s), ${mergedLabels.length} label(s).`
      : `Using saved labels${ctx.targetHost ? ` for ${ctx.targetHost}` : ''}. Ready to continue with ${mergedLabels.length} label(s) and ${mergedCandidates.length} API candidate(s).`;
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: needsReadyStep ? 'discovery_needs_user' : 'discover',
    desired_action: ctx.desiredAction,
    url: cachedUrl,
    chat_response: chatResponse,
    discovery: syntheticDiscovery,
    suggested_prompts: suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: uiBlocks
  });
  process.exit(0);
}

/**
 * Handles early cleanup policy clarification.
 * Lines 775-833 of index.ts.
 */
export function handleEarlyCleanupPolicy(ctx: DispatchContext): boolean {
  if (
    ctx.planOnly ||
    !ctx.mutate ||
    !ctx.cleanupIntentEarly ||
    ctx.cleanupPolicyProvidedEarly ||
    ctx.awaitUserCheckpointRequested ||
    ctx.checkpointReady
  ) {
    return false;
  }

  const clarification = buildCleanupClarificationMessage(ctx.url);
  const suggestedPrompts = buildSuggestedPrompts({
    url: ctx.url || null,
    discovery: ctx.probeState?.discovery || null
  });
  const telemetry = ctx.telemetryFor({
    mode: 'discovery_needs_user',
    discovery: ctx.probeState?.discovery || null,
    needsUserStep: clarification
  });
  if (shouldSendUserNotification(ctx.targetMeta)) {
    notifyUser('Pinokio: Cleanup Policy Needed', clarification);
  }
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      checkpoint_satisfied: false,
      checkpoint_awaited: false,
      checkpoint_reason: 'needs_policy',
      checkpoint_waited_ms: 0,
      needs_user_step: clarification,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'discovery_needs_user',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: clarification,
    notify: buildNotifyPayload('Pinokio: Cleanup Policy Needed', clarification, {
      url: ctx.url || null,
      suggestedPrompts
    }),
    suggested_prompts: suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
  });
  process.exit(0);
}

/**
 * Handles probe-to-skill conversion.
 * Lines 835-899 of index.ts.
 */
export function handleProbeSkillConvert(ctx: DispatchContext): boolean {
  if (!ctx.probeConvertToSkill) {
    return false;
  }

  const telemetry = ctx.telemetryFor({
    mode: 'probe_skill_created',
    discovery: ctx.probeState?.discovery || null,
    needsUserStep: null
  });
  if (!ctx.probeState || !ctx.probeState.discovery) {
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'probe_skill_missing',
      desired_action: ctx.desiredAction,
      url: ctx.url || ctx.probeState?.url || null,
      chat_response:
        'No browser probe session is available in this chat yet. Run a browser discovery task first, then ask me to convert it to a skill.',
      workflow_telemetry: telemetry,
      ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
    });
    process.exit(0);
  }
  const inferredName = inferSkillNameFromTask(
    ctx.probeState.url || ctx.url || null,
    ctx.probeState.task_summary || ctx.effectiveUserTask
  );
  const skillName = ctx.requestedProbeSkillName || inferredName;
  const skillDescription =
    asOptionalString(ctx.targetMeta.probe_skill_description) ||
    `Generated Playwright probe skill for ${extractUrlHost(ctx.probeState.url || ctx.url || '') || 'browser workflow'}.`;
  const markdown = buildProbeSkillMarkdown({
    skillName,
    description: skillDescription,
    url: ctx.url || ctx.probeState.url || null,
    state: ctx.probeState
  });
  const skillPath = writeProbeSkillFile(skillName, markdown);
  const registration = ctx.probeAutoRegisterSkill
    ? runSkillRegistration({
        name: skillName,
        description: skillDescription,
        skillPath
      })
    : null;
  const installHint = registration
    ? registration.ok
      ? 'Skill was also registered in config.'
      : `Auto-register failed. Run manually: ${registration.command}`
    : 'Auto-register is disabled for this request.';
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'probe_skill_created',
    desired_action: ctx.desiredAction,
    url: ctx.url || ctx.probeState.url || null,
    chat_response: `Created probe skill '${skillName}' at ${skillPath}. ${installHint}`,
    workflow_telemetry: telemetry,
    probe_skill: {
      name: skillName,
      description: skillDescription,
      path: skillPath,
      registration
    },
    ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
  });
  process.exit(0);
}

/**
 * Handles auth checkpoint (needs READY from user).
 * Lines 901-961 of index.ts.
 */
export function handleAuthCheckpoint(ctx: DispatchContext): boolean {
  if (
    ctx.planOnly ||
    !ctx.mutate ||
    !ctx.policy.inferredAuthenticatedTask ||
    ctx.awaitUserCheckpointRequested ||
    ctx.checkpointReady
  ) {
    return false;
  }

  const readyPrompt = buildReadyCheckpointPrompt(ctx.url);
  const suggestedPrompts = buildSuggestedPrompts({
    url: ctx.url || null,
    discovery: ctx.probeState?.discovery || null
  });
  const chatResponse = ctx.probeMode
    ? `${readyPrompt} ${buildProbeFollowupMessage(ctx.url)}`
    : readyPrompt;
  const telemetry = ctx.telemetryFor({
    mode: 'human_required',
    discovery: ctx.probeState?.discovery || null,
    needsUserStep: readyPrompt
  });
  if (shouldSendUserNotification(ctx.targetMeta)) {
    notifyUser('Pinokio: Browser Checkpoint Needed', readyPrompt);
  }
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      checkpoint_satisfied: false,
      checkpoint_awaited: false,
      checkpoint_reason: 'needs_ready',
      checkpoint_waited_ms: 0,
      needs_user_step: readyPrompt,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'discovery_needs_user',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: chatResponse.trim(),
    notify: buildNotifyPayload('Pinokio: Browser Checkpoint Needed', readyPrompt, {
      url: ctx.url || null,
      suggestedPrompts
    }),
    suggested_prompts: suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
  });
  process.exit(0);
}

/**
 * Handles plan-only mode (no live browser discovery).
 * Lines 963-1076 of index.ts.
 */
export function handlePlanOnly(ctx: DispatchContext): boolean {
  if (!ctx.planOnly) {
    return false;
  }

  const plannerPrompt = buildPlannerPrompt({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    url: ctx.url,
    discovery: {
      mode: 'plan_only',
      note: 'No live browser discovery requested.'
    },
    skillHints: resolveSkillHints(ctx.targetMeta),
    siteProfile: ctx.siteProfile
  });
  let planner: PlannerResult;
  try {
    const llm = runChatLlm({
      profile: ctx.requestedProfile,
      prompt: plannerPrompt,
      timeoutMs: ctx.plannerTimeoutMs
    });
    planner = parsePlannerResult(llm.text);
  } catch {
    planner = fallbackPlannerResult({
      desiredAction: ctx.desiredAction,
      url: ctx.url,
      inferredAuthenticatedTask: ctx.policy.inferredAuthenticatedTask
    });
  }
  if (ctx.probeMode) {
    const telemetry = ctx.telemetryFor({
      mode: planner.needsUserStep ? 'discovery_needs_user' : 'plan_only',
      discovery: null,
      needsUserStep: planner.needsUserStep
    });
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      planner_actions: planner.actions,
      planner_api_attempts: planner.apiAttempts,
      planner_notes: planner.notes,
      needs_user_step: planner.needsUserStep,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'plan_only',
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      chat_response:
        planner.needsUserStep ||
        planner.notes ||
        `Prepared a Playwright plan for ${ctx.url || 'the target site'} without launching a browser.`,
      policy: policyBlock(ctx),
      planner: {
        actions: planner.actions,
        api_attempts: planner.apiAttempts,
        needs_user_step: planner.needsUserStep,
        notes: planner.notes
      },
      suggested_prompts: buildSuggestedPrompts({
        url: ctx.url || null,
        discovery: null
      }),
      workflow_telemetry: telemetry,
      ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
    });
    process.exit(0);
  }
  const telemetry = ctx.telemetryFor({
    mode: planner.needsUserStep ? 'discovery_needs_user' : 'plan_only',
    discovery: null,
    needsUserStep: planner.needsUserStep
  });
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'plan_only',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response:
      planner.needsUserStep ||
      planner.notes ||
      `Prepared a Playwright plan for ${ctx.url || 'the target site'} without launching a browser.`,
    policy: policyBlock(ctx),
    planner: {
      actions: planner.actions,
      api_attempts: planner.apiAttempts,
      needs_user_step: planner.needsUserStep,
      notes: planner.notes
    },
    suggested_prompts: buildSuggestedPrompts({
      url: ctx.url || null,
      discovery: null
    }),
    workflow_telemetry: telemetry,
    ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
  });
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Post-discovery handlers (re-exported for backward compatibility)   */
/* ------------------------------------------------------------------ */

export {
  handleAuthBlocked,
  handlePostDiscoveryCleanupPolicy,
  handleCleanupTraining,
  handleCleanupPreview,
  handleCleanupApproval,
  handleWalkthrough,
  handleDiscoveryOnly,
  handleWritePlanning
} from './dispatch-post-discovery.ts';
