/**
 * Extracted routing functions from the chat-worker main IIFE.
 *
 * Each function encapsulates a major routing branch and returns a boolean
 * indicating whether it handled the request (true = caller should stop).
 */

import path from 'node:path';
import { respond, spawnChild, fail } from '../../../sdk/typescript/pinokio-sdk.ts';
import {
  ensureChatSchema,
  listSessions,
  getSessionMessages,
} from '../../../sdk/typescript/chat-db.ts';
import { asOptionalString, toBool } from '../../plugin-utils.ts';
import type {
  ChatChannelState,
  ExplorerTarget,
  ExplorerCall,
  ChatDbMeta,
  PendingFilesystemState,
  BrowserWorkflowState,
} from './types.ts';
import { EXPLORER_RESOURCE, PLAYWRIGHT_RESOURCE } from './types.ts';
import {
  normalizeCrudAction,
  normalizeBrowserWorkflowState,
  isActiveBrowserWorkflowState,
  eventForBrowserWorkflowState,
  buildPlaywrightCallFromMessage,
} from './browser-workflow.ts';
import {
  buildExplorerTargetFromMessage,
  buildExplorerCallFromPending,
  chooseHeuristicExplorerRoute,
  shouldPreferFallbackExplorerCall,
  enforcePriorFileWriteCall,
  normalizeExplorerAction,
  resolveNextLastFilePath,
} from './explorer-routing.ts';
import {
  isMutationAction,
  isExplicitPriorFileWriteIntent,
} from './intent-detection.ts';
import {
  planExplorerCallWithLlm,
} from './llm-prompts.ts';
import {
  shouldUseChatDb,
  resolveChatDbConnectionWithTimeout,
  loadChannelState,
  normalizeConversation,
} from './channel-state.ts';

/* ------------------------------------------------------------------ */
/*  Shared types for routing function parameters                       */
/* ------------------------------------------------------------------ */

/** Callback type matching the persistConversationState closure in index.ts. */
export type PersistConversationStateFn = (
  assistantText: string | null,
  patch?: Partial<ChatChannelState>,
  dbMeta?: ChatDbMeta
) => void;

/* ------------------------------------------------------------------ */
/*  1. handleLoadHistory                                                */
/* ------------------------------------------------------------------ */

/**
 * Handle the `load_history` chat operation.
 *
 * Reads conversation history from the chat database (preferred) or
 * filesystem state (fallback) and responds with it.
 *
 * @returns true if this function handled the request (caller should return).
 */
export function handleLoadHistory(params: {
  op: string;
  targetMeta: Record<string, unknown>;
}): boolean {
  const { op, targetMeta } = params;
  if (op !== 'load_history') {
    return false;
  }

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
        return true;
      }
    }
    // No DB sessions (or DB disabled) -- try filesystem state
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
    // DB failed -- fall back to filesystem
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

  return true;
}

/* ------------------------------------------------------------------ */
/*  2. routeToPlaywright                                                */
/* ------------------------------------------------------------------ */

/**
 * Build a Playwright call from the user message and spawn a child process
 * to the playwright_read_agent resource.
 *
 * @returns true if this function handled the request (caller should return).
 */
export function routeToPlaywright(params: {
  message: string;
  action: string;
  channel: string;
  responseFormat: string | null;
  lastBrowserUrl: string | null;
  lastBrowserRuntime: string | null;
  lastBrowserDesiredAction: string | null;
  lastBrowserCleanupIntent: boolean;
  lastBrowserPolicyNeeded: boolean;
  lastBrowserWorkflowState: BrowserWorkflowState;
  browserSkillExportRequest: boolean;
  browserSkillName: string | null;
  browserResumeRequest: boolean;
  browserPolicyFollowUp: boolean;
  requestedProfile: string;
  targetMeta: Record<string, unknown>;
  persistConversationState: PersistConversationStateFn;
  browserThreadContinuation: boolean;
}): boolean {
  const {
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
  } = params;

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
      isActiveBrowserWorkflowState(lastBrowserWorkflowState),
  });

  const playwrightRuntime =
    asOptionalString(playwrightCall.target.delegate_runtime) ??
    asOptionalString(playwrightCall.target.runtime) ??
    undefined;
  const routedUrl = asOptionalString(playwrightCall.target.url);
  const routedCleanupIntent =
    toBool(playwrightCall.target.cleanup_intent, lastBrowserCleanupIntent) ||
    (browserThreadContinuation && lastBrowserCleanupIntent);
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
    last_browser_workflow_state: normalizeBrowserWorkflowState(
      playwrightCall.target.workflow_state
    ),
    last_browser_workflow_event: eventForBrowserWorkflowState(
      normalizeBrowserWorkflowState(playwrightCall.target.workflow_state)
    ),
    last_browser_last_transition: 'route:playwright',
    last_browser_pending_step:
      asOptionalString(targetMeta.browser_pending_step_hint) || undefined,
    last_browser_last_error:
      asOptionalString(targetMeta.browser_last_error_hint) || undefined,
    last_browser_workflow_updated_at: new Date().toISOString(),
  }, {
    response_mode: 'plugin_first_playwright',
    routed_resource: PLAYWRIGHT_RESOURCE,
    routed_action: playwrightCall.action,
    llm_profile: requestedProfile,
  });

  spawnChild(
    {
      summary: `browser request: ${message}`,
      resource: PLAYWRIGHT_RESOURCE,
      action: playwrightCall.action,
      target: JSON.stringify(playwrightCall.target),
      container_image: null,
      llm_profile: requestedProfile,
    },
    {
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'plugin_first_playwright',
      runtime: 'container',
      routed_resource: PLAYWRIGHT_RESOURCE,
      routed_action: playwrightCall.action,
      routed_target: playwrightCall.target,
      chat_response: playwrightChatResponse,
    }
  );

  return true;
}

