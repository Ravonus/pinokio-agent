import fs from 'node:fs';
import path from 'node:path';
import {
  type TargetMeta,
  type ScriptStep,
  SCRIPT_MUTATION_OPERATIONS,
  DEFAULT_CLEANUP_NAMES,
  DEFAULT_CLEANUP_EXTENSIONS,
  normalizeScriptOperation,
  toPositiveInt,
  normalizeExtensionToken,
  extensionFromName,
  ensureInsideScope,
  formatHumanBytes
} from './shared.ts';
import { asOptionalString, normalizeAction } from '../plugin-utils.ts';
import { fail } from '../../sdk/typescript/pinokio-sdk.ts';

// ── Constants used by extracted helpers ──────────────────────────────

export const IMAGE_EXTENSIONS: Set<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff']);
export const VIDEO_EXTENSIONS: Set<string> = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm']);
export const AUDIO_EXTENSIONS: Set<string> = new Set(['mp3', 'wav', 'ogg', 'aac', 'm4a']);
export const ARCHIVE_EXTENSIONS: Set<string> = new Set(['zip', 'gz', 'tar', '7z', 'rar']);
export const PREVIEW_ITEM_LIMIT: number = 120;

// ── Interfaces ───────────────────────────────────────────────────────

export interface PathDescription {
  path: string;
  relative_path: string | null;
  name: string;
  kind: string;
  exists: boolean;
  size: number | null;
  size_human: string | null;
  modified_at: string | null;
}

export interface MatchEntry {
  path: string;
  relative_path: string;
  name: string;
  kind: string;
  exists: boolean;
  size: number | null;
  size_human: string | null;
  modified_at: string | null;
}

export interface ScriptDefinition {
  steps: ScriptStep[];
  step_count: number;
  require_handoff_matches: boolean;
}

export interface ScriptMeta {
  operation: string;
  step_count?: number;
  require_handoff_matches?: boolean;
  script?: Record<string, unknown>;
  extensions?: string[];
  cleanup_profile?: string;
  min_size_bytes?: number;
  archive_destination?: string | null;
  delete_source?: boolean;
}

export interface ScriptSelection {
  matches: MatchEntry[];
  script_meta: ScriptMeta | null;
}

export interface SocketChannels {
  global_channel: string;
  personal_channel: string | null;
  session_channel: string;
  publish_channels: string[];
}

export interface InfoPayload {
  path: string;
  kind: string;
  size_bytes: number | null;
  size_human: string | null;
  modified_at: string;
  file_count: number;
  directory_count: number;
  total_size_bytes: number;
  total_size_human: string | null;
  entries: PathDescription[];
}

export interface FilePreviewBlock {
  type: string;
  source_plugin: string;
  channel_targets: string[];
  title: string;
  subtitle: string;
  scope_dir: string;
  query: string | null;
  total_count: number;
  shown_count: number;
  items: Record<string, unknown>[];
}

interface FilePreviewBlockParams {
  matches: MatchEntry[];
  scopeDir: string;
  query: string | null;
  channel: string;
  title: string | null;
  subtitle: string | null;
}

interface DirectoryStats {
  totalSize: number;
  fileCount: number;
  directoryCount: number;
}

// ── Functions ────────────────────────────────────────────────────────

export function resolvePathHint(scopeDir: string, hint: unknown): string | null {
  const normalized = asOptionalString(hint);
  if (!normalized) {
    return null;
  }
  if (path.isAbsolute(normalized)) {
    return ensureInsideScope(scopeDir, normalized);
  }
  return ensureInsideScope(scopeDir, path.join(scopeDir, normalized));
}

