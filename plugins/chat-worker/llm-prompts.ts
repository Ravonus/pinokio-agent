import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { asOptionalString, toBool, toInt, parseJsonOutput, runChatLlm } from '../plugin-utils.ts';
import type {
  TargetMeta,
  ChatLlmResult,
  ProbeResult,
  PluginCatalog,
  PluginEntry,
  PluginIntentDecision,
  ExplorerTarget,
  ExplorerCall,
  ExplorerPlannerDecision,
  PendingFilesystemState,
  ConversationTurn,
} from './types.ts';
import { EXPLORER_RESOURCE, PLAYWRIGHT_RESOURCE } from './types.ts';
import { normalizePlannerTarget, normalizeExplorerAction } from './explorer-routing.ts';
import { conversationSummaryForPrompt } from './intent-detection.ts';

// ---------------------------------------------------------------------------
// Network probing helpers
// ---------------------------------------------------------------------------

export function resolveProbeHosts(profile: string): string[] {
  const normalized = String(profile || '').trim().toLowerCase();
  if (normalized.includes('claude')) {
    return ['api.anthropic.com', 'claude.ai'];
  }
  if (
    normalized.includes('codex') ||
    normalized.includes('openai') ||
    normalized.includes('chatgpt')
  ) {
    return ['api.openai.com', 'chatgpt.com', 'openai.com'];
  }
  return ['api.openai.com', 'api.anthropic.com', 'openai.com', 'claude.ai'];
}

