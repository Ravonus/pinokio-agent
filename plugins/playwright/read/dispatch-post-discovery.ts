/**
 * Post-discovery dispatch handlers extracted from dispatch.ts.
 *
 * Each handler takes a PostDiscoveryContext and returns `true` if it handled
 * the request (caller should exit), `false` if the caller should continue
 * to the next handler.
 */

import { respond } from '../../../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  toBool
} from '../common.ts';
import type { PostDiscoveryContext } from './dispatch.ts';
import { policyBlock } from './dispatch.ts';
import {
  buildBrowserLifecycleLine,
  buildDiscoveryNotification,
  workflowPatchFromTelemetry
} from './helpers.ts';
import {
  buildNotifyPayload,
  shouldSendUserNotification,
  notifyUser,
  hasCleanupTrainingExamples,
  hasCleanupExecutionApproval,
  hasCleanupPreviewRequest,
  buildCleanupCandidatePreviewMessage,
  buildCleanupExecutionApprovalMessage
} from './page-analysis.ts';
import {
  buildAuthCheckpointMessage,
  inferCleanupIntent,
  hasCleanupPolicyDetails,
  buildCleanupClarificationMessage,
  buildCleanupTrainingPrompt,
  encodeCleanupTrainingNeed,
  decodeCleanupTrainingNeed,
  buildCleanupTrainingCapturedMessage,
  buildProbeFollowupMessage,
  persistProbeState,
  parseWalkthroughPlanValue,
  buildWalkthroughGuidanceMessage,
  buildWalkthroughCapturedMessage,
  hasWalkthroughCompletion
} from './probe-workflow.ts';

/* ------------------------------------------------------------------ */
/*  Post-discovery handlers                                            */
/* ------------------------------------------------------------------ */

/**
 * Handles authentication-blocked discovery (not authenticated).
 * Lines 1195-1258 of index.ts.
 */
export function handleAuthBlocked(ctx: PostDiscoveryContext): boolean {
  if (ctx.authenticatedDiscovery) {
    return false;
  }

  const checkpointMessage = buildAuthCheckpointMessage({ expectedUrl: ctx.url, discovery: ctx.discovery });
  const telemetry = ctx.telemetryFor({
    mode: toBool((ctx.discovery.challenge as Record<string, unknown> | undefined)?.detected, false)
      ? 'challenge_detected'
      : 'human_required',
    discovery: ctx.discovery,
    needsUserStep: checkpointMessage
  });
  const blockedMode =
    telemetry.state === 'challenge_detected' ? 'challenge_detected' : 'human_required';
  if (shouldSendUserNotification(ctx.targetMeta)) {
    notifyUser('Pinokio: Browser Action Needed', checkpointMessage);
  }
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      checkpoint_satisfied: ctx.checkpointSatisfied,
      checkpoint_awaited: ctx.checkpointAwaited,
      checkpoint_reason: ctx.checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
          ? Math.trunc(ctx.checkpointWaitedMs)
          : 0,
      discovery: ctx.discovery,
      needs_user_step: checkpointMessage,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: blockedMode,
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: checkpointMessage,
    discovery: ctx.discovery,
    notify: buildNotifyPayload('Pinokio: Browser Action Needed', checkpointMessage, {
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      suggestedPrompts: ctx.suggestedPrompts
    }),
    suggested_prompts: ctx.suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: ctx.uiBlocks
  });
  process.exit(0);
}

/**
 * Handles post-discovery cleanup policy clarification.
 * Lines 1260-1321 of index.ts.
 */
export function handlePostDiscoveryCleanupPolicy(ctx: PostDiscoveryContext): boolean {
  const cleanupIntent = inferCleanupIntent({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    targetMeta: ctx.targetMeta
  });
  const cleanupPolicyProvided = hasCleanupPolicyDetails({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  if (!(ctx.mutate && cleanupIntent && !cleanupPolicyProvided)) {
    return false;
  }

  const clarification = buildCleanupClarificationMessage(ctx.url);
  const telemetry = ctx.telemetryFor({
    mode: 'discovery_needs_user',
    discovery: ctx.discovery,
    needsUserStep: clarification
  });
  if (shouldSendUserNotification(ctx.targetMeta)) {
    notifyUser('Pinokio: Cleanup Policy Needed', clarification);
  }
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      checkpoint_satisfied: ctx.checkpointSatisfied,
      checkpoint_awaited: ctx.checkpointAwaited,
      checkpoint_reason: ctx.checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
          ? Math.trunc(ctx.checkpointWaitedMs)
          : 0,
      discovery: ctx.discovery,
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
    discovery: ctx.discovery,
    notify: buildNotifyPayload('Pinokio: Cleanup Policy Needed', clarification, {
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      suggestedPrompts: ctx.suggestedPrompts
    }),
    suggested_prompts: ctx.suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: ctx.uiBlocks
  });
  process.exit(0);
}

