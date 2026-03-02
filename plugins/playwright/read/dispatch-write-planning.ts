/**
 * Write-planning dispatch handler extracted from dispatch-post-discovery.ts.
 *
 * Handles the final write-planning stage: LLM-based action planning, guardrail
 * enforcement, and delegation to the playwright_write_agent.
 */

import { respond, spawnChild } from '../../../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  parseActionSteps,
  parseApiAttempts,
  runChatLlm,
  toBool
} from '../common.ts';
import {
  enforceExecutionGuardrails,
  inferRequiredLabelKeys
} from '../runtime-utils.ts';
import type { PostDiscoveryContext } from './dispatch.ts';
import { policyBlock } from './dispatch.ts';
import {
  buildPlannerPrompt,
  workflowPatchFromTelemetry,
  parsePlannerResult,
  fallbackPlannerResult
} from './helpers.ts';
import {
  buildNotifyPayload,
  shouldSendUserNotification,
  notifyUser,
  applySiteProfileToActions,
  applySiteProfileToApiAttempts,
  hasCleanupExecutionApproval
} from './page-analysis.ts';
import {
  resolveSkillHints,
  inferCleanupIntent,
  buildProbeFollowupMessage,
  persistProbeState
} from './probe-workflow.ts';

/* ------------------------------------------------------------------ */
/*  Write-planning handler                                             */
/* ------------------------------------------------------------------ */

/**
 * Handles the final write-planning dispatch (always executes if reached).
 * Lines 1673-1985 of index.ts.
 */