/* ------------------------------------------------------------------ */
/*  3. routeToExplorer                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build an explorer/directory call from the user message (using heuristics
 * and/or LLM planning) and spawn a child process to the explorer_agent.
 *
 * Handles clarification prompts when more information is needed.
 *
 * @returns true if this function handled the request (caller should return).
 */
export async function routeToExplorer(params: {
  message: string;
  action: string;
  channel: string;
  responseFormat: string | null;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  channelState: ChatChannelState | null;
  filesystemIntent: boolean;
  requestedProfile: string;
  systemContext: string;
  pluginCatalogSummary: string;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
  persistConversationState: PersistConversationStateFn;
}): Promise<boolean> {
  const {
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
  } = params;

  const fallbackExplorerCall = buildExplorerTargetFromMessage(message, action, {
    channel,
    response_format: responseFormat ?? undefined,
    last_file_path: lastFilePath ?? undefined,
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
    lastFilePath,
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
          followUpBias,
        })
      : {
          route: null as 'explorer' | 'chat' | null,
          call: null as ExplorerCall | null,
          chatResponse: null as string | null,
          needsClarification: null as string | null,
          pendingTarget: null as ExplorerTarget | null,
        };

  const shouldRouteExplorer =
    heuristicRoute.confidence === 'high'
      ? heuristicRoute.should_route
      : Boolean(heuristicRoute.call) ||
        Boolean(llmPlan.call) ||
        llmPlan.route === 'explorer' ||
        (heuristicRoute.should_route && llmPlan.route !== 'chat');

  if (!shouldRouteExplorer) {
    // Explorer routing decided not to handle -- let caller continue.
    return false;
  }

  // Clarification needed and no call available
  if (
    llmPlan.needsClarification &&
    !llmPlan.call &&
    !pendingExplorerCall &&
    !fallbackExplorerCall
  ) {
    const pendingAction =
      normalizeExplorerAction(
        llmPlan.pendingTarget?.desired_action || pendingFilesystem?.action || action
      ) || 'read';
    const pendingTarget: ExplorerTarget = {
      ...(pendingFilesystem?.target || {}),
      ...(llmPlan.pendingTarget || {}),
      channel,
      dry_run: false,
    };
    persistConversationState(llmPlan.needsClarification, {
      pending_filesystem: {
        action: pendingAction,
        target: pendingTarget,
        question: llmPlan.needsClarification,
        requested_at: new Date().toISOString(),
      },
      last_browser_workflow_state: 'idle',
      last_browser_workflow_updated_at: new Date().toISOString(),
    }, { response_mode: 'plugin_filesystem_needs_details' });
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'plugin_filesystem_needs_details',
      runtime: 'container',
      chat_response: llmPlan.needsClarification,
    });
    return true;
  }

  let usedLlmPlan = Boolean(llmPlan.call);
  let explorerCall = llmPlan.call || heuristicRoute.call;
  if (
    llmPlan.call &&
    shouldPreferFallbackExplorerCall({
      llmCall: llmPlan.call,
      fallbackCall: heuristicRoute.call,
      message,
      lastFilePath,
    })
  ) {
    explorerCall = heuristicRoute.call;
    usedLlmPlan = false;
  }

  if (explorerCall) {
    explorerCall = enforcePriorFileWriteCall(explorerCall, message, lastFilePath);
    const routedPath = asOptionalString(explorerCall.target.path);

    // Mutation without a path -> ask for clarification
    if (isMutationAction(explorerCall.action) && !routedPath) {
      const clarification = /\brename\b/i.test(String(message || ''))
        ? 'Which file should I rename? You can give a full path or say "rename that file to <name>".'
        : 'Which file/path should I apply this change to?';
      persistConversationState(clarification, {
        pending_filesystem: {
          action: explorerCall.action,
          target: explorerCall.target,
          question: clarification,
          requested_at: new Date().toISOString(),
        },
        last_browser_workflow_state: 'idle',
        last_browser_workflow_updated_at: new Date().toISOString(),
      }, { response_mode: 'plugin_filesystem_needs_details' });
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'plugin_filesystem_needs_details',
        runtime: 'container',
        chat_response: clarification,
      });
      return true;
    }

    // Explicit file-write intent without content -> ask for content
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
          requested_at: new Date().toISOString(),
        },
        last_browser_workflow_state: 'idle',
        last_browser_workflow_updated_at: new Date().toISOString(),
      }, { response_mode: 'plugin_filesystem_needs_details' });
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'plugin_filesystem_needs_details',
        runtime: 'container',
        chat_response: clarification,
      });
      return true;
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
      last_browser_workflow_updated_at: new Date().toISOString(),
    }, {
      response_mode: usedLlmPlan
        ? 'plugin_first_directory_llm'
        : 'plugin_first_directory',
      routed_resource: EXPLORER_RESOURCE,
      routed_action: explorerCall.action,
      llm_profile: requestedProfile,
    });
    spawnChild(
      {
        summary: `directory request: ${message}`,
        resource: EXPLORER_RESOURCE,
        action: explorerCall.action,
        target: JSON.stringify(explorerCall.target),
        container_image: null,
        llm_profile: requestedProfile,
      },
      {
        ok: true,
        plugin: 'chat_worker_agent',
        mode: usedLlmPlan ? 'plugin_first_directory_llm' : 'plugin_first_directory',
        runtime: 'container',
        routed_resource: EXPLORER_RESOURCE,
        routed_action: explorerCall.action,
        routed_target: explorerCall.target,
        chat_response: directoryChatResponse,
      }
    );
    return true;
  }

  // No concrete call could be built -- ask for details
  const clarification =
    llmPlan.needsClarification ||
    'I can run that through Directory Plugin, but I need a concrete target path or filename (and content for file creation when needed).';
  persistConversationState(clarification, {
    pending_filesystem: {
      action: normalizeExplorerAction(action) || 'read',
      target: pendingFilesystem?.target || llmPlan.pendingTarget || undefined,
      question: clarification,
      requested_at: new Date().toISOString(),
    },
    last_browser_workflow_state: 'idle',
    last_browser_workflow_updated_at: new Date().toISOString(),
  }, { response_mode: 'plugin_filesystem_needs_details' });
  respond({
    ok: true,
    plugin: 'chat_worker_agent',
    mode: 'plugin_filesystem_needs_details',
    runtime: 'container',
    chat_response: clarification,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/*  4. handleUnsafeHostDelegation                                       */
/* ------------------------------------------------------------------ */

/**
 * Delegate the request to the unsafe_host_agent via spawnChild.
 *
 * @returns true (always handles the request when called).
 */
export function handleUnsafeHostDelegation(params: {
  message: string;
  targetMeta: Record<string, unknown>;
  requestedProfile: string;
  systemContext: string;
  persistConversationState: PersistConversationStateFn;
}): boolean {
  const { message, targetMeta, requestedProfile, systemContext, persistConversationState } = params;

  const mode =
    typeof targetMeta.mode === 'string' &&
    (targetMeta.mode as string).trim().toLowerCase() === 'command'
      ? 'command'
      : 'llm';
  const delegateTarget: Record<string, unknown> = {
    mode,
    message,
    profile: requestedProfile,
    system: systemContext,
  };
  if (mode === 'command') {
    const command =
      typeof targetMeta.command === 'string'
        ? (targetMeta.command as string).trim()
        : '';
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
    last_browser_workflow_updated_at: new Date().toISOString(),
  }, { response_mode: 'spawn_child_unsafe_host' });

  spawnChild(
    {
      summary: message,
      resource: 'plugin:unsafe_host_agent',
      action: 'read',
      target: JSON.stringify(delegateTarget),
      container_image: null,
      llm_profile: requestedProfile,
    },
    {
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'spawn_child_unsafe_host',
      runtime: 'unsafe_host',
      chat_response: unsafeHostResponse,
    }
  );

  return true;
}
