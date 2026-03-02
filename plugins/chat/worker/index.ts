/**
 * Chat-worker agent plugin — thin orchestrator.
 *
 * All domain logic is imported from the ./chat-worker/ modules.
 * This file contains only the main IIFE, request dispatch, and the
 * `persistConversationState` closure.
 */

import { pluginContext, respond, fail } from '../../../sdk/typescript/pinokio-sdk.ts';
import type { ChatDbConnection, ChatSession } from '../../../sdk/typescript/pinokio-sdk.ts';
import {
  ensureChatSchema,
  findOrCreateSession,
  insertMessage,
  updateSessionCounters,
  autoFlagImportance,
} from '../../../sdk/typescript/chat-db.ts';
import { asOptionalString, toBool, parseTargetMeta, runChatLlm } from '../../plugin-utils.ts';
import type {
  ChatChannelState,
  ChatDbMeta,
} from './types.ts';
import { EXPLORER_RESOURCE, PLAYWRIGHT_RESOURCE } from './types.ts';
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
} from './intent-detection.ts';
import {
  shouldUseChatDb,
  resolveChatDbConnectionWithTimeout,
  loadChannelState,
  normalizeConversation,
  appendConversationTurn,
  normalizePendingFilesystem,
  saveChannelState,
  buildChannelState,
} from './channel-state.ts';
import {
  normalizeCrudAction,
  normalizeBrowserWorkflowState,
  isBrowserWorkflowStateStale,
  isActiveBrowserWorkflowState,
  eventForBrowserWorkflowState,
  mapBrowserModeHintToWorkflowState,
  describeBrowserWorkflowStatus,
  inferBrowserContinuationSignal,
} from './browser-workflow.ts';
import {
  maybeReadableBytesReply,
  looksLikeExplicitPathSyntax,
} from './explorer-routing.ts';
import {
  loadPluginCatalogFromSocketBus,
  summarizePluginCatalog,
  hasResourceInCatalog,
  summarizePluginRoutingHints,
  planPluginIntentWithLlm,
  buildChatPrompt,
  resolveProbeHosts,
  probeAnyHttpsHost,
  resolveTimeoutMs,
  shouldFailOnProbe,
} from './llm-prompts.ts';
import {
  handleLoadHistory,
  routeToPlaywright,
  routeToExplorer,
  handleUnsafeHostDelegation,
} from './routing.ts';

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
  if (handleLoadHistory({ op, targetMeta })) {
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
    routeToPlaywright({
      message,
      action,
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
      browserResumeRequest,
      browserPolicyFollowUp,
      requestedProfile,
      targetMeta,
      persistConversationState,
      browserThreadContinuation,
    });
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
    const handled = await routeToExplorer({
      message,
      action,
      channel,
      responseFormat,
      lastFilePath,
      lastScopeDir,
      pendingFilesystem,
      channelState,
      filesystemIntent,
      requestedProfile,
      systemContext,
      pluginCatalogSummary,
      conversationSummary,
      lastAssistantQuestion,
      followUpBias,
      persistConversationState,
    });
    if (handled) {
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
    handleUnsafeHostDelegation({
      message,
      targetMeta,
      requestedProfile,
      systemContext,
      persistConversationState,
    });
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
