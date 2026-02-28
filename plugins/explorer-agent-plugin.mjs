import { pluginContext, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_ACTIONS = new Set(['create', 'read', 'update', 'delete']);
const SUPPORTED_READ_DESIRED_ACTIONS = new Set(['read', 'info']);

function normalizeAction(value) {
  return String(value || '').trim().toLowerCase();
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
    return { query: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return { query: trimmed };
  }
}

function asOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePluginResource(value, fallback, label) {
  const resolved = asOptionalString(value) || fallback;
  if (!resolved.startsWith('plugin:')) {
    fail(`${label} must be a plugin resource (got '${resolved}')`);
  }
  return resolved;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}

function buildSummary(action) {
  if (action === 'read') {
    return 'explorer discovery request';
  }
  return 'explorer mutation discovery request';
}

try {
  const { request } = pluginContext();
  const action = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`explorer_agent does not support action '${action}'`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const targetAction = asOptionalString(targetMeta.action);
  if (targetAction && normalizeAction(targetAction) !== action) {
    fail('target.action override is not allowed for explorer router');
  }
  const desiredActionOverride = normalizeAction(
    asOptionalString(targetMeta.desired_action) || ''
  );
  const desiredAction =
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

  const readResource = normalizePluginResource(
    targetMeta.read_resource,
    'plugin:explorer_read_agent',
    'read_resource'
  );
  const writeResource = normalizePluginResource(
    targetMeta.write_resource,
    'plugin:explorer_write_agent',
    'write_resource'
  );

  const scopeDir = asOptionalString(targetMeta.scope_dir || targetMeta.scope);
  const pathHint = asOptionalString(targetMeta.path);
  const query = asOptionalString(targetMeta.query);

  const readTarget = {
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
      ? targetMeta.extensions.filter((value) => typeof value === 'string')
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
      summary: buildSummary(action, request.summary),
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
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
