/**
 * Playwright read agent plugin — slim entry point.
 *
 * Parses the incoming request, builds the dispatch context, runs pre-discovery
 * handlers, executes browser discovery, then runs post-discovery handlers.
 * All handler logic lives in dispatch.ts; pure helpers live in helpers.ts.
 */

import { pluginContext, fail } from '../../../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  extractUrlHost,
  parseActionSteps,
  parseApiAttempts,
  parseTargetMeta,
  resolvePlaywrightExecutionPolicy,
  runPlaywrightService,
  toBool,
  toInt
} from '../common.ts';
import {
  extractSiteProfileLabels,
  extractSiteProfileNetworkCandidates,
  type WorkflowTelemetry
} from '../runtime-utils.ts';
import { SUPPORTED_ACTIONS } from './types.ts';
import {
  buildChatResponseFromDiscovery,
  buildWorkflowTelemetry,
  resolveKeepOpenAfterDiscoveryMs,
  resolvePlannerTimeoutMs
} from './helpers.ts';
import {
  normalizeWalkthroughToken,
  parseWalkthroughPlanValue,
  resolveWalkthroughPlan,
  inferCleanupIntent,
  hasCleanupPolicyDetails,
  hasPendingCleanupTraining,
  loadProbeState,
  loadSiteProfile,
  persistProbeState,
  persistSiteProfile,
  looksLikeProbeSkillExportMessage,
  normalizeSkillName
} from './probe-workflow.ts';
import {
  resolveDesiredAction,
  resolveTargetUrl,
  extractProbeLabels,
  extractDiscoveryNetworkCandidates,
  buildUiBlocks,
  looksLikeAuthenticatedDiscovery,
  buildSuggestedPrompts,
  isReadyFollowupMessage,
  hasCleanupExecutionApproval,
  hostMatchesForCheckpoint,
  checkpointReadyForUrl
} from './page-analysis.ts';
import type { DispatchContext, PostDiscoveryContext } from './dispatch.ts';
import {
  handleShowNetworkCandidates,
  handleEarlyCleanupPolicy,
  handleProbeSkillConvert,
  handleAuthCheckpoint,
  handlePlanOnly,
  handleAuthBlocked,
  handlePostDiscoveryCleanupPolicy,
  handleCleanupTraining,
  handleCleanupPreview,
  handleCleanupApproval,
  handleWalkthrough,
  handleDiscoveryOnly,
  handleWritePlanning
} from './dispatch.ts';
import {
  workflowPatchFromTelemetry,
  withWorkflowTelemetryBlocks
} from './helpers.ts';

/* ------------------------------------------------------------------ */
/*  Main entry                                                         */
/* ------------------------------------------------------------------ */

