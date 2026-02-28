import fs from 'node:fs';
import path from 'node:path';
import { pluginContext, respond, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_ACTIONS = new Set(['read']);
const READ_DESIRED_ACTIONS = new Set(['read', 'info']);
const MUTATION_DESIRED_ACTIONS = new Set(['create', 'update', 'delete']);
const SCRIPT_MUTATION_OPERATIONS = new Set([
  'delete_by_extension',
  'cleanup',
  'zip_files_over_size',
  'archive_large_files',
  'run_script'
]);
const DEFAULT_SCOPE_DIR = process.env.PINOKIO_EXPLORER_SCOPE || '/app';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
const PREVIEW_ITEM_LIMIT = 120;
const DEFAULT_CHANNEL = 'default';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'aac', 'm4a']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tar', '7z', 'rar']);
const DEFAULT_CLEANUP_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
const DEFAULT_CLEANUP_EXTENSIONS = new Set(['tmp', 'bak', 'old', 'log', 'dmp', 'rar']);

function normalizeAction(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeScriptOperation(value) {
  const operation = normalizeAction(value);
  if (operation === 'archive_large_files') {
    return 'zip_files_over_size';
  }
  if (operation === 'script' || operation === 'execute_script' || operation === 'workflow') {
    return 'run_script';
  }
  return operation;
}

function asOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}

function toPositiveInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
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
  } catch {
    return { query: trimmed };
  }
  return {};
}

function normalizeChannel(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_CHANNEL;
}

function normalizePluginResource(value, fallback, label) {
  const resolved = asOptionalString(value) || fallback;
  if (!resolved.startsWith('plugin:')) {
    fail(`${label} must be a plugin resource (got '${resolved}')`);
  }
  return resolved;
}

function ensureDirectory(value, label) {
  if (!fs.existsSync(value)) {
    fail(`${label} does not exist: ${value}`);
  }
  const stat = fs.statSync(value);
  if (!stat.isDirectory()) {
    fail(`${label} is not a directory: ${value}`);
  }
}

function ensureInsideScope(scopeDir, candidate) {
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(candidate);
  if (resolved === scope) {
    return resolved;
  }
  const withSep = scope.endsWith(path.sep) ? scope : `${scope}${path.sep}`;
  if (!resolved.startsWith(withSep)) {
    fail(`path escapes scope '${scope}': ${resolved}`);
  }
  return resolved;
}

function formatHumanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex < 0) {
    return `${bytes} B`;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function resolvePathHint(scopeDir, hint) {
  const normalized = asOptionalString(hint);
  if (!normalized) {
    return null;
  }
  if (path.isAbsolute(normalized)) {
    return ensureInsideScope(scopeDir, normalized);
  }
  return ensureInsideScope(scopeDir, path.join(scopeDir, normalized));
}

function describePath(fullPath, scopeDir) {
  if (!fs.existsSync(fullPath)) {
    return {
      path: fullPath,
      relative_path: scopeDir ? path.relative(scopeDir, fullPath) : null,
      name: path.basename(fullPath),
      kind: 'missing',
      exists: false,
      size: null,
      size_human: null,
      modified_at: null
    };
  }
  const stat = fs.statSync(fullPath);
  const sizeBytes = stat.isFile() ? stat.size : null;
  return {
    path: fullPath,
    relative_path: scopeDir ? path.relative(scopeDir, fullPath) : null,
    name: path.basename(fullPath),
    kind: stat.isDirectory() ? 'directory' : 'file',
    exists: true,
    size: sizeBytes,
    size_human: sizeBytes === null ? null : formatHumanBytes(sizeBytes),
    modified_at: stat.mtime.toISOString()
  };
}

function findMatches(scopeDir, query, limit, recursiveSearch) {
  const queryText = asOptionalString(query);
  const q = queryText ? queryText.toLowerCase() : null;
  const matches = [];
  const stack = [scopeDir];

  while (stack.length > 0 && matches.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(scopeDir, fullPath);
      const haystack = `${entry.name} ${relativePath}`.toLowerCase();
      if (!q || haystack.includes(q)) {
        let size = null;
        let modifiedAt = null;
        try {
          const stat = fs.statSync(fullPath);
          size = stat.isFile() ? stat.size : null;
          modifiedAt = stat.mtime.toISOString();
        } catch {
          size = null;
          modifiedAt = null;
        }
        matches.push({
          path: fullPath,
          relative_path: relativePath,
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : 'file',
          exists: true,
          size,
          size_human: typeof size === 'number' ? formatHumanBytes(size) : null,
          modified_at: modifiedAt
        });
      }

      if (recursiveSearch && entry.isDirectory()) {
        stack.push(fullPath);
      }

      if (matches.length >= limit) {
        break;
      }
    }
  }

  return matches;
}

