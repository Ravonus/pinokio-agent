import path from 'node:path';
import { pluginContext, respond, spawnChild, fail } from '../../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../../sdk/typescript/pinokio-sdk.ts';
import { asOptionalString, normalizeAction } from '../plugin-utils.ts';
import {
  type TargetMeta,
  DEFAULT_SCOPE_DIR,
  SCRIPT_MUTATION_OPERATIONS,
  normalizeScriptOperation,
  toPositiveInt,
  ensureDirectory,
  ensureInsideScope
} from './shared.ts';
import {
  type PathDescription,
  type MatchEntry,
  type ScriptMeta,
  type SocketChannels,
  type InfoPayload,
  type FilePreviewBlock,
  resolvePathHint,
  describePath,
  findMatches,
  parseExtensionsFromTarget,
  parseMinSizeBytes,
  shouldEmitUiBlocks,
  buildReadSummary,
  buildMutationSummary,
  buildScriptSummary,
  buildInfoSummary,
  buildFilePreviewBlock,
  buildInfoPayload,
  selectScriptCandidates
} from './read-helpers.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['read']);
const READ_DESIRED_ACTIONS: Set<string> = new Set(['read', 'info']);
const MUTATION_DESIRED_ACTIONS: Set<string> = new Set(['create', 'update', 'delete']);
const DEFAULT_LIMIT: number = 200;
const MAX_LIMIT: number = 5000;
const DEFAULT_CHANNEL: string = 'default';

function parseTargetMeta(target: unknown): TargetMeta {
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
      return parsed as TargetMeta;
    }
  } catch {
    return { query: trimmed };
  }
  return {};
}

function normalizeChannel(value: unknown): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_CHANNEL;
}

function normalizePluginResource(value: unknown, fallback: string, label: string): string {
  const resolved = asOptionalString(value) || fallback;
  if (!resolved.startsWith('plugin:')) {
    fail(`${label} must be a plugin resource (got '${resolved}')`);
  }
  return resolved;
}

function resolveDesiredPath(desiredAction: string, explicitCandidate: PathDescription | null, matches: MatchEntry[]): string | null {
  if (desiredAction === 'create') {
    if (explicitCandidate?.path) {
      return explicitCandidate.path;
    }
    return null;
  }

  if (explicitCandidate?.exists) {
    return explicitCandidate.path;
  }

  if (matches.length === 1 && matches[0].exists) {
    return matches[0].path;
  }

  return null;
}

function deriveMutateFlag(targetMeta: TargetMeta, desiredAction: string): boolean {
  if (targetMeta.mutate === true) {
    return true;
  }
  return MUTATION_DESIRED_ACTIONS.has(desiredAction);
}

