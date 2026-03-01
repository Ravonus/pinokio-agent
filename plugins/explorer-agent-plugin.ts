import { pluginContext, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);
const SUPPORTED_READ_DESIRED_ACTIONS: Set<string> = new Set(['read', 'info']);

function normalizeAction(value: unknown): string {
  return String(value || '').trim().toLowerCase();
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
    return { query: trimmed };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return { query: trimmed };
  }
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePluginResource(value: unknown, fallback: string, label: string): string {
  const resolved: string = asOptionalString(value) || fallback;
  if (!resolved.startsWith('plugin:')) {
    fail(`${label} must be a plugin resource (got '${resolved}')`);
  }
  return resolved;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n: number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}

function buildSummary(action: string): string {
  if (action === 'read') {
    return 'explorer discovery request';
  }
  return 'explorer mutation discovery request';
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  const action: string = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`explorer_agent does not support action '${action}'`);
  }

  const targetMeta: Record<string, unknown> = parseTargetMeta(request.target);
  const targetAction: string | null = asOptionalString(targetMeta.action);
  if (targetAction && normalizeAction(targetAction) !== action) {
    fail('target.action override is not allowed for explorer router');
  }
  const desiredActionOverride: string = normalizeAction(
    asOptionalString(targetMeta.desired_action) || ''
  );
  const desiredAction: string =
    action === 'read'
      ? desiredActionOverride || 'read'
      : action;
  if (action === 'read' && !SUPPORTED_READ_DESIRED_ACTIONS.has(desiredAction)) {
    fail(
      `explorer read desired_action must be one of ${Array.from(SUPPORTED_READ_DESIRED_ACTIONS).join('|')} (got '${desiredAction}')`
    );
  }
  if (action !== 'read' && desiredActionOverride && desiredActionOverride !== action) {
    fail(`desired_action override '${desiredActionOverride}' does not match action '${action}'`);
  }

  const readResource: string = normalizePluginResource(
    targetMeta.read_resource,
    'plugin:explorer_read_agent',
    'read_resource'
  );
  const writeResource: string = normalizePluginResource(
    targetMeta.write_resource,
    'plugin:explorer_write_agent',
    'write_resource'
  );

  const scopeDir: string | null = asOptionalString(targetMeta.scope_dir || targetMeta.scope);
  const pathHint: string | null = asOptionalString(targetMeta.path);
  const query: string | null = asOptionalString(targetMeta.query);

  const readTarget: Record<string, unknown> = {
    scope_dir: scopeDir,
    path: pathHint,
    query,
    channel: asOptionalString(targetMeta.channel),
    response_format: asOptionalString(targetMeta.response_format),
    desired_action: desiredAction,
    mutate: desiredAction !== 'read' && desiredAction !== 'info',
    write_resource: writeResource,
    operation: asOptionalString(targetMeta.operation),
    script:
      targetMeta.script && typeof targetMeta.script === 'object' && !Array.isArray(targetMeta.script)
        ? targetMeta.script
        : Array.isArray(targetMeta.script)
          ? { steps: targetMeta.script }
          : asOptionalString(targetMeta.script),
    require_handoff_matches:
      typeof targetMeta.require_handoff_matches === 'boolean'
        ? targetMeta.require_handoff_matches
        : null,
    extensions: Array.isArray(targetMeta.extensions)
      ? (targetMeta.extensions as unknown[]).filter((value: unknown): value is string => typeof value === 'string')
      : asOptionalString(targetMeta.extensions),
    cleanup_profile: asOptionalString(targetMeta.cleanup_profile),
    min_size_bytes:
      Number.isFinite(Number(targetMeta.min_size_bytes)) && Number(targetMeta.min_size_bytes) > 0
        ? Number(targetMeta.min_size_bytes)
        : null,
    archive_destination: asOptionalString(targetMeta.archive_destination),
    delete_source: targetMeta.delete_source === true,
    kind: asOptionalString(targetMeta.kind),
    content: typeof targetMeta.content === 'string' ? targetMeta.content : null,
    overwrite: targetMeta.overwrite === true,
    ensure_parent: targetMeta.ensure_parent === false ? false : true,
    new_name: asOptionalString(targetMeta.new_name),
    destination: asOptionalString(targetMeta.destination),
    recursive: targetMeta.recursive === false ? false : true,
    recursive_read: targetMeta.recursive_read === true,
    dry_run: targetMeta.dry_run === true,
    limit: toInt(targetMeta.limit, 200, 1, 5000)
  };

  spawnChild(
    {
      summary: buildSummary(action),
      resource: readResource,
      action: 'read',
      target: JSON.stringify(readTarget),
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
      plugin: 'explorer_agent',
      action,
      desired_action: desiredAction,
      mode:
        desiredAction === 'read' || desiredAction === 'info'
          ? 'read_only'
          : 'read_then_write',
      read_resource: readResource,
      write_resource: writeResource
    }
  );
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