function resolveDesiredPath(desiredAction, explicitCandidate, matches) {
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

function deriveMutateFlag(targetMeta, desiredAction) {
  if (targetMeta.mutate === true) {
    return true;
  }
  return MUTATION_DESIRED_ACTIONS.has(desiredAction);
}

function sanitizeChannelToken(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function deriveSocketChannels(request, targetMeta) {
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
    asOptionalString(request.id) ||
    `${Date.now()}`;
  const sessionChannel =
    asOptionalString(targetMeta.socket_channel) ||
    `explorer:${sanitizeChannelToken(sessionSeed, 'session')}`;
  const publishChannels = Array.from(
    new Set([globalChannel, sessionChannel, personalChannel].filter(Boolean))
  );
  return {
    global_channel: globalChannel,
    personal_channel: personalChannel,
    session_channel: sessionChannel,
    publish_channels: publishChannels
  };
}

function extensionFromName(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index <= 0 || index === value.length - 1) {
    return '';
  }
  return value.slice(index + 1).toLowerCase();
}

function normalizeExtensionToken(value) {
  const trimmed = String(value || '')
    .trim()
    .toLowerCase();
  if (!trimmed) {
    return null;
  }
  const stripped = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  const safe = stripped.replace(/[^a-z0-9]+/g, '');
  return safe || null;
}

function parseExtensionsFromTarget(targetMeta) {
  const out = [];
  if (Array.isArray(targetMeta.extensions)) {
    for (const value of targetMeta.extensions) {
      const normalized = normalizeExtensionToken(value);
      if (normalized) {
        out.push(normalized);
      }
    }
  } else {
    const direct = asOptionalString(targetMeta.extensions) || asOptionalString(targetMeta.extension);
    if (direct) {
      for (const token of direct.split(/[\s,;|]+/)) {
        const normalized = normalizeExtensionToken(token);
        if (normalized) {
          out.push(normalized);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

function parseMinSizeBytes(targetMeta) {
  const fromBytes = toPositiveInt(targetMeta.min_size_bytes);
  if (fromBytes) {
    return fromBytes;
  }
  const fromSize = toPositiveInt(targetMeta.min_size);
  if (fromSize) {
    return fromSize;
  }
  return null;
}

function parseScriptDefinition(targetMeta) {
  let script = null;
  if (Array.isArray(targetMeta.script)) {
    script = { steps: targetMeta.script };
  } else if (targetMeta.script && typeof targetMeta.script === 'object' && !Array.isArray(targetMeta.script)) {
    script = targetMeta.script;
  } else if (typeof targetMeta.script === 'string') {
    const trimmed = targetMeta.script.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          script = { steps: parsed };
        } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          script = parsed;
        }
      } catch {
        fail('run_script requires target.script JSON with a steps array');
      }
    }
  }

  if (!script) {
    fail('run_script requires target.script');
  }

  const rawSteps = Array.isArray(script.steps)
    ? script.steps
    : Array.isArray(script.operations)
      ? script.operations
      : null;
  if (!rawSteps || rawSteps.length === 0) {
    fail('run_script requires target.script.steps with at least one step');
  }
  if (rawSteps.length > 200) {
    fail('run_script supports at most 200 steps');
  }

  const steps = rawSteps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      fail(`run_script step #${index + 1} must be an object`);
    }
    const op = normalizeAction(step.op || step.operation);
    if (!op) {
      fail(`run_script step #${index + 1} requires 'op'`);
    }
    return {
      ...step,
      op
    };
  });

  return {
    steps,
    step_count: steps.length,
    require_handoff_matches:
      typeof script.require_handoff_matches === 'boolean'
        ? script.require_handoff_matches
        : targetMeta.require_handoff_matches !== false
  };
}