/**
 * Handles cleanup training (walkthrough/example recording).
 * Lines 1323-1455 of index.ts.
 *
 * Two sub-paths:
 * - If !trainingObserved -> respond with training-needed message and exit.
 * - If trainingObserved -> respond with training-captured message and exit.
 */
export function handleCleanupTraining(ctx: PostDiscoveryContext): boolean {
  const cleanupIntent = inferCleanupIntent({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    targetMeta: ctx.targetMeta
  });
  const cleanupPolicyProvided = hasCleanupPolicyDetails({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  const cleanupExecutionApproved = hasCleanupExecutionApproval({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  const cleanupPreviewRequested = hasCleanupPreviewRequest({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  if (!(ctx.mutate && cleanupIntent && cleanupPolicyProvided && !cleanupExecutionApproved && !cleanupPreviewRequested)) {
    return false;
  }

  const walkthroughPlan = ctx.activeWalkthroughPlan || parseWalkthroughPlanValue(ctx.probeState?.walkthrough_plan || null, 'state');
  const guidancePrompt = walkthroughPlan
    ? buildWalkthroughGuidanceMessage({
        url: asOptionalString(ctx.discovery.url) || ctx.url || null,
        plan: walkthroughPlan,
        discovery: ctx.discovery
      })
    : buildCleanupTrainingPrompt(ctx.url);
  const pendingTrainingMessage = decodeCleanupTrainingNeed(ctx.priorNeedsUserStepRaw) || guidancePrompt;
  const trainingObserved = walkthroughPlan
    ? hasWalkthroughCompletion(walkthroughPlan, ctx.discovery)
    : hasCleanupTrainingExamples(ctx.discovery);
  const readySignalReceived = ctx.readyFollowup || (ctx.checkpointAwaited && ctx.checkpointSatisfied);
  const trainingRetryMessage =
    readySignalReceived && !trainingObserved
      ? `${pendingTrainingMessage} I still need captured walkthrough evidence. Complete the highlighted overlay step(s), then click READY again.`
      : pendingTrainingMessage;

  if (!trainingObserved) {
    const telemetry = ctx.telemetryFor({
      mode: 'discovery_needs_user',
      discovery: ctx.discovery,
      needsUserStep: trainingRetryMessage
    });
    if (ctx.probeMode) {
      ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
        task_summary: ctx.effectiveUserTask,
        desired_action: ctx.desiredAction,
        url: asOptionalString(ctx.discovery.url) || ctx.url || null,
        checkpoint_satisfied: ctx.checkpointSatisfied,
        checkpoint_awaited: ctx.checkpointAwaited,
        checkpoint_reason: ctx.checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
            ? Math.trunc(ctx.checkpointWaitedMs)
            : 0,
        discovery: ctx.discovery,
        walkthrough_plan: walkthroughPlan,
        needs_user_step: encodeCleanupTrainingNeed(trainingRetryMessage),
        ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      chat_response: trainingRetryMessage,
      discovery: ctx.discovery,
      notify: buildNotifyPayload('Pinokio: Record Cleanup Examples', trainingRetryMessage, {
        url: asOptionalString(ctx.discovery.url) || ctx.url || null,
        suggestedPrompts: ctx.suggestedPrompts
      }),
      suggested_prompts: ctx.suggestedPrompts,
      policy: policyBlock(ctx),
      workflow_telemetry: telemetry,
      ui_blocks: ctx.uiBlocks
    });
    process.exit(0);
  }

  const trainingCapturedMessage = walkthroughPlan
    ? buildWalkthroughCapturedMessage({
        url: asOptionalString(ctx.discovery.url) || ctx.url || null,
        plan: walkthroughPlan,
        discovery: ctx.discovery
      })
    : buildCleanupTrainingCapturedMessage(ctx.url, ctx.discovery);
  const telemetry = ctx.telemetryFor({
    mode: 'discovery_needs_user',
    discovery: ctx.discovery,
    needsUserStep: trainingCapturedMessage
  });
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      checkpoint_satisfied: ctx.checkpointSatisfied,
      checkpoint_awaited: ctx.checkpointAwaited,
      checkpoint_reason: ctx.checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
          ? Math.trunc(ctx.checkpointWaitedMs)
          : 0,
      discovery: ctx.discovery,
      walkthrough_plan: walkthroughPlan,
      needs_user_step: trainingCapturedMessage,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'discovery_needs_user',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: trainingCapturedMessage,
    discovery: ctx.discovery,
    notify: buildNotifyPayload('Pinokio: Cleanup Training Captured', trainingCapturedMessage, {
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      suggestedPrompts: ctx.suggestedPrompts
    }),
    suggested_prompts: ctx.suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: ctx.uiBlocks
  });
  process.exit(0);
}

/**
 * Handles cleanup candidate preview.
 * Lines 1456-1505 of index.ts.
 */
export function handleCleanupPreview(ctx: PostDiscoveryContext): boolean {
  const cleanupIntent = inferCleanupIntent({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    targetMeta: ctx.targetMeta
  });
  const cleanupPolicyProvided = hasCleanupPolicyDetails({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  const cleanupPreviewRequested = hasCleanupPreviewRequest({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  const cleanupExecutionApproved = hasCleanupExecutionApproval({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  if (!(ctx.mutate && cleanupIntent && cleanupPolicyProvided && cleanupPreviewRequested && !cleanupExecutionApproved)) {
    return false;
  }

  const previewMessage = buildCleanupCandidatePreviewMessage(ctx.url, ctx.discovery);
  const telemetry = ctx.telemetryFor({
    mode: 'discovery_needs_user',
    discovery: ctx.discovery,
    needsUserStep: previewMessage
  });
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      checkpoint_satisfied: ctx.checkpointSatisfied,
      checkpoint_awaited: ctx.checkpointAwaited,
      checkpoint_reason: ctx.checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
          ? Math.trunc(ctx.checkpointWaitedMs)
          : 0,
      discovery: ctx.discovery,
      needs_user_step: previewMessage,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'discovery_needs_user',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: previewMessage,
    discovery: ctx.discovery,
    notify: buildNotifyPayload('Pinokio: Candidate Preview Ready', previewMessage, {
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      suggestedPrompts: ctx.suggestedPrompts
    }),
    suggested_prompts: ctx.suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: ctx.uiBlocks
  });
  process.exit(0);
}

/**
 * Handles cleanup execution approval request.
 * Lines 1506-1558 of index.ts.
 */
export function handleCleanupApproval(ctx: PostDiscoveryContext): boolean {
  const cleanupIntent = inferCleanupIntent({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    targetMeta: ctx.targetMeta
  });
  const cleanupPolicyProvided = hasCleanupPolicyDetails({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  const cleanupExecutionApproved = hasCleanupExecutionApproval({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });
  if (!(ctx.mutate && cleanupIntent && cleanupPolicyProvided && !cleanupExecutionApproved)) {
    return false;
  }

  const approvalMessage = buildCleanupExecutionApprovalMessage(ctx.url, ctx.discovery);
  const telemetry = ctx.telemetryFor({
    mode: 'needs_pilot_approval',
    discovery: ctx.discovery,
    needsUserStep: approvalMessage
  });
  if (shouldSendUserNotification(ctx.targetMeta)) {
    notifyUser('Pinokio: Confirm Pilot Cleanup', approvalMessage);
  }
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      checkpoint_satisfied: ctx.checkpointSatisfied,
      checkpoint_awaited: ctx.checkpointAwaited,
      checkpoint_reason: ctx.checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
          ? Math.trunc(ctx.checkpointWaitedMs)
          : 0,
      discovery: ctx.discovery,
      needs_user_step: approvalMessage,
      ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
    });
  }
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'needs_pilot_approval',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: approvalMessage,
    discovery: ctx.discovery,
    notify: buildNotifyPayload('Pinokio: Confirm Pilot Cleanup', approvalMessage, {
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      suggestedPrompts: ctx.suggestedPrompts
    }),
    suggested_prompts: ctx.suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: telemetry,
    ui_blocks: ctx.uiBlocks
  });
  process.exit(0);
}

/**
 * Handles guided walkthrough (mutate && activeWalkthroughPlan && !cleanupIntent).
 * Lines 1560-1629 of index.ts.
 */
export function handleWalkthrough(ctx: PostDiscoveryContext): boolean {
  const cleanupIntent = inferCleanupIntent({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    targetMeta: ctx.targetMeta
  });
  if (!(ctx.mutate && ctx.activeWalkthroughPlan && !cleanupIntent)) {
    return false;
  }

  const walkthroughObserved = hasWalkthroughCompletion(ctx.activeWalkthroughPlan, ctx.discovery);
  if (!walkthroughObserved) {
    const guidancePrompt = buildWalkthroughGuidanceMessage({
      url: asOptionalString(ctx.discovery.url) || ctx.url || null,
      plan: ctx.activeWalkthroughPlan,
      discovery: ctx.discovery
    });
    const pendingWalkthroughMessage = decodeCleanupTrainingNeed(ctx.priorNeedsUserStepRaw) || guidancePrompt;
    const readySignalReceived = ctx.readyFollowup || (ctx.checkpointAwaited && ctx.checkpointSatisfied);
    const retryMessage =
      readySignalReceived
        ? `${pendingWalkthroughMessage} I still need the current walkthrough step completed in the overlay before execution.`
        : pendingWalkthroughMessage;
    const telemetry = ctx.telemetryFor({
      mode: 'discovery_needs_user',
      discovery: ctx.discovery,
      needsUserStep: retryMessage
    });
    if (ctx.probeMode) {
      ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
        task_summary: ctx.effectiveUserTask,
        desired_action: ctx.desiredAction,
        url: asOptionalString(ctx.discovery.url) || ctx.url || null,
        checkpoint_satisfied: ctx.checkpointSatisfied,
        checkpoint_awaited: ctx.checkpointAwaited,
        checkpoint_reason: ctx.checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
            ? Math.trunc(ctx.checkpointWaitedMs)
            : 0,
        discovery: ctx.discovery,
        walkthrough_plan: ctx.activeWalkthroughPlan,
        needs_user_step: encodeCleanupTrainingNeed(retryMessage),
        ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      chat_response: retryMessage,
      discovery: ctx.discovery,
      notify: buildNotifyPayload('Pinokio: Guided Walkthrough', retryMessage, {
        url: asOptionalString(ctx.discovery.url) || ctx.url || null,
        suggestedPrompts: ctx.suggestedPrompts
      }),
      suggested_prompts: ctx.suggestedPrompts,
      policy: policyBlock(ctx),
      workflow_telemetry: telemetry,
      ui_blocks: ctx.uiBlocks
    });
    process.exit(0);
  }
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      walkthrough_plan: ctx.activeWalkthroughPlan,
      needs_user_step: null
    });
  }

  return false;
}

