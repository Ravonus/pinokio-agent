import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_ACTIONS = new Set(['create', 'read', 'update', 'delete']);

function firstJsonStart(text) {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

function parseJsonOutput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = firstJsonStart(trimmed);
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

function parseTargetMeta(target) {
  if (typeof target !== 'string') {
    return {};
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.startsWith('{')) {
    return { message: trimmed };
  }
  const parsed = parseJsonOutput(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

function normalizeMessage(summary, targetMeta) {
  const targetMessage =
    typeof targetMeta.message === 'string' ? targetMeta.message.trim() : '';
  if (targetMessage) {
    return targetMessage;
  }

  const summaryText = typeof summary === 'string' ? summary.trim() : '';
  if (summaryText) {
    return summaryText;
  }

  return 'Hello';
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

try {
  const { request } = pluginContext();
  const action = String(request.action || '').toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`chat_agent plugin does not support action '${action}'`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const message = normalizeMessage(request.summary, targetMeta);
  const requestedProfile =
    (typeof targetMeta.profile === 'string' && targetMeta.profile.trim()) ||
    (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
    'codex';
	const systemContext =
		typeof targetMeta.system === 'string' ? targetMeta.system.trim() : '';
	const runtime =
		normalizeOptionalString(targetMeta.runtime) ||
		normalizeOptionalString(request.runtime);
  const channel =
    normalizeOptionalString(targetMeta.channel) ||
    normalizeOptionalString(request.channel);
  const responseFormat = normalizeOptionalString(targetMeta.response_format);
  const mode = normalizeOptionalString(targetMeta.mode);
  const command = normalizeOptionalString(targetMeta.command);
  const containerNetwork =
    normalizeOptionalString(targetMeta.container_network) ||
    normalizeOptionalString(targetMeta.network) ||
    'host';

  const delegateTarget = {
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
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