export function handleWritePlanning(ctx: PostDiscoveryContext): boolean {
  const cleanupIntent = inferCleanupIntent({
    userTask: ctx.effectiveUserTask,
    desiredAction: ctx.desiredAction,
    targetMeta: ctx.targetMeta
  });
  const cleanupExecutionApproved = hasCleanupExecutionApproval({
    userTask: ctx.effectiveUserTask,
    targetMeta: ctx.targetMeta
  });

  const writeResource = asOptionalString(ctx.targetMeta.write_resource) || 'plugin:playwright_write_agent';
  const providedActions = parseActionSteps(ctx.targetMeta.actions);
  const providedApiAttempts = parseApiAttempts(ctx.targetMeta.api_attempts);
  let actions = providedActions;
  let apiAttempts = providedApiAttempts;
  let plannerNotes: string | null = null;
  let needsUserStep: string | null = null;

  if ((actions.length === 0 && apiAttempts.length === 0) && toBool(ctx.targetMeta.plan_with_llm, true)) {
    const plannerPrompt = buildPlannerPrompt({
      userTask: ctx.effectiveUserTask,
      desiredAction: ctx.desiredAction,
      url: ctx.url,
      discovery: ctx.discovery,
      skillHints: resolveSkillHints(ctx.targetMeta),
      siteProfile: ctx.siteProfile
    });
    try {
      const llm = runChatLlm({
        profile: ctx.requestedProfile,
        prompt: plannerPrompt,
        timeoutMs: ctx.plannerTimeoutMs
      });
      const planner = parsePlannerResult(llm.text);
      if (planner.actions.length > 0) {
        actions = planner.actions;
      }
      if (planner.apiAttempts.length > 0) {
        apiAttempts = planner.apiAttempts;
      }
      plannerNotes = planner.notes;
      needsUserStep = planner.needsUserStep;
    } catch {
      const fallback = fallbackPlannerResult({
        desiredAction: ctx.desiredAction,
        url: ctx.url,
        inferredAuthenticatedTask: ctx.policy.inferredAuthenticatedTask,
        authenticatedReady: ctx.checkpointReady || ctx.checkpointSatisfied || ctx.authenticatedDiscovery
      });
      plannerNotes = fallback.notes;
      needsUserStep = fallback.needsUserStep;
      if (fallback.actions.length > 0 && actions.length === 0) {
        actions = fallback.actions;
      }
      if (fallback.apiAttempts.length > 0 && apiAttempts.length === 0) {
        apiAttempts = fallback.apiAttempts;
      }
    }
  }

  if (
    needsUserStep &&
    /reply\s+"?ready"?/i.test(needsUserStep) &&
    (ctx.checkpointReady || ctx.checkpointSatisfied || ctx.authenticatedDiscovery)
  ) {
    needsUserStep = null;
    plannerNotes =
      plannerNotes ||
      'Checkpoint is already satisfied. Continuing with probe inventory in this session.';
    if (actions.length === 0 && apiAttempts.length === 0) {
      actions = parseActionSteps([
        { type: 'wait_for_selector', selector: 'body', timeout_ms: 8000 },
        { type: 'extract_text', selector: 'main' }
      ]);
    }
  }

  const discoveryUrl = asOptionalString(ctx.discovery.url) || ctx.url || null;
  const fallbackOrigin = (() => {
    const candidate = asOptionalString(ctx.discovery.url) || ctx.url || null;
    if (!candidate) {
      return null;
    }
    try {
      return new URL(candidate).origin;
    } catch {
      return null;
    }
  })();
  actions = applySiteProfileToActions(actions, ctx.siteProfile);
  apiAttempts = applySiteProfileToApiAttempts(apiAttempts, ctx.siteProfile, fallbackOrigin);

  if (actions.length === 0 && apiAttempts.length === 0) {
    needsUserStep =
      needsUserStep ||
      'I need either explicit browser actions or one user checkpoint before I can execute this safely.';
  }

  if (needsUserStep && actions.length === 0 && apiAttempts.length === 0) {
    const probePrompt = ctx.probeMode ? ` ${buildProbeFollowupMessage(ctx.url)}` : '';
    const telemetry = ctx.telemetryFor({
      mode: 'discovery_needs_user',
      discovery: ctx.discovery,
      needsUserStep
    });
    if (shouldSendUserNotification(ctx.targetMeta)) {
      notifyUser('Pinokio: User Input Needed', needsUserStep);
    }
    if (ctx.probeMode) {
      ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
        task_summary: ctx.effectiveUserTask,
        desired_action: ctx.desiredAction,
        url: discoveryUrl,
        checkpoint_satisfied: ctx.checkpointSatisfied,
        checkpoint_awaited: ctx.checkpointAwaited,
        checkpoint_reason: ctx.checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
            ? Math.trunc(ctx.checkpointWaitedMs)
            : 0,
        discovery: ctx.discovery,
        planner_actions: actions,
        planner_api_attempts: apiAttempts,
        planner_notes: plannerNotes,
        needs_user_step: needsUserStep,
        ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      chat_response: `${needsUserStep}${probePrompt}`.trim(),
      discovery: ctx.discovery,
      notify: buildNotifyPayload('Pinokio: User Input Needed', needsUserStep, {
        url: discoveryUrl,
        suggestedPrompts: ctx.suggestedPrompts
      }),
      suggested_prompts: ctx.suggestedPrompts,
      workflow_telemetry: telemetry,
      ui_blocks: ctx.uiBlocks
    });
    process.exit(0);
  }

  const requiredLabelKeys = inferRequiredLabelKeys({
    desiredAction: ctx.desiredAction,
    userTask: ctx.effectiveUserTask,
    actions: actions as unknown as Array<Record<string, unknown>>
  });
  const pilotApproved =
    cleanupExecutionApproved ||
    toBool(ctx.targetMeta.pilot_approved, false) ||
    /\bpilot\s+(archive|delete|approve|ok|run)\b/i.test(ctx.effectiveUserTask);
  const guardrails = enforceExecutionGuardrails({
    mutate: ctx.mutate,
    desiredAction: ctx.desiredAction,
    preferNetworkFirst: toBool(ctx.targetMeta.prefer_network_first, true),
    cleanupIntent,
    pilotApproved,
    labels: ctx.discoveryLabels,
    requiredLabelKeys,
    networkCandidates: ctx.discoveryCandidates,
    actionsCount: actions.length,
    apiAttemptsCount: apiAttempts.length
  });
  if (!guardrails.ok) {
    const issueSummary = guardrails.issues.map((item: string) => `- ${item}`).join('\n');
    const recovery = guardrails.pilotRequired
      ? 'Reply "PILOT ARCHIVE 1" or "PILOT DELETE 1" to run one safe pilot first.'
      : guardrails.missingNetworkCandidates
        ? 'Reply "SHOW CANDIDATES" on the exact workflow screen, then run this again.'
        : `Enable label mode and capture: ${guardrails.missingLabelKeys.join(', ')}`;
    const guardrailMessage = [
      'Execution paused by deterministic guardrails.',
      issueSummary,
      recovery
    ].join('\n');
    const telemetry = ctx.telemetryFor({
      mode: guardrails.pilotRequired ? 'needs_pilot_approval' : 'discovery_needs_user',
      discovery: ctx.discovery,
      needsUserStep: guardrailMessage
    });
    if (ctx.probeMode) {
      ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
        task_summary: ctx.effectiveUserTask,
        desired_action: ctx.desiredAction,
        url: discoveryUrl,
        checkpoint_satisfied: ctx.checkpointSatisfied,
        checkpoint_awaited: ctx.checkpointAwaited,
        checkpoint_reason: ctx.checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
            ? Math.trunc(ctx.checkpointWaitedMs)
            : 0,
        discovery: ctx.discovery,
        planner_actions: actions,
        planner_api_attempts: apiAttempts,
        planner_notes: plannerNotes,
        needs_user_step: guardrailMessage,
        ...workflowPatchFromTelemetry(telemetry, ctx.targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: guardrails.pilotRequired ? 'needs_pilot_approval' : 'discovery_needs_user',
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      chat_response: guardrailMessage,
      discovery: ctx.discovery,
      suggested_prompts: ctx.suggestedPrompts,
      workflow_telemetry: telemetry,
      ui_blocks: ctx.uiBlocks,
      guardrails
    });
    process.exit(0);
  }

  const executeTelemetry = ctx.telemetryFor({
    mode: 'read_then_write',
    discovery: ctx.discovery,
    needsUserStep: null
  });
  if (ctx.probeMode) {
    ctx.probeState = persistProbeState(ctx.channel, ctx.probeState, {
      task_summary: ctx.effectiveUserTask,
      desired_action: ctx.desiredAction,
      url: discoveryUrl,
      checkpoint_satisfied: ctx.checkpointSatisfied,
      checkpoint_awaited: ctx.checkpointAwaited,
      checkpoint_reason: ctx.checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(ctx.checkpointWaitedMs) && ctx.checkpointWaitedMs >= 0
          ? Math.trunc(ctx.checkpointWaitedMs)
          : 0,
      discovery: ctx.discovery,
      planner_actions: actions,
      planner_api_attempts: apiAttempts,
      planner_notes: plannerNotes,
      needs_user_step: needsUserStep,
      ...workflowPatchFromTelemetry(executeTelemetry, ctx.targetHost)
    });
  }

  const executionTarget: Record<string, unknown> = {
    desired_action: ctx.desiredAction,
    url: ctx.url || ctx.discovery.url || null,
    task_summary: ctx.effectiveUserTask,
    actions,
    api_attempts: apiAttempts,
    discovery: ctx.discovery,
    planner_notes: plannerNotes,
    required_label_keys: requiredLabelKeys,
    site_profile: ctx.siteProfile,
    label_map: ctx.siteProfile?.label_map || {},
    channel: ctx.channel,
    response_format: ctx.responseFormat,
    timeout_ms: ctx.timeoutMs,
    use_stealth: ctx.useStealth,
    use_user_context: ctx.useUserContext,
    allow_user_context: toBool(ctx.targetMeta.allow_user_context, false),
    user_data_dir: ctx.userDataDir,
    headless: ctx.headless,
    allow_unsafe: false,
    auto_install_chromium: ctx.autoInstallChromium,
    auto_install_deps: ctx.autoInstallDeps,
    install_command: ctx.installCommand || null,
    install_deps_command: ctx.installDepsCommand || null
  };
  const delegateRuntime =
    asOptionalString(ctx.targetMeta.delegate_runtime) ||
    asOptionalString(ctx.targetMeta.runtime) ||
    asOptionalString(ctx.request.runtime) ||
    undefined;
  if (delegateRuntime) {
    executionTarget.delegate_runtime = delegateRuntime;
  }

  spawnChild(
    {
      summary: asOptionalString(ctx.request.summary) || `playwright ${ctx.desiredAction} execution`,
      resource: writeResource,
      action: ctx.desiredAction === 'create' ? 'create' : ctx.desiredAction === 'delete' ? 'delete' : 'update',
      target: JSON.stringify(executionTarget),
      runtime: delegateRuntime,
      container_image:
        asOptionalString(ctx.targetMeta.container_image) ||
        asOptionalString(ctx.request.container_image) ||
        null,
      llm_profile:
        typeof ctx.request.llm_profile === 'string' && ctx.request.llm_profile.trim()
          ? ctx.request.llm_profile.trim()
          : null
    },
    {
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'read_then_write',
      desired_action: ctx.desiredAction,
      url: ctx.url || null,
      chat_response: plannerNotes || 'Prepared browser execution plan from discovery and delegating to write agent.',
      discovery: ctx.discovery,
      workflow_telemetry: executeTelemetry,
      guardrails,
      site_profile_host: ctx.targetHost,
      suggested_prompts: ctx.suggestedPrompts,
      policy: policyBlock(ctx),
      ui_blocks: ctx.uiBlocks,
      action_count: actions.length,
      api_attempt_count: apiAttempts.length,
      write_resource: writeResource
    }
  );

  return true;
}
