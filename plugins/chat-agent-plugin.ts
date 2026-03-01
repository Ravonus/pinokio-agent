import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

function firstJsonStart(text: string): number {
  const firstObject: number = text.indexOf('{');
  const firstArray: number = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

function parseJsonOutput(raw: unknown): unknown {
  const trimmed: string = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start: number = firstJsonStart(trimmed);
    if (start < 0) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function parseTargetMeta(target: unknown): Record<string, unknown> {
  if (typeof target !== 'string') {
    return {};
  }
  const trimmed: string = target.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.startsWith('{')) {
    return { message: trimmed };
  }
  const parsed: unknown = parseJsonOutput(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function normalizeMessage(summary: unknown, targetMeta: Record<string, unknown>): string {
  const targetMessage: string =
    typeof targetMeta.message === 'string' ? (targetMeta.message as string).trim() : '';
  if (targetMessage) {
    return targetMessage;
  }

  const summaryText: string = typeof summary === 'string' ? summary.trim() : '';
  if (summaryText) {
    return summaryText;
  }

  return 'Hello';
}

function normalizeOptionalString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  const action: string = String(request.action || '').toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`chat_agent plugin does not support action '${action}'`);
  }

  const targetMeta: Record<string, unknown> = parseTargetMeta(request.target);
  const message: string = normalizeMessage(request.summary, targetMeta);
  const requestedProfile: string =
    (typeof targetMeta.profile === 'string' && (targetMeta.profile as string).trim()) ||
    (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
    'codex';
  const systemContext: string =
    typeof targetMeta.system === 'string' ? (targetMeta.system as string).trim() : '';
  const runtime: string =
    normalizeOptionalString(targetMeta.runtime) ||
    normalizeOptionalString(request.runtime);
  const channel: string =
    normalizeOptionalString(targetMeta.channel) ||
    normalizeOptionalString(request.channel);
  const responseFormat: string = normalizeOptionalString(targetMeta.response_format);
  const chatOp: string = normalizeOptionalString(targetMeta.op);
  const mode: string = normalizeOptionalString(targetMeta.mode);
  const command: string = normalizeOptionalString(targetMeta.command);
  const containerNetwork: string =
    normalizeOptionalString(targetMeta.container_network) ||
    normalizeOptionalString(targetMeta.network) ||
    'host';

  const delegateTarget: Record<string, unknown> = {
    message,
    profile: requestedProfile,
    system: systemContext
  };
  if (runtime) {
    delegateTarget.runtime = runtime;
  }
  if (channel) {
    delegateTarget.channel = channel;
  }
  if (responseFormat) {
    delegateTarget.response_format = responseFormat;
  }
  if (mode) {
    delegateTarget.mode = mode;
  }
  if (command) {
    delegateTarget.command = command;
  }
  if (chatOp) {
    delegateTarget.op = chatOp;
  }
  if (typeof targetMeta.limit === 'number' || typeof targetMeta.limit === 'string') {
    delegateTarget.limit = targetMeta.limit;
  }

  respond({
    ok: true,
    plugin: 'chat_agent',
    mode: action === 'create' ? 'spawn_child_chat_session' : 'spawn_child_chat_reply',
    message:
      action === 'create'
        ? 'spawning isolated chat child agent'
        : 'delegating chat reply to isolated child agent',
    spawn_child: {
      summary: message,
      resource: 'plugin:chat_worker_agent',
      action: 'read',
      target: JSON.stringify(delegateTarget),
      runtime: runtime || undefined,
      container_image: null,
      container_network: containerNetwork,
      llm_profile: requestedProfile
    }
  });
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