export function probeHttpsHost(host: string, timeoutMs: number = 5000): Promise<void> {
  const effectiveTimeout = Math.max(1000, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const failProbe = (detail: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${host} -> ${detail}`));
    };
    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const req = https.request(
      { host, method: 'HEAD', path: '/', servername: host },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 100) {
          succeed();
          return;
        }
        failProbe(`unexpected HTTPS status ${String(res.statusCode)}`);
      }
    );
    req.on('error', (error: Error & { code?: string }) => {
      const detail =
        error && typeof error === 'object'
          ? `${String(error.code || 'error')}: ${String(error.message || 'unknown error')}`
          : String(error || 'unknown error');
      failProbe(detail);
    });
    req.setTimeout(effectiveTimeout, () => {
      req.destroy();
      failProbe(`timeout after ${effectiveTimeout}ms`);
    });
    req.end();
  });
}

export async function probeAnyHttpsHost(hosts: string[], timeoutMs: number = 5000, rounds: number = 2): Promise<ProbeResult> {
  const uniqueHosts = Array.from(new Set((hosts || []).filter(Boolean)));
  if (uniqueHosts.length === 0) {
    return { ok: false, host: null, errors: ['no probe hosts configured'] };
  }

  const failures: string[] = [];
  const totalRounds = Math.max(1, Number.parseInt(String(rounds), 10) || 1);
  for (let round = 1; round <= totalRounds; round += 1) {
    for (const host of uniqueHosts) {
      try {
        await probeHttpsHost(host, timeoutMs);
        return { ok: true, host, errors: failures };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`round ${round}: ${detail}`);
      }
    }
  }

  return { ok: false, host: null, errors: failures };
}

// ---------------------------------------------------------------------------
// JSON-lines and socket-bus helpers
// ---------------------------------------------------------------------------

export function parseJsonLinesReverse(raw: unknown, maxLines: number = 64): Record<string, unknown>[] {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
    const parsed = parseJsonOutput(lines[i]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.push(parsed as Record<string, unknown>);
    }
  }
  return out;
}

export function resolveSocketBusPluginsIndexPath(): string | null {
  const busDir = asOptionalString(process.env.PINOKIO_SOCKET_BUS_DIR);
  if (!busDir) {
    return null;
  }
  return path.join(busDir, 'plugins_index.jsonl');
}

// ---------------------------------------------------------------------------
// Plugin catalog helpers
// ---------------------------------------------------------------------------

export function loadPluginCatalogFromSocketBus(): PluginCatalog | null {
  const indexPath = resolveSocketBusPluginsIndexPath();
  if (!indexPath || !fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const candidates = parseJsonLinesReverse(raw, 80);
    for (const candidate of candidates) {
      const directPayload =
        candidate && typeof candidate === 'object' && candidate.schema === 'pinokio.plugins.index/v1'
          ? candidate as PluginCatalog
          : null;
      const envelopePayload =
        candidate &&
        typeof candidate === 'object' &&
        candidate.payload &&
        typeof candidate.payload === 'object' &&
        !Array.isArray(candidate.payload) &&
        (candidate.payload as Record<string, unknown>).schema === 'pinokio.plugins.index/v1'
          ? candidate.payload as PluginCatalog
          : null;
      if (directPayload) {
        return directPayload;
      }
      if (envelopePayload) {
        return envelopePayload;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function summarizePluginCatalog(catalog: PluginCatalog | null): string {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return 'Plugin catalog unavailable in this turn.';
  }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  if (plugins.length === 0) {
    return 'Plugin catalog is available but currently empty.';
  }

  const lines: string[] = [];
  for (const plugin of plugins.slice(0, 20)) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      continue;
    }
    const manifestId = asOptionalString(plugin.manifest_id) || 'unknown';
    const name = asOptionalString(plugin.name) || manifestId;
    const description = asOptionalString(plugin.description) || 'no description';
    const resources = Array.isArray(plugin.resources)
      ? plugin.resources.filter((item: unknown) => typeof item === 'string').slice(0, 6).join(', ')
      : 'none';
    lines.push(`- ${name} (${manifestId}): ${description} [resources: ${resources}]`);
  }

  if (plugins.length > 20) {
    lines.push(`- ...and ${plugins.length - 20} more`);
  }

  return lines.length > 0 ? lines.join('\n') : 'Plugin catalog parsed but no readable entries.';
}

export function hasResourceInCatalog(catalog: PluginCatalog | null, resource: string): boolean {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return false;
  }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const normalizedResource = String(resource || '').trim().toLowerCase();
  if (!normalizedResource) {
    return false;
  }
  return plugins.some((plugin) => {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      return false;
    }
    const resources = Array.isArray(plugin.resources)
      ? plugin.resources.filter((item: unknown) => typeof item === 'string') as string[]
      : [];
    return resources.some((item) => item.trim().toLowerCase() === normalizedResource);
  });
}

export function summarizePluginRoutingHints(catalog: PluginCatalog | null): string {
  const hints: string[] = [];
  if (hasResourceInCatalog(catalog, PLAYWRIGHT_RESOURCE)) {
    hints.push(
      '- Browser/web app tasks (Gmail, Hotmail/Outlook, Twitch, social sites) should route to plugin:playwright_agent.'
    );
    hints.push(
      '- Do not route browser website tasks to Directory Plugin unless the user explicitly asks for local file operations.'
    );
  }
  if (hasResourceInCatalog(catalog, EXPLORER_RESOURCE)) {
    hints.push(
      '- Local host file/folder operations should route to plugin:explorer_agent.'
    );
  }
  return hints.join('\n');
}

// ---------------------------------------------------------------------------
// LLM prompt builders and planners
// ---------------------------------------------------------------------------

export function buildExplorerPlannerPrompt(params: {
  message: string;
  requestedAction: string;
  channel: string;
  responseFormat: string | null;
  systemContext: string;
  pluginCatalogSummary: string;
  defaultScope: string;
  hostDocumentsScope: string;
  hostDesktopScope: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): string {
  const {
    message,
    requestedAction,
    channel,
    responseFormat,
    systemContext,
    pluginCatalogSummary,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope,
    lastFilePath,
    lastScopeDir,
    pendingFilesystem,
    conversationSummary,
    lastAssistantQuestion,
    followUpBias
  } = params;
  const pendingSerialized = pendingFilesystem
    ? JSON.stringify(pendingFilesystem)
    : 'null';
  return [
    'You are the routing/planning brain for Pinokio chat.',
    'Return JSON only. No markdown, no prose outside JSON.',
    'Choose one schema:',
    '{"route":"chat"}',
    '{"route":"explorer","action":"create|read|update|delete","target":{...},"chat_response":"short user-facing plan"}',
    'Or:',
    '{"route":"explorer","needs_clarification":"short question","target":{...}}',
    'Rules:',
    '- Decide whether this is a new request or a follow-up to pending filesystem context.',
    '- If message answers a pending clarification, route=explorer and fill the missing fields.',
    '- Trust-but-verify: if there is pending filesystem context, assume the next user message is a follow-up unless they explicitly start a new topic.',
    '- Do not ask for content if user already provided content.',
    '- If user asks to create a text document on desktop/documents with no filename, generate one automatically.',
    '- Always set target.desired_action.',
    '- Always set target.channel and target.dry_run=false.',
    '- Use absolute host paths under /host/Desktop or /host/Documents when user asks for desktop/documents.',
    '- For creating/updating file contents, include target.content.',
    '- If user says "put inside" or "say", treat that as file content.',
    '- For read/list/search requests, action should be read.',
    '- For directory size/info requests, action should be read and target.desired_action="info".',
    `- Default scopes: desktop=${hostDesktopScope}, documents=${hostDocumentsScope}, fallback=${defaultScope}.`,
    `- Requested chat action: ${requestedAction}.`,
    `- Channel: ${channel}.`,
    `- Response format: ${responseFormat || 'text'}.`,
    `- Last known file path: ${lastFilePath || 'none'}.`,
    `- Last known scope dir: ${lastScopeDir || 'none'}.`,
    `- Pending filesystem state: ${pendingSerialized}.`,
    `- Last assistant follow-up question: ${lastAssistantQuestion || 'none'}.`,
    `- Follow-up bias active: ${followUpBias ? 'yes' : 'no'}.`,
    conversationSummary ? `Recent conversation:\n${conversationSummary}` : '',
    pluginCatalogSummary ? `Plugin catalog context:\n${pluginCatalogSummary}` : '',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function planExplorerCallWithLlm(params: {
  message: string;
  requestedAction: string;
  requestedProfile: string;
  channel: string;
  responseFormat: string | null;
  systemContext: string;
  pluginCatalogSummary: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): Promise<{ route: 'explorer' | 'chat' | null; call: ExplorerCall | null; chatResponse: string | null; needsClarification: string | null; pendingTarget: ExplorerTarget | null }> {
  const {
    message,
    requestedAction,
    requestedProfile,
    channel,
    responseFormat,
    systemContext,
    pluginCatalogSummary,
    lastFilePath,
    lastScopeDir,
    pendingFilesystem,
    conversationSummary,
    lastAssistantQuestion,
    followUpBias
  } = params;
  const lower = String(message || '').toLowerCase();
  const defaultScope = asOptionalString(process.env.PINOKIO_EXPLORER_SCOPE) || '/app';
  const hostDocumentsScope = asOptionalString(process.env.PINOKIO_HOST_DOCUMENTS_SCOPE) || defaultScope;
  const hostDesktopScope = asOptionalString(process.env.PINOKIO_HOST_DESKTOP_SCOPE) || '/host/Desktop';
  const plannerPrompt = buildExplorerPlannerPrompt({
    message,
    requestedAction,
    channel,
    responseFormat,
    systemContext,
    pluginCatalogSummary,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope,
    lastFilePath,
    lastScopeDir,
    pendingFilesystem,
    conversationSummary,
    lastAssistantQuestion,
    followUpBias
  });

  try {
    const plan = runChatLlm({
      profile: requestedProfile,
      prompt: plannerPrompt,
      timeoutMs: Math.min(resolveTimeoutMs(), 15000)
    });
    const parsed = parseJsonOutput(plan.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { route: null, call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
    }

    const decision = parsed as ExplorerPlannerDecision;
    const route = asOptionalString(decision.route)?.toLowerCase();
    if (route === 'chat') {
      return { route: 'chat', call: null, chatResponse: asOptionalString(decision.chat_response), needsClarification: null, pendingTarget: null };
    }
    const normalizedRoute: 'explorer' | 'chat' | null = route === 'explorer' ? 'explorer' : null;
    const needsClarification = asOptionalString(decision.needs_clarification);
    if (needsClarification) {
      const pendingTarget = normalizePlannerTarget(
        decision.target,
        normalizeExplorerAction(decision.action) || normalizeExplorerAction(requestedAction) || 'read',
        channel,
        responseFormat,
        message,
        lastFilePath
      );
      return {
        route: normalizedRoute || 'explorer',
        call: null,
        chatResponse: asOptionalString(decision.chat_response),
        needsClarification,
        pendingTarget: pendingTarget || null
      };
    }

    const action = normalizeExplorerAction(decision.action);
    if (!action) {
      return { route: normalizedRoute, call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
    }
    const target = normalizePlannerTarget(
      decision.target,
      action,
      channel,
      responseFormat,
      message,
      lastFilePath
    );
    if (!target) {
      return { route: normalizedRoute || 'explorer', call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
    }

    // Keep planner target sane if it omitted scope for common user intents.
    if (!target.scope_dir) {
      if (lower.includes('desktop')) {
        target.scope_dir = hostDesktopScope;
      } else if (lower.includes('documents')) {
        target.scope_dir = hostDocumentsScope;
      } else {
        target.scope_dir = defaultScope;
      }
    }

    return {
      route: normalizedRoute || 'explorer',
      call: { action, target },
      chatResponse: asOptionalString(decision.chat_response),
      needsClarification: null,
      pendingTarget: null
    };
  } catch {
    return { route: null, call: null, chatResponse: null, needsClarification: null, pendingTarget: null };
  }
}

export function buildChatPrompt(
  message: string,
  systemContext: string,
  pluginCatalogSummary: string,
  pluginRoutingHints: string,
  conversationSummary: string,
  lastAssistantQuestion: string | null,
  followUpBias: boolean
): string {
  const blocks: string[] = [
    'You are a dedicated plugin-first chat coordinator for Pinokio.',
    'Reply directly to the user in a concise, practical style.',
    'Always evaluate available plugins/systems before saying you cannot do something.',
    'If a request maps to an installed plugin, propose using that plugin path first.',
    'For filesystem requests, prefer Directory Plugin (plugin:explorer_agent) via manager flow.',
    'For browser/webapp tasks (Hotmail/Outlook/Gmail/Twitch/social sites), prefer Playwright Plugin (plugin:playwright_agent), not Directory Plugin.',
    'For message/post cleanup tasks, first discover and summarize organization options and junk candidates, then ask the user to confirm policy before destructive actions.',
    'Never claim "no access" until you checked plugin context below.',
    'Do not mention MCP server requirements for built-in plugins in this system.',
    'Do not run shell commands yourself.',
    'Trust-but-verify follow-up behavior: when a follow-up question is pending, assume next user turn is the follow-up unless the user clearly starts a new topic.',
    'Return only the chat reply text.',
    `Follow-up bias active: ${followUpBias ? 'yes' : 'no'}.`,
    `Last assistant follow-up question: ${lastAssistantQuestion || 'none'}.`,
    conversationSummary ? `Recent conversation:\n${conversationSummary}` : '',
    pluginRoutingHints ? `Routing hints:\n${pluginRoutingHints}` : '',
    pluginCatalogSummary ? `Plugin catalog context:\n${pluginCatalogSummary}` : '',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ];
  return blocks.filter(Boolean).join('\n\n');
}

export function buildPluginIntentPrompt(params: {
  message: string;
  systemContext: string;
  pluginCatalogSummary: string;
  pluginRoutingHints: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): string {
  const pendingSerialized = params.pendingFilesystem
    ? JSON.stringify(params.pendingFilesystem)
    : 'null';
  return [
    'You are a plugin routing arbiter for Pinokio chat.',
    'Return strict JSON only.',
    'Schema:',
    '{"resource":"plugin:playwright_agent|plugin:explorer_agent|chat","confidence":"high|medium|low","reason":"short"}',
    'Rules:',
    '- Use language nuance from the user message.',
    '- Browser/web account tasks (Outlook/Hotmail, Gmail, Twitch, websites, social media) => plugin:playwright_agent.',
    '- Requests to go through messages/posts or cleanup inbox/mailbox/social queues should route to plugin:playwright_agent (discovery first, policy clarification before mutation).',
    '- Local filesystem tasks (files/folders/path/rename/delete/move/create/list) => plugin:explorer_agent.',
    '- If the user asks for a plan that is clearly tied to a specific web account/workflow, still choose plugin:playwright_agent.',
    '- Use chat only for purely conceptual conversation not tied to any executable plugin workflow.',
    '- Respect negations (example: "not folders", "dont use explorer").',
    '- Prefer nuanced intent over keyword matching.',
    '- Trust-but-verify: if follow-up bias is active, assume this message continues the current conversation unless there is explicit new-topic intent.',
    '- Choose one resource only.',
    `Follow-up bias active: ${params.followUpBias ? 'yes' : 'no'}.`,
    `Last assistant follow-up question: ${params.lastAssistantQuestion || 'none'}.`,
    params.conversationSummary ? `Recent conversation:\n${params.conversationSummary}` : '',
    params.pluginRoutingHints ? `Routing hints:\n${params.pluginRoutingHints}` : '',
    params.pluginCatalogSummary ? `Plugin catalog context:\n${params.pluginCatalogSummary}` : '',
    params.systemContext ? `System context:\n${params.systemContext}` : '',
    `Last known file path: ${params.lastFilePath || 'none'}`,
    `Last known scope dir: ${params.lastScopeDir || 'none'}`,
    `Pending filesystem state: ${pendingSerialized}`,
    `User message:\n${params.message}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function planPluginIntentWithLlm(params: {
  message: string;
  requestedProfile: string;
  systemContext: string;
  pluginCatalogSummary: string;
  pluginRoutingHints: string;
  lastFilePath: string | null;
  lastScopeDir: string | null;
  pendingFilesystem: PendingFilesystemState | null;
  conversationSummary: string;
  lastAssistantQuestion: string | null;
  followUpBias: boolean;
}): Promise<PluginIntentDecision | null> {
  const prompt = buildPluginIntentPrompt({
    message: params.message,
    systemContext: params.systemContext,
    pluginCatalogSummary: params.pluginCatalogSummary,
    pluginRoutingHints: params.pluginRoutingHints,
    lastFilePath: params.lastFilePath,
    lastScopeDir: params.lastScopeDir,
    pendingFilesystem: params.pendingFilesystem,
    conversationSummary: params.conversationSummary,
    lastAssistantQuestion: params.lastAssistantQuestion,
    followUpBias: params.followUpBias
  });
  try {
    const plan = runChatLlm({
      profile: params.requestedProfile,
      prompt,
      timeoutMs: Math.min(resolveTimeoutMs(), 10000)
    });
    const parsed = parseJsonOutput(plan.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const rawResource = asOptionalString(row.resource)?.toLowerCase() || 'chat';
    const resource: PluginIntentDecision['resource'] =
      rawResource === PLAYWRIGHT_RESOURCE
        ? PLAYWRIGHT_RESOURCE
        : rawResource === EXPLORER_RESOURCE
          ? EXPLORER_RESOURCE
          : rawResource === 'chat'
            ? 'chat'
            : null;
    if (!resource) {
      return null;
    }
    const rawConfidence = asOptionalString(row.confidence)?.toLowerCase();
    const confidence: PluginIntentDecision['confidence'] =
      rawConfidence === 'high' || rawConfidence === 'medium' || rawConfidence === 'low'
        ? rawConfidence
        : 'low';
    return {
      resource,
      confidence,
      reason: asOptionalString(row.reason)
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

export function resolveTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.PINOKIO_CHAT_LLM_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 10000) {
    return Math.min(raw, 600000);
  }
  return 240000;
}

export function shouldFailOnProbe(): boolean {
  const raw = String(process.env.PINOKIO_STRICT_EGRESS_PROBE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}