export function describePath(fullPath: string, scopeDir: string | null): PathDescription {
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

export function findMatches(scopeDir: string, query: string | null, limit: number, recursiveSearch: boolean): MatchEntry[] {
  const queryText = asOptionalString(query);
  const q = queryText ? queryText.toLowerCase() : null;
  const matches: MatchEntry[] = [];
  const stack: string[] = [scopeDir];

  while (stack.length > 0 && matches.length < limit) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
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
        let size: number | null = null;
        let modifiedAt: string | null = null;
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

export function parseExtensionsFromTarget(targetMeta: TargetMeta): string[] {
  const out: string[] = [];
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

export function parseMinSizeBytes(targetMeta: TargetMeta): number | null {
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

export function parseScriptDefinition(targetMeta: TargetMeta): ScriptDefinition {
  let script: Record<string, unknown> | null = null;
  if (Array.isArray(targetMeta.script)) {
    script = { steps: targetMeta.script };
  } else if (targetMeta.script && typeof targetMeta.script === 'object' && !Array.isArray(targetMeta.script)) {
    script = targetMeta.script as Record<string, unknown>;
  } else if (typeof targetMeta.script === 'string') {
    const trimmed = (targetMeta.script as string).trim();
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

  const steps: ScriptStep[] = rawSteps.map((step: unknown, index: number) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      fail(`run_script step #${index + 1} must be an object`);
    }
    const stepObj = step as Record<string, unknown>;
    const op = normalizeAction(stepObj.op || stepObj.operation);
    if (!op) {
      fail(`run_script step #${index + 1} requires 'op'`);
    }
    return {
      ...stepObj,
      op
    };
  });

  return {
    steps,
    step_count: steps.length,
    require_handoff_matches:
      typeof script.require_handoff_matches === 'boolean'
        ? script.require_handoff_matches
        : (targetMeta.require_handoff_matches as boolean) !== false
  };
}

export function thumbnailHintForEntry(kind: string, name: string): string {
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

export function shouldEmitUiBlocks(channel: string, responseFormat: string | null): boolean {
  if (responseFormat === 'ui_blocks') {
    return true;
  }
  return channel === 'ui_chat';
}

export function buildReadSummary(scopeDir: string, query: string | null, matchCount: number): string {
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

export function buildMutationSummary(
  desiredAction: string,
  scopeDir: string,
  resolvedPath: string | null,
  query: string | null,
  matchCount: number
): string {
  const label =
    desiredAction === 'create'
      ? 'create'
      : desiredAction === 'update'
        ? 'update'
        : desiredAction === 'delete'
          ? 'delete'
          : desiredAction;
  if (resolvedPath) {
    return `Prepared ${label} operation for ${resolvedPath}.`;
  }
  if (query) {
    return `Prepared ${label} operation from ${matchCount} match(es) for "${query}" in ${scopeDir}.`;
  }
  return `Prepared ${label} operation from ${matchCount} match(es) in ${scopeDir}.`;
}

export function buildScriptSummary(scopeDir: string, operation: string, matchCount: number, scriptMeta: ScriptMeta | null): string {
  if (matchCount === 0) {
    if (operation === 'run_script' && scriptMeta?.require_handoff_matches === false) {
      return `Prepared run_script with ${scriptMeta?.step_count || 0} step(s) in ${scopeDir} (no candidate handoff required).`;
    }
    return `No candidates found for ${operation} in ${scopeDir}.`;
  }
  if (operation === 'delete_by_extension') {
    const exts = Array.isArray(scriptMeta?.extensions) ? scriptMeta!.extensions!.join(', ') : 'selected';
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

export function buildInfoSummary(info: InfoPayload | null): string {
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

export function buildFilePreviewBlock({ matches, scopeDir, query, channel, title, subtitle }: FilePreviewBlockParams): FilePreviewBlock {
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

export function collectDirectoryStats(dirPath: string): DirectoryStats {
  let totalSize = 0;
  let fileCount = 0;
  let directoryCount = 0;
  const stack: string[] = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      let stat: fs.Stats;
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

export function buildInfoPayload(scopeDir: string, targetPath: string): InfoPayload {
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
  let entries: PathDescription[] = [];
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

export function selectScriptCandidates(operation: string, matches: MatchEntry[], targetMeta: TargetMeta): ScriptSelection {
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
    const selected = fileMatches.filter((item) => extensionSet.has(normalizeExtensionToken(extensionFromName(item.name)) as string));
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
    const selected = fileMatches.filter((item) => typeof item.size === 'number' && item.size >= minSize!);
    return {
      matches: selected,
      script_meta: {
        operation: 'zip_files_over_size',
        min_size_bytes: minSize!,
        archive_destination: asOptionalString(targetMeta.archive_destination),
        delete_source: targetMeta.delete_source === true
      }
    };
  }

  return { matches, script_meta: { operation: normalizedOperation } };
}