function thumbnailHintForEntry(kind, name) {
  if (kind === 'directory') {
    return 'DIR';
  }
  const ext = extensionFromName(name);
  if (!ext) {
    return 'FILE';
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'IMG';
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'VID';
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return 'AUD';
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return 'ZIP';
  }
  if (ext === 'pdf') {
    return 'PDF';
  }
  if (['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'java', 'json', 'yaml', 'yml', 'toml', 'md'].includes(ext)) {
    return 'CODE';
  }
  return ext.slice(0, 4).toUpperCase();
}

function shouldEmitUiBlocks(channel, responseFormat) {
  if (responseFormat === 'ui_blocks') {
    return true;
  }
  return channel === 'ui_chat';
}

function buildReadSummary(scopeDir, query, matchCount) {
  if (matchCount === 0) {
    return scopeDir
      ? `No matching files or folders found in ${scopeDir}.`
      : 'No matching files or folders found.';
  }
  if (query) {
    return `Found ${matchCount} item(s) matching "${query}" in ${scopeDir}.`;
  }
  return `Found ${matchCount} item(s) in ${scopeDir}.`;
}

function buildScriptSummary(scopeDir, operation, matchCount, scriptMeta) {
  if (matchCount === 0) {
    if (operation === 'run_script' && scriptMeta?.require_handoff_matches === false) {
      return `Prepared run_script with ${scriptMeta?.step_count || 0} step(s) in ${scopeDir} (no candidate handoff required).`;
    }
    return `No candidates found for ${operation} in ${scopeDir}.`;
  }
  if (operation === 'delete_by_extension') {
    const exts = Array.isArray(scriptMeta?.extensions) ? scriptMeta.extensions.join(', ') : 'selected';
    return `Prepared ${matchCount} file(s) for delete_by_extension (${exts}) in ${scopeDir}.`;
  }
  if (operation === 'cleanup') {
    return `Prepared ${matchCount} cleanup candidate(s) in ${scopeDir}.`;
  }
  if (operation === 'zip_files_over_size' || operation === 'archive_large_files') {
    const minSize = Number(scriptMeta?.min_size_bytes || 0);
    return minSize > 0
      ? `Prepared ${matchCount} file(s) to archive (>= ${minSize.toLocaleString()} bytes${
          formatHumanBytes(minSize) ? `, ${formatHumanBytes(minSize)}` : ''
        }) in ${scopeDir}.`
      : `Prepared ${matchCount} file(s) to archive in ${scopeDir}.`;
  }
  if (operation === 'run_script') {
    const steps = Number(scriptMeta?.step_count || 0);
    return `Prepared run_script with ${steps} step(s) and ${matchCount} handoff candidate(s) in ${scopeDir}.`;
  }
  return `Prepared ${matchCount} candidate(s) for ${operation} in ${scopeDir}.`;
}

function buildInfoSummary(info) {
  if (!info) {
    return 'No info available.';
  }
  if (info.kind === 'file') {
    const sizeHuman =
      typeof info.size_human === 'string' && info.size_human.trim()
        ? ` (${info.size_human.trim()})`
        : '';
    return `File info for ${info.path}: ${Number(info.size_bytes || 0).toLocaleString()} bytes${sizeHuman}.`;
  }
  const totalHuman =
    typeof info.total_size_human === 'string' && info.total_size_human.trim()
      ? ` (${info.total_size_human.trim()})`
      : '';
  return `Directory info for ${info.path}: ${info.file_count} files, ${info.directory_count} folders, ${Number(
    info.total_size_bytes || 0
  ).toLocaleString()} bytes${totalHuman}.`;
}

function buildFilePreviewBlock({ matches, scopeDir, query, channel, title, subtitle }) {
  const items = matches.slice(0, PREVIEW_ITEM_LIMIT).map((entry) => {
    const name = asOptionalString(entry.name) || path.basename(asOptionalString(entry.path) || '');
    const kind = asOptionalString(entry.kind) || 'file';
    return {
      name,
      kind,
      path: asOptionalString(entry.path),
      relative_path: asOptionalString(entry.relative_path),
      size: typeof entry.size === 'number' ? entry.size : null,
      size_human:
        typeof entry.size_human === 'string'
          ? entry.size_human
          : typeof entry.size === 'number'
            ? formatHumanBytes(entry.size)
            : null,
      modified_at: asOptionalString(entry.modified_at),
      thumbnail: thumbnailHintForEntry(kind, name)
    };
  });
  const scopeName = path.basename(scopeDir) || scopeDir;
  return {
    type: 'file_grid',
    source_plugin: 'explorer_read_agent',
    channel_targets: [channel],
    title: title || (query ? `Search Results: ${query}` : `Files in ${scopeName}`),
    subtitle: subtitle || (query ? 'Directory search preview' : 'Directory contents'),
    scope_dir: scopeDir,
    query,
    total_count: matches.length,
    shown_count: items.length,
    items
  };
}

function collectDirectoryStats(dirPath) {
  let totalSize = 0;
  let fileCount = 0;
  let directoryCount = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        directoryCount += 1;
        stack.push(fullPath);
      } else if (stat.isFile()) {
        fileCount += 1;
        totalSize += stat.size;
      }
    }
  }

  return { totalSize, fileCount, directoryCount };
}