try {
  const { request } = pluginContext();
  const action = String(request.action || '').trim().toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`playwright_read_agent only supports action 'read' (got '${action}')`);
  }

  /* --- Parse request and compute setup variables --- */

  const targetMeta = parseTargetMeta(request.target);
  const userTask = asOptionalString(request.summary) || asOptionalString(targetMeta.task_summary) || '';
  const desiredAction = resolveDesiredAction(request, targetMeta);
  const mutate = toBool(targetMeta.mutate, false) || desiredAction !== 'read';
  const url = resolveTargetUrl(request, targetMeta);
  const timeoutMs = toInt(targetMeta.timeout_ms, 45000, 1000, 300000);
  const channel = asOptionalString(targetMeta.channel) || 'default';
  const responseFormat = asOptionalString(targetMeta.response_format) || 'text';
  const useStealth = toBool(targetMeta.use_stealth, true);
  const targetHost = extractUrlHost(url || '') || null;
  let siteProfile = loadSiteProfile(targetHost);
  let probeState = loadProbeState(channel);

  // Reset state on host mismatch
  const stateHostMismatch =
    Boolean(probeState) &&
    Boolean(url) &&
    !hostMatchesForCheckpoint(probeState?.url || null, url || null);
  if (stateHostMismatch) {
    probeState = persistProbeState(channel, probeState, {
      url: url || null,
      checkpoint_satisfied: false,
      checkpoint_awaited: false,
      checkpoint_reason: null,
      checkpoint_waited_ms: 0,
      discovery: undefined,
      planner_actions: [],
      planner_api_attempts: [],
      planner_notes: null,
      needs_user_step: null,
      walkthrough_plan: null,
      workflow_state: null,
      workflow_pending_step: null,
      workflow_last_transition: null,
      workflow_last_error: null
    });
  }

  const priorNeedsUserStepRaw = asOptionalString(probeState?.needs_user_step);
  const cleanupTrainingPending = hasPendingCleanupTraining(priorNeedsUserStepRaw);
  const readyFollowup = isReadyFollowupMessage(userTask);
  const effectiveUserTask =
    readyFollowup && asOptionalString(probeState?.task_summary)
      ? (asOptionalString(probeState?.task_summary) || userTask)
      : userTask;

  const policy = resolvePlaywrightExecutionPolicy({
    targetMeta,
    url,
    message: effectiveUserTask
  });
  const useUserContext = policy.useUserContext;
  const headless = policy.headless;
  const captureScreenshot = toBool(targetMeta.capture_screenshot, true);
  const autoInstallChromium = toBool(targetMeta.auto_install_chromium, true);
  const autoInstallDeps = toBool(targetMeta.auto_install_deps, true);
  const installCommand = asOptionalString(targetMeta.install_command);
  const installDepsCommand = asOptionalString(targetMeta.install_deps_command);
  const explicitUserDataDir = asOptionalString(targetMeta.user_data_dir);
  const userDataDir =
    useUserContext
      ? explicitUserDataDir || policy.userDataDir
      : null;

  const planOnly = toBool(targetMeta.plan_only, false);
  const plannerTimeoutMs = resolvePlannerTimeoutMs(targetMeta);
  const requestedProfile =
    (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
    (asOptionalString(targetMeta.profile) || 'codex');
  const probeMode = toBool(targetMeta.probe_mode, true);
  const probeOverlayEnabled = toBool(targetMeta.probe_overlay_enabled, true);
  const probeOverlayAutoActivateRequested = toBool(targetMeta.probe_overlay_auto_activate, false);
  const probeOverlayReset = toBool(targetMeta.probe_overlay_reset, false);
  const probeConvertToSkill =
    toBool(targetMeta.probe_convert_to_skill, false) ||
    looksLikeProbeSkillExportMessage(userTask);
  const probeAutoRegisterSkill = toBool(targetMeta.probe_auto_register_skill, true);
  const requestedProbeSkillName = normalizeSkillName(asOptionalString(targetMeta.probe_skill_name) || '');
  const awaitUserCheckpointRequested = toBool(targetMeta.await_user_checkpoint, false);
  const keepOpenAfterDiscoveryMs = resolveKeepOpenAfterDiscoveryMs({
    targetMeta,
    awaitUserCheckpointRequested,
    useUserContext,
    headless
  });
  const nonBlockingKeepOpen =
    keepOpenAfterDiscoveryMs > 0 &&
    awaitUserCheckpointRequested &&
    useUserContext &&
    !headless;
  const serviceTimeoutMs =
    timeoutMs +
    (nonBlockingKeepOpen ? 0 : keepOpenAfterDiscoveryMs) +
    (autoInstallChromium || autoInstallDeps ? 900000 : 10000);
  const probeOverlayAutoActivate = probeOverlayAutoActivateRequested && !awaitUserCheckpointRequested;
  const checkpointReady = checkpointReadyForUrl(probeState, url);

  const cleanupIntentEarly = inferCleanupIntent({
    userTask: effectiveUserTask,
    desiredAction,
    targetMeta
  });
  const cleanupPolicyProvidedEarly = hasCleanupPolicyDetails({
    userTask: effectiveUserTask,
    targetMeta
  });
  const cleanupExecutionApprovedEarly = hasCleanupExecutionApproval({
    userTask: effectiveUserTask,
    targetMeta
  });
  const hasExplicitPlanHints =
    parseActionSteps(targetMeta.actions).length > 0 ||
    parseApiAttempts(targetMeta.api_attempts).length > 0;
  const genericWalkthroughNeededEarly =
    mutate &&
    !cleanupIntentEarly &&
    !hasExplicitPlanHints &&
    policy.inferredAuthenticatedTask;
  const walkthroughRequestedEarly =
    !planOnly &&
    probeMode &&
    (
      toBool(targetMeta.walkthrough_mode, false) ||
      genericWalkthroughNeededEarly ||
      (
        mutate &&
        cleanupIntentEarly &&
        cleanupPolicyProvidedEarly &&
        !cleanupExecutionApprovedEarly
      )
    );
  const probeTrainingModeRequested =
    mutate &&
    (
      cleanupTrainingPending ||
      (
        cleanupIntentEarly &&
        cleanupPolicyProvidedEarly &&
        !cleanupExecutionApprovedEarly
      )
    );

  let activeWalkthroughPlan = parseWalkthroughPlanValue(
    probeState?.walkthrough_plan || null,
    'state'
  );
  if (walkthroughRequestedEarly) {
    activeWalkthroughPlan = resolveWalkthroughPlan({
      existingPlan: activeWalkthroughPlan,
      userTask: effectiveUserTask,
      desiredAction,
      url,
      discovery:
        probeState?.discovery && typeof probeState.discovery === 'object'
          ? probeState.discovery
          : null,
      existingLabels:
        probeState?.discovery && typeof probeState.discovery === 'object'
          ? extractProbeLabels(probeState.discovery)
          : [],
      profile: requestedProfile,
      timeoutMs: plannerTimeoutMs
    });
    probeState = persistProbeState(channel, probeState, {
      walkthrough_plan: activeWalkthroughPlan
    });
  }

  /* --- Build dispatch context --- */

  const telemetryFor = (params: {
    mode: string;
    discovery?: Record<string, unknown> | null;
    needsUserStep?: string | null;
    lastError?: string | null;
  }): WorkflowTelemetry =>
    buildWorkflowTelemetry({
      mode: params.mode,
      discovery: params.discovery || null,
      needsUserStep: params.needsUserStep || null,
      lastError: params.lastError || null
    });

  const ctx: DispatchContext = {
    request,
    action,
    targetMeta,
    userTask,
    effectiveUserTask,
    desiredAction,
    mutate,
    url,
    timeoutMs,
    channel,
    responseFormat,
    useStealth,
    targetHost,
    siteProfile,
    probeState,
    policy,
    useUserContext,
    headless,
    captureScreenshot,
    autoInstallChromium,
    autoInstallDeps,
    installCommand,
    installDepsCommand,
    userDataDir,
    planOnly,
    plannerTimeoutMs,
    requestedProfile,
    probeMode,
    probeOverlayEnabled,
    probeOverlayAutoActivate,
    probeOverlayReset,
    probeConvertToSkill,
    probeAutoRegisterSkill,
    requestedProbeSkillName,
    awaitUserCheckpointRequested,
    keepOpenAfterDiscoveryMs,
    nonBlockingKeepOpen,
    serviceTimeoutMs,
    checkpointReady,
    cleanupIntentEarly,
    cleanupPolicyProvidedEarly,
    cleanupExecutionApprovedEarly,
    probeTrainingModeRequested,
    activeWalkthroughPlan,
    priorNeedsUserStepRaw,
    cleanupTrainingPending,
    readyFollowup,
    telemetryFor
  };

  /* --- Pre-discovery handlers --- */

  if (handleShowNetworkCandidates(ctx)) process.exit(0);
  if (handleEarlyCleanupPolicy(ctx)) process.exit(0);
  if (handleProbeSkillConvert(ctx)) process.exit(0);
  if (handleAuthCheckpoint(ctx)) process.exit(0);
  if (handlePlanOnly(ctx)) process.exit(0);

  /* --- Run browser discovery --- */

  const canUseCachedDiscovery =
    mutate &&
    policy.inferredAuthenticatedTask &&
    !awaitUserCheckpointRequested &&
    !probeOverlayAutoActivate &&
    !probeOverlayReset &&
    !activeWalkthroughPlan &&
    checkpointReady &&
    probeMode &&
    Boolean(probeState?.discovery);

  let discovery: Record<string, unknown>;
  if (canUseCachedDiscovery) {
    const cached = (probeState?.discovery && typeof probeState.discovery === 'object' && !Array.isArray(probeState.discovery))
      ? (probeState.discovery as Record<string, unknown>)
      : {};
    discovery = {
      ...cached,
      user_checkpoint: {
        awaited: false,
        satisfied: true,
        expected_host: extractUrlHost(url || ''),
        final_url: asOptionalString(cached.url) || probeState?.url || url || null,
        waited_ms: 0,
        reason: 'cached'
      }
    };
  } else {
    discovery = runPlaywrightService({
      action: 'discover',
      url: url || undefined,
      prompt: effectiveUserTask || undefined,
      timeout_ms: timeoutMs,
      headless,
      use_stealth: useStealth,
      use_user_context: useUserContext,
      user_data_dir: userDataDir || undefined,
      storage_state_path: asOptionalString(targetMeta.storage_state_path) || undefined,
      capture_screenshot: captureScreenshot,
      max_network_events: toInt(targetMeta.max_network_events, 40, 1, 200),
      probe_overlay_enabled: probeOverlayEnabled,
      probe_overlay_auto_activate: probeOverlayAutoActivate,
      probe_overlay_reset: probeOverlayReset,
      probe_training_mode: probeTrainingModeRequested,
      probe_walkthrough_plan: activeWalkthroughPlan
        ? (activeWalkthroughPlan as unknown as Record<string, unknown>)
        : undefined,
      await_user_checkpoint: awaitUserCheckpointRequested,
      user_checkpoint_timeout_ms: toInt(targetMeta.user_checkpoint_timeout_ms, 180000, 5000, 600000),
      keep_open_after_discovery_ms: keepOpenAfterDiscoveryMs,
      non_blocking_keep_open: nonBlockingKeepOpen,
      auth_expected_host: asOptionalString(targetMeta.auth_expected_host) || extractUrlHost(url || ''),
      auto_install_chromium: autoInstallChromium,
      auto_install_deps: autoInstallDeps,
      install_command: installCommand || undefined,
      install_deps_command: installDepsCommand || undefined
    }, serviceTimeoutMs);
  }

  /* --- Build post-discovery context --- */

  const chatResponse = buildChatResponseFromDiscovery(discovery, url, {
    keepOpenAfterDiscoveryMs,
    awaitUserCheckpointRequested,
    useUserContext,
    headless,
    nonBlockingKeepOpen
  });
  const discoveryLabels = extractProbeLabels(discovery);
  const discoveryCandidates = extractDiscoveryNetworkCandidates(discovery);
  if (targetHost) {
    ctx.siteProfile = persistSiteProfile(targetHost, ctx.siteProfile, {
      labels: extractSiteProfileLabels(discoveryLabels),
      network_candidates: extractSiteProfileNetworkCandidates(discoveryCandidates),
      mark_success: false
    });
  }
  const uiBlocksBase = responseFormat === 'ui_blocks' || channel.includes('ui')
    ? buildUiBlocks(discovery, desiredAction)
    : [];
  const discoveryTelemetry = telemetryFor({
    mode: 'discover',
    discovery,
    needsUserStep: null,
    lastError: null
  });
  const uiBlocks = withWorkflowTelemetryBlocks(uiBlocksBase, discoveryTelemetry);
  const suggestedPrompts = buildSuggestedPrompts({
    url: asOptionalString(discovery.url) || url || null,
    discovery
  });

  const checkpointMeta =
    discovery.user_checkpoint && typeof discovery.user_checkpoint === 'object' && !Array.isArray(discovery.user_checkpoint)
      ? (discovery.user_checkpoint as Record<string, unknown>)
      : null;
  const checkpointSatisfied = checkpointMeta ? toBool(checkpointMeta.satisfied, false) : false;
  const checkpointAwaited = checkpointMeta ? toBool(checkpointMeta.awaited, false) : false;
  const checkpointReason = checkpointMeta ? asOptionalString(checkpointMeta.reason) : null;
  const checkpointWaitedMs = checkpointMeta ? Number(checkpointMeta.waited_ms) : NaN;

  if (probeMode) {
    ctx.probeState = persistProbeState(channel, ctx.probeState, {
      task_summary: effectiveUserTask,
      desired_action: desiredAction,
      url: asOptionalString(discovery.url) || url || null,
      checkpoint_satisfied: checkpointSatisfied,
      checkpoint_awaited: checkpointAwaited,
      checkpoint_reason: checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
          ? Math.trunc(checkpointWaitedMs)
          : 0,
      discovery,
      planner_actions: ctx.probeState?.planner_actions || [],
      planner_api_attempts: ctx.probeState?.planner_api_attempts || [],
      planner_notes: ctx.probeState?.planner_notes || null,
      needs_user_step: null,
      ...workflowPatchFromTelemetry(discoveryTelemetry, targetHost)
    });
  }

  const authenticatedDiscovery = looksLikeAuthenticatedDiscovery({
    targetMeta,
    url,
    discovery,
    useUserContext,
    inferredAuthenticatedTask: policy.inferredAuthenticatedTask
  });

  const postCtx: PostDiscoveryContext = {
    ...ctx,
    discovery,
    chatResponse,
    discoveryLabels,
    discoveryCandidates,
    uiBlocks,
    discoveryTelemetry,
    suggestedPrompts,
    checkpointSatisfied,
    checkpointAwaited,
    checkpointReason,
    checkpointWaitedMs:
      Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
        ? Math.trunc(checkpointWaitedMs)
        : 0,
    authenticatedDiscovery
  };

  /* --- Post-discovery handlers --- */

  if (handleAuthBlocked(postCtx)) process.exit(0);
  if (handlePostDiscoveryCleanupPolicy(postCtx)) process.exit(0);
  if (handleCleanupTraining(postCtx)) process.exit(0);
  if (handleCleanupPreview(postCtx)) process.exit(0);
  if (handleCleanupApproval(postCtx)) process.exit(0);
  if (handleWalkthrough(postCtx)) process.exit(0);
  if (handleDiscoveryOnly(postCtx)) process.exit(0);
  handleWritePlanning(postCtx);
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