/**
 * Handles read-only (discovery only, !mutate).
 * Lines 1631-1671 of index.ts.
 */
export function handleDiscoveryOnly(ctx: PostDiscoveryContext): boolean {
  if (ctx.mutate) {
    return false;
  }

  const probePrompt = ctx.probeMode ? ` ${buildProbeFollowupMessage(ctx.url)}` : '';
  const lifecycleOnly = buildBrowserLifecycleLine({
    discovery: ctx.discovery,
    keepOpenAfterDiscoveryMs: ctx.keepOpenAfterDiscoveryMs,
    awaitUserCheckpointRequested: ctx.awaitUserCheckpointRequested,
    useUserContext: ctx.useUserContext,
    headless: ctx.headless,
    nonBlockingKeepOpen: ctx.nonBlockingKeepOpen
  }) || 'Discovery completed.';
  const discoveryNotify =
    shouldSendUserNotification(ctx.targetMeta)
      ? buildDiscoveryNotification({
          discovery: ctx.discovery,
          fallbackUrl: ctx.url || null,
          lifecycleText: lifecycleOnly
        })
      : null;
  respond({
    ok: true,
    plugin: 'playwright_read_agent',
    mode: 'discover',
    desired_action: ctx.desiredAction,
    url: ctx.url || null,
    chat_response: `${ctx.chatResponse}${probePrompt}`.trim(),
    discovery: ctx.discovery,
    notify: discoveryNotify,
    suggested_prompts: ctx.suggestedPrompts,
    policy: policyBlock(ctx),
    workflow_telemetry: ctx.discoveryTelemetry,
    ui_blocks: ctx.uiBlocks
  });
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Re-export handleWritePlanning from its dedicated module             */
/* ------------------------------------------------------------------ */

export { handleWritePlanning } from './dispatch-write-planning.ts';