function buildInfoPayload(scopeDir, targetPath) {
  const resolvedPath = ensureInsideScope(scopeDir, targetPath);
  if (!fs.existsSync(resolvedPath)) {
    fail(`info target not found: ${resolvedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (stat.isFile()) {
    return {
      path: resolvedPath,
      kind: 'file',
      size_bytes: stat.size,
      size_human: formatHumanBytes(stat.size),
      modified_at: stat.mtime.toISOString(),
      file_count: 1,
      directory_count: 0,
      total_size_bytes: stat.size,
      total_size_human: formatHumanBytes(stat.size),
      entries: []
    };
  }

  const { totalSize, fileCount, directoryCount } = collectDirectoryStats(resolvedPath);
  let entries = [];
  try {
    const children = fs.readdirSync(resolvedPath, { withFileTypes: true });
    children
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, PREVIEW_ITEM_LIMIT)
      .forEach((entry) => {
        const childPath = path.join(resolvedPath, entry.name);
        entries.push(describePath(childPath, resolvedPath));
      });
  } catch {
    entries = [];
  }

  return {
    path: resolvedPath,
    kind: 'directory',
    size_bytes: null,
    size_human: null,
    modified_at: stat.mtime.toISOString(),
    file_count: fileCount,
    directory_count: directoryCount,
    total_size_bytes: totalSize,
    total_size_human: formatHumanBytes(totalSize),
    entries
  };
}

function selectScriptCandidates(operation, matches, targetMeta) {
  const normalizedOperation = normalizeScriptOperation(operation);
  if (!SCRIPT_MUTATION_OPERATIONS.has(normalizedOperation)) {
    return { matches, script_meta: null };
  }

  const fileMatches = matches.filter((item) => item && item.kind === 'file' && item.exists === true);
  const existingMatches = matches.filter((item) => item && item.exists === true);

  if (normalizedOperation === 'run_script') {
    const script = parseScriptDefinition(targetMeta);
    return {
      matches: existingMatches,
      script_meta: {
        operation: 'run_script',
        step_count: script.step_count,
        require_handoff_matches: script.require_handoff_matches,
        script: {
          steps: script.steps,
          require_handoff_matches: script.require_handoff_matches
        }
      }
    };
  }

  if (normalizedOperation === 'delete_by_extension') {
    const extensions = parseExtensionsFromTarget(targetMeta);
    if (extensions.length === 0) {
      fail('delete_by_extension requires target.extensions (example: ["rar"])');
    }
    const extensionSet = new Set(extensions);
    const selected = fileMatches.filter((item) => extensionSet.has(normalizeExtensionToken(extensionFromName(item.name))));
    return {
      matches: selected,
      script_meta: {
        operation: normalizedOperation,
        extensions
      }
    };
  }

  if (normalizedOperation === 'cleanup') {
    const cleanupProfile = asOptionalString(targetMeta.cleanup_profile) || 'default';
    const extensions = parseExtensionsFromTarget(targetMeta);
    const cleanupExt = new Set([...DEFAULT_CLEANUP_EXTENSIONS, ...extensions]);
    const selected = fileMatches.filter((item) => {
      const name = String(item.name || '').toLowerCase();
      if (DEFAULT_CLEANUP_NAMES.has(name)) {
        return true;
      }
      const ext = normalizeExtensionToken(extensionFromName(name));
      return ext ? cleanupExt.has(ext) : false;
    });
    return {
      matches: selected,
      script_meta: {
        operation: normalizedOperation,
        cleanup_profile: cleanupProfile,
        extensions: Array.from(cleanupExt)
      }
    };
  }

  if (normalizedOperation === 'zip_files_over_size' || normalizedOperation === 'archive_large_files') {
    const minSize = parseMinSizeBytes(targetMeta);
    if (!minSize) {
      fail(`${normalizedOperation} requires target.min_size_bytes`);
    }
    const selected = fileMatches.filter((item) => typeof item.size === 'number' && item.size >= minSize);
    return {
      matches: selected,
      script_meta: {
        operation: 'zip_files_over_size',
        min_size_bytes: minSize,
        archive_destination: asOptionalString(targetMeta.archive_destination),
        delete_source: targetMeta.delete_source === true
      }
    };
  }

  return { matches, script_meta: { operation: normalizedOperation } };
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

  let matches = [];
  if (explicitCandidate) {
    matches.push(explicitCandidate);
  } else {
    matches = findMatches(scopeDir, query, limit, recursiveRead);
  }

  let info = null;
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
      matches = info.entries;
    }
  }

  let scriptMeta = null;
  if (scriptOperation) {
    const scriptSelection = selectScriptCandidates(operation, matches, targetMeta);
    matches = scriptSelection.matches;
    scriptMeta = scriptSelection.script_meta;
  }

  const mutate = deriveMutateFlag(targetMeta, desiredAction);
  const resolvedPath = resolveDesiredPath(desiredAction, explicitCandidate, matches);

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
        : buildReadSummary(scopeDir, query, matches.length);

  const previewTitle =
    desiredAction === 'info'
      ? `Info: ${path.basename(info?.path || scopeDir)}`
      : scriptOperation
        ? `Planned ${operation}`
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

  const payload = {
    ok: true,
    plugin: 'explorer_read_agent',
    mode: mutate ? 'read_then_write' : 'read_only',
    desired_action: desiredAction,
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
    asOptionalString(request.caller_agent_id) ||
    'explorer_read_agent';

  const handoffPayload = {
    schema: 'pinokio.explorer.handoff/v1',
    plugin: 'explorer_read_agent',
    sender_agent_id: senderAgentId,
    sender_resource:
      asOptionalString(process.env.PINOKIO_SOCKET_RESOURCE) || 'plugin:explorer_read_agent',
    request_id: asOptionalString(request.id),
    desired_action: desiredAction,
    scope_dir: scopeDir,
    resolved_path: resolvedPath,
    query,
    matches,
    match_count: matches.length,
    script_plan: scriptMeta,
    options: {
      operation: operation || null,
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
          : targetMeta.require_handoff_matches !== false
    }
  };

  const writeTarget = {
    scope_dir: scopeDir,
    desired_action: desiredAction,
    path: asOptionalString(targetMeta.path),
    resolved_path: resolvedPath || explicitPath,
    query,
    operation: operation || null,
    script: scriptMeta?.script || null,
    require_handoff_matches:
      scriptMeta && typeof scriptMeta.require_handoff_matches === 'boolean'
        ? scriptMeta.require_handoff_matches
        : targetMeta.require_handoff_matches !== false,
    channel,
    response_format: responseFormat,
    socket_channel: socketChannels.session_channel,
    socket_sender_filter: senderAgentId,
    socket_global_channel: socketChannels.global_channel,
    socket_personal_channel: socketChannels.personal_channel
  };

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
      socket_requests: socketChannels.publish_channels.map((socketChannel) => ({
        op: 'publish',
        channel: socketChannel,
        payload: handoffPayload
      }))
    }
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
