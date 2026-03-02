/**
 * Chat-worker agent plugin — thin orchestrator.
 *
 * All domain logic is imported from the ./chat-worker/ modules.
 * This file contains only the main IIFE, request dispatch, and the
 * `persistConversationState` closure.
 */

import path from 'node:path';
import { pluginContext, respond, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { ChatDbConnection, ChatSession } from '../sdk/typescript/pinokio-sdk.ts';
import {
  ensureChatSchema,
  findOrCreateSession,
  insertMessage,
  updateSessionCounters,
  autoFlagImportance,
  getSessionMessages,
  listSessions,
} from '../sdk/typescript/chat-db.ts';
import { asOptionalString, toBool, parseTargetMeta, runChatLlm } from './plugin-utils.ts';
import type {
  ChatChannelState,
  ExplorerTarget,
  ExplorerCall,
  ChatDbMeta,
} from './chat-worker/types.ts';
import { EXPLORER_RESOURCE, PLAYWRIGHT_RESOURCE } from './chat-worker/types.ts';
import {
  SUPPORTED_ACTIONS,
  normalizeMessage,
  conversationSummaryForPrompt,
  inferAssistantFollowUpQuestion,
  looksLikeExplicitNewConversation,
  looksLikeBrowserWorkflowCancelMessage,
  looksLikeBrowserWorkflowStatusMessage,
  looksLikeBrowserWorkflowResumeMessage,
  shouldBiasToConversationFollowUp,
  looksLikeBrowserAutomationIntent,
  looksLikeBrowserWorkflowControlMessage,
  isBrowserFollowupAckMessage,
  looksLikeBrowserSkillExportIntent,
  parseSkillNameFromMessage,
  messageHasCleanupPolicyDetails,
  parseCleanupPolicyPreset,
  looksLikeFilesystemIntent,
  isMutationAction,
  isExplicitPriorFileWriteIntent,
} from './chat-worker/intent-detection.ts';
import {
  shouldUseChatDb,
  resolveChatDbConnectionWithTimeout,
  loadChannelState,
  normalizeConversation,
  appendConversationTurn,
  normalizePendingFilesystem,
  saveChannelState,
  buildChannelState,
} from './chat-worker/channel-state.ts';
import {
  normalizeCrudAction,
  normalizeBrowserWorkflowState,
  isBrowserWorkflowStateStale,
  isActiveBrowserWorkflowState,
  eventForBrowserWorkflowState,
  mapBrowserModeHintToWorkflowState,
  describeBrowserWorkflowStatus,
  inferBrowserContinuationSignal,
  buildPlaywrightCallFromMessage,
} from './chat-worker/browser-workflow.ts';
import {
  buildExplorerTargetFromMessage,
  buildExplorerCallFromPending,
  chooseHeuristicExplorerRoute,
  shouldPreferFallbackExplorerCall,
  enforcePriorFileWriteCall,
  normalizeExplorerAction,
  resolveNextLastFilePath,
  maybeReadableBytesReply,
  looksLikeExplicitPathSyntax,
} from './chat-worker/explorer-routing.ts';
import {
  loadPluginCatalogFromSocketBus,
  summarizePluginCatalog,
  hasResourceInCatalog,
  summarizePluginRoutingHints,
  planPluginIntentWithLlm,
  planExplorerCallWithLlm,
  buildChatPrompt,
  resolveProbeHosts,
  probeAnyHttpsHost,
  resolveTimeoutMs,
  shouldFailOnProbe,
} from './chat-worker/llm-prompts.ts';

/* ------------------------------------------------------------------ */
/*  Local helpers (orchestrator-only)                                   */
/* ------------------------------------------------------------------ */

function normalizeRuntime(value: unknown): string {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'unsafe_host' || runtime === 'host') {
    return 'unsafe_host';
  }
  return 'container';
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                    */
/* ------------------------------------------------------------------ */

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
          confidence: 'high' as const,
          reason: 'cleanup policy preset selected'
        }
      : browserWorkflowControlRequest && Boolean(lastBrowserUrl)
      ? {
          resource: PLAYWRIGHT_RESOURCE,
          confidence: 'high' as const,
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