function sanitizeChannelToken(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function deriveSocketChannels(request: PluginRequest, targetMeta: TargetMeta): SocketChannels {
  const globalChannel =
    asOptionalString(targetMeta.socket_global_channel) ||
    asOptionalString(process.env.PINOKIO_SOCKET_GLOBAL_CHANNEL) ||
    'global';
  const personalChannel =
    asOptionalString(targetMeta.socket_personal_channel) ||
    asOptionalString(process.env.PINOKIO_SOCKET_PERSONAL_CHANNEL);
  const sessionSeed =
    asOptionalString(targetMeta.socket_session) ||
    asOptionalString(targetMeta.session_channel) ||
    asOptionalString(request.id as string) ||
    `${Date.now()}`;
  const sessionChannel =
    asOptionalString(targetMeta.socket_channel) ||
    `explorer:${sanitizeChannelToken(sessionSeed, 'session')}`;
  const publishChannels = Array.from(
    new Set([globalChannel, sessionChannel, personalChannel].filter(Boolean) as string[])
  );
  return {
    global_channel: globalChannel,
    personal_channel: personalChannel,
    session_channel: sessionChannel,
    publish_channels: publishChannels
  };
}

try {
  const { request } = pluginContext();
  const action = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`explorer_read_agent only supports action 'read' (got '${action}')`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const desiredAction = normalizeAction(targetMeta.desired_action || 'read');
  if (!READ_DESIRED_ACTIONS.has(desiredAction) && !MUTATION_DESIRED_ACTIONS.has(desiredAction)) {
    fail(`unsupported desired_action '${desiredAction}'`);
  }
  const operation = normalizeScriptOperation(targetMeta.operation || '');
  const scriptOperation = SCRIPT_MUTATION_OPERATIONS.has(operation);
  const responseFormat = asOptionalString(targetMeta.response_format);
  const channel = normalizeChannel(targetMeta.channel);

  const scopeDir = path.resolve(asOptionalString(targetMeta.scope_dir) || DEFAULT_SCOPE_DIR);
  ensureDirectory(scopeDir, 'scope_dir');

  const explicitLimit = toPositiveInt(targetMeta.limit);
  const limit = explicitLimit
    ? Math.min(Math.max(explicitLimit, 1), MAX_LIMIT)
    : scriptOperation
      ? MAX_LIMIT
      : DEFAULT_LIMIT;
  const explicitPath = resolvePathHint(scopeDir, targetMeta.path);
  const explicitCandidate = explicitPath ? describePath(explicitPath, scopeDir) : null;

  const query = asOptionalString(targetMeta.query);
  const recursiveRead =
    targetMeta.recursive_read === true ||
    targetMeta.recursive === true ||
    Boolean(query) ||
    desiredAction === 'info' ||
    scriptOperation;

  let matches: MatchEntry[] = [];
  if (explicitCandidate) {
    matches.push(explicitCandidate as MatchEntry);
  } else {
    matches = findMatches(scopeDir, query, limit, recursiveRead);
  }

  let info: InfoPayload | null = null;
  if (desiredAction === 'info') {
    let infoTargetPath = explicitPath;
    if (!infoTargetPath) {
      if (matches.length === 1 && matches[0].path) {
        infoTargetPath = ensureInsideScope(scopeDir, matches[0].path);
      } else {
        infoTargetPath = scopeDir;
      }
    }
    info = buildInfoPayload(scopeDir, infoTargetPath);
    if (!explicitPath && info?.entries && info.entries.length > 0) {
      matches = info.entries as MatchEntry[];
    }
  }

  let scriptMeta: ScriptMeta | null = null;
  if (scriptOperation) {
    const scriptSelection = selectScriptCandidates(operation, matches, targetMeta);
    matches = scriptSelection.matches;
    scriptMeta = scriptSelection.script_meta;
  }

  const mutate = deriveMutateFlag(targetMeta, desiredAction);
  const resolvedPath = resolveDesiredPath(desiredAction, explicitCandidate, matches);
  const existingFileCreateWithContent =
    desiredAction === 'create' &&
    !scriptOperation &&
    typeof targetMeta.content === 'string' &&
    Boolean(resolvedPath) &&
    matches.some(
      (entry) => entry.path === resolvedPath && entry.exists === true && entry.kind === 'file'
    );
  const routedDesiredAction = existingFileCreateWithContent ? 'update' : desiredAction;
  const routedOperation =
    existingFileCreateWithContent && !operation ? 'write' : operation || null;

  if (mutate && !scriptOperation && desiredAction !== 'create' && !resolvedPath) {
    if (matches.length > 1) {
      fail(
        `mutation target is ambiguous (${matches.length} matches). Provide target.path for ${desiredAction}.`
      );
    }
    fail(`mutation target not found for ${desiredAction}. Provide target.path or query.`);
  }

  if (mutate && !scriptOperation && desiredAction === 'create' && !resolvedPath && !explicitPath) {
    fail('create requires target.path to specify where to create the file or folder');
  }

  if (mutate && scriptOperation && matches.length === 0) {
    if (scriptMeta?.require_handoff_matches !== false) {
      fail(`no candidates found for scripted operation '${operation}' in ${scopeDir}`);
    }
  }

  const summaryText =
    desiredAction === 'info'
      ? buildInfoSummary(info)
      : scriptOperation
        ? buildScriptSummary(scopeDir, operation, matches.length, scriptMeta)
        : mutate
          ? buildMutationSummary(
              routedDesiredAction,
              scopeDir,
              (resolvedPath || explicitPath || null) as string | null,
              query,
              matches.length
            )
          : buildReadSummary(scopeDir, query, matches.length);

  const previewTitle =
    desiredAction === 'info'
      ? `Info: ${path.basename(info?.path || scopeDir)}`
      : scriptOperation
        ? `Planned ${operation}`
        : mutate
          ? `Planned ${routedDesiredAction}`
          : null;
  const previewSubtitle =
    desiredAction === 'info'
      ? info?.kind === 'directory'
        ? `${info.file_count} files · ${info.directory_count} folders · ${Number(
            info.total_size_bytes ?? 0
          ).toLocaleString()} bytes${
            typeof info.total_size_human === 'string' && info.total_size_human
              ? ` (${info.total_size_human})`
              : ''
          }`
        : `${Number(info?.size_bytes ?? 0).toLocaleString()} bytes${
            typeof info?.size_human === 'string' && info.size_human ? ` (${info.size_human})` : ''
          }`
      : scriptOperation
        ? 'Scripted operation preview from explorer read worker'
        : mutate
          ? (resolvedPath || explicitPath || null)
          : null;

  const uiBlocks = shouldEmitUiBlocks(channel, responseFormat)
    ? [
        buildFilePreviewBlock({
          matches,
          scopeDir,
          query,
          channel,
          title: previewTitle,
          subtitle: previewSubtitle
        })
      ]
    : [];

  const payload: Record<string, unknown> = {
    ok: true,
    plugin: 'explorer_read_agent',
    mode: mutate ? 'read_then_write' : 'read_only',
    desired_action: routedDesiredAction,
    requested_desired_action: desiredAction,
    operation: operation || null,
    channel,
    response_format: uiBlocks.length > 0 ? 'ui_blocks' : responseFormat || 'text',
    scope_dir: scopeDir,
    resolved_path: resolvedPath,
    query,
    matches,
    match_count: matches.length,
    script_plan: scriptMeta,
    info,
    chat_response: summaryText,
    ui_blocks: uiBlocks
  };

  if (!mutate || desiredAction === 'read' || desiredAction === 'info') {
    respond(payload);
    process.exit(0);
  }

  const writeResource = normalizePluginResource(
    targetMeta.write_resource,
    'plugin:explorer_write_agent',
    'write_resource'
  );

  const socketChannels = deriveSocketChannels(request, targetMeta);
  const senderAgentId =
    asOptionalString(process.env.PINOKIO_SOCKET_AGENT_ID) ||
    asOptionalString(request.caller_agent_id as string) ||
    'explorer_read_agent';

  const handoffPayload: Record<string, unknown> = {
    schema: 'pinokio.explorer.handoff/v1',
    plugin: 'explorer_read_agent',
    sender_agent_id: senderAgentId,
    sender_resource:
      asOptionalString(process.env.PINOKIO_SOCKET_RESOURCE) || 'plugin:explorer_read_agent',
    request_id: asOptionalString(request.id as string),
    desired_action: routedDesiredAction,
    scope_dir: scopeDir,
    resolved_path: resolvedPath,
    query,
    matches,
    match_count: matches.length,
    script_plan: scriptMeta,
    options: {
      operation: routedOperation,
      kind: asOptionalString(targetMeta.kind),
      content: typeof targetMeta.content === 'string' ? targetMeta.content : null,
      overwrite: targetMeta.overwrite === true,
      ensure_parent: targetMeta.ensure_parent === false ? false : true,
      new_name: asOptionalString(targetMeta.new_name),
      destination: asOptionalString(targetMeta.destination),
      recursive: targetMeta.recursive === false ? false : true,
      dry_run: targetMeta.dry_run === true,
      extensions: parseExtensionsFromTarget(targetMeta),
      cleanup_profile: asOptionalString(targetMeta.cleanup_profile),
      min_size_bytes: parseMinSizeBytes(targetMeta),
      archive_destination: asOptionalString(targetMeta.archive_destination),
      delete_source: targetMeta.delete_source === true,
      script: scriptMeta?.script || null,
      require_handoff_matches:
        scriptMeta && typeof scriptMeta.require_handoff_matches === 'boolean'
          ? scriptMeta.require_handoff_matches
          : typeof targetMeta.require_handoff_matches === 'boolean'
            ? targetMeta.require_handoff_matches
            : false
    }
  };

  const writeTarget: Record<string, unknown> = {
    scope_dir: scopeDir,
    desired_action: routedDesiredAction,
    path: asOptionalString(targetMeta.path),
    resolved_path: resolvedPath || explicitPath,
    query,
    operation: routedOperation,
    handoff_matches: matches,
    script_plan: scriptMeta,
    kind: asOptionalString(targetMeta.kind),
    content: typeof targetMeta.content === 'string' ? targetMeta.content : null,
    overwrite: targetMeta.overwrite === true,
    ensure_parent: targetMeta.ensure_parent === false ? false : true,
    new_name: asOptionalString(targetMeta.new_name),
    destination: asOptionalString(targetMeta.destination),
    recursive: targetMeta.recursive === false ? false : true,
    dry_run: targetMeta.dry_run === true,
    extensions: parseExtensionsFromTarget(targetMeta),
    cleanup_profile: asOptionalString(targetMeta.cleanup_profile),
    min_size_bytes: parseMinSizeBytes(targetMeta),
    archive_destination: asOptionalString(targetMeta.archive_destination),
    delete_source: targetMeta.delete_source === true,
    script: scriptMeta?.script || null,
    require_handoff_matches:
      scriptMeta && typeof scriptMeta.require_handoff_matches === 'boolean'
        ? scriptMeta.require_handoff_matches
        : typeof targetMeta.require_handoff_matches === 'boolean'
          ? targetMeta.require_handoff_matches
          : false,
    channel,
    response_format: responseFormat,
    socket_channel: socketChannels.session_channel,
    socket_sender_filter: senderAgentId,
    socket_global_channel: socketChannels.global_channel,
    socket_personal_channel: socketChannels.personal_channel
  };

  const socketRequests: Record<string, unknown>[] = socketChannels.publish_channels.map((socketChannel: string) => ({
    op: 'publish',
    channel: socketChannel,
    payload: handoffPayload
  }));
  socketRequests.push({
    op: 'consume',
    channel: socketChannels.session_channel,
    max_messages: 1,
    sender_filter: senderAgentId
  });

  spawnChild(
    {
      summary: 'explorer mutation execution request',
      resource: writeResource,
      action: 'read',
      target: JSON.stringify(writeTarget),
      container_image: null,
      llm_profile:
        typeof request.llm_profile === 'string' && request.llm_profile.trim()
          ? request.llm_profile.trim()
          : null
    },
    {
      ...payload,
      socket_channels: socketChannels,
      socket_requests: socketRequests
    }
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
