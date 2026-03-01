import { pluginContext, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  parseTargetMeta,
  toBool,
  shouldUseUnsafeBrowser
} from './playwright-common.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

function normalizeAction(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeDesiredAction(value: unknown, fallback: string): string {
  const action = normalizeAction(value || fallback);
  if (action === 'write' || action === 'act' || action === 'post' || action === 'reply') {
    return 'update';
  }
  if (action === 'discover' || action === 'info' || action === 'inspect') {
    return 'read';
  }
  if (!SUPPORTED_ACTIONS.has(action)) {
    return fallback;
  }
  return action;
}

function isMutationDesiredAction(action: string, targetMeta: Record<string, unknown>): boolean {
  if (action === 'create' || action === 'update' || action === 'delete') {
    return true;
  }
  if (Array.isArray(targetMeta.actions) && targetMeta.actions.length > 0) {
    return true;
  }
  if (Array.isArray(targetMeta.api_attempts) && targetMeta.api_attempts.length > 0) {
    return true;
  }
  const op = normalizeAction(targetMeta.operation || '');
  if (!op) {
    return false;
  }
  return !['discover', 'inspect', 'read', 'info', 'list'].includes(op);
}

function normalizePluginResource(value: unknown, fallback: string, label: string): string {
  const resolved = asOptionalString(value) || fallback;
  if (!resolved.startsWith('plugin:')) {
    fail(`${label} must be a plugin resource (got '${resolved}')`);
  }
  return resolved;
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  const action = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`playwright_agent does not support action '${action}'`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const desiredAction = normalizeDesiredAction(targetMeta.desired_action, action);
  const unsafeBrowser = shouldUseUnsafeBrowser(targetMeta);
  const mutate = isMutationDesiredAction(desiredAction, targetMeta);

  const readResource = normalizePluginResource(
    targetMeta.read_resource,
    'plugin:playwright_read_agent',
    'read_resource'
  );
  const writeResource = normalizePluginResource(
    targetMeta.write_resource,
    'plugin:playwright_write_agent',
    'write_resource'
  );
  const unsafeResource = normalizePluginResource(
    targetMeta.unsafe_resource,
    'plugin:playwright_unsafe_agent',
    'unsafe_resource'
  );

  const delegateTarget: Record<string, unknown> = {
    ...targetMeta,
    desired_action: desiredAction,
    mutate,
    unsafe_browser: unsafeBrowser,
    read_resource: readResource,
    write_resource: writeResource,
    response_format: asOptionalString(targetMeta.response_format) || asOptionalString(request.channel),
    channel: asOptionalString(targetMeta.channel) || asOptionalString(request.channel) || 'default',
    requested_action: action,
    task_summary: asOptionalString(request.summary) || ''
  };
  const delegateRuntime =
    asOptionalString(targetMeta.delegate_runtime) ||
    asOptionalString(targetMeta.runtime) ||
    asOptionalString(request.runtime) ||
    undefined;
  if (delegateRuntime) {
    delegateTarget.delegate_runtime = delegateRuntime;
  }

  const delegateResource = unsafeBrowser ? unsafeResource : readResource;
  const delegateAction = unsafeBrowser
    ? desiredAction
    : mutate
      ? 'read'
      : desiredAction;

  spawnChild(
    {
      summary: asOptionalString(request.summary) || `playwright ${desiredAction}`,
      resource: delegateResource,
      action: delegateAction,
      target: JSON.stringify(delegateTarget),
      runtime: delegateRuntime,
      container_image:
        asOptionalString(targetMeta.container_image) ||
        asOptionalString(request.container_image) ||
        null,
      llm_profile:
        typeof request.llm_profile === 'string' && request.llm_profile.trim()
          ? request.llm_profile.trim()
          : null
    },
    {
      ok: true,
      plugin: 'playwright_agent',
      action,
      desired_action: desiredAction,
      mode: unsafeBrowser ? 'unsafe_browser' : mutate ? 'read_then_write' : 'read_only',
      mutate,
      unsafe_browser: unsafeBrowser,
      read_resource: readResource,
      write_resource: writeResource,
      unsafe_resource: unsafeResource,
      delegated_resource: delegateResource,
      delegated_action: delegateAction
    }
  );
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
