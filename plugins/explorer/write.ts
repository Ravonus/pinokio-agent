import fs from 'node:fs';
import path from 'node:path';
import { pluginContext, respond, fail } from '../../sdk/typescript/pinokio-sdk.ts';
import { asOptionalString, normalizeAction } from '../plugin-utils.ts';
import {
  type TargetMeta,
  DEFAULT_SCOPE_DIR,
  SCRIPT_MUTATION_OPERATIONS,
  DEFAULT_CLEANUP_NAMES,
  DEFAULT_CLEANUP_EXTENSIONS,
  normalizeScriptOperation,
  toPositiveInt,
  normalizeExtensionToken,
  extensionFromName,
  ensureDirectory,
  ensureInsideScope
} from './shared.ts';
import { createSingleFileZipBuffer, createPdfBufferFromText, MAX_ZIP_SOURCE_BYTES } from './binary-formats.ts';
import { executeScriptedOperation } from './script-executor.ts';
import { type SocketHandoffResult, applySocketHandoff } from './socket-handoff.ts';

const SUPPORTED_REQUEST_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);
const MUTATION_ACTIONS: Set<string> = new Set(['create', 'update', 'delete']);

export interface HandoffMatch {
  path: string;
  name: string;
  kind: string;
  size: number | null;
}

export interface MutationResult {
  operation: string;
  [key: string]: unknown;
}

function parseExtensionList(targetMeta: TargetMeta): string[] {
  const out: string[] = [];
  if (Array.isArray(targetMeta.extensions)) {
    for (const item of targetMeta.extensions) {
      const normalized = normalizeExtensionToken(item);
      if (normalized) {
        out.push(normalized);
      }
    }
  } else {
    const raw = asOptionalString(targetMeta.extensions) || asOptionalString(targetMeta.extension);
    if (raw) {
      for (const token of raw.split(/[\s,;|]+/)) {
        const normalized = normalizeExtensionToken(token);
        if (normalized) {
          out.push(normalized);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

function parseTargetMeta(target: unknown): TargetMeta {
  if (typeof target !== 'string') {
    return {};
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.startsWith('{')) {
    return { path: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TargetMeta;
    }
  } catch {
    return { path: trimmed };
  }
  return {};
}

function resolveInScope(scopeDir: string, value: unknown, fieldName: string): string {
  const input = asOptionalString(value);
  if (!input) {
    fail(`${fieldName} is required`);
  }
  if (path.isAbsolute(input)) {
    return ensureInsideScope(scopeDir, input);
  }
  return ensureInsideScope(scopeDir, path.join(scopeDir, input));
}

function inferCreateKind(pathValue: string, requestedKind: unknown): string {
  const explicitKind = asOptionalString(requestedKind);
  if (explicitKind === 'file' || explicitKind === 'directory') {
    return explicitKind;
  }
  if (String(pathValue || '').endsWith('/')) {
    return 'directory';
  }
  return 'file';
}

export function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function chooseUpdateOperation(targetMeta: TargetMeta): string {
  const op = normalizeAction(targetMeta.operation || '');
  if (op) {
    return op;
  }
  if (asOptionalString(targetMeta.new_name)) {
    return 'rename';
  }
  if (asOptionalString(targetMeta.destination)) {
    return 'move';
  }
  if (typeof targetMeta.content === 'string') {
    return 'write';
  }
  return 'rename';
}

export function ensureUniquePath(candidatePath: string): string {
  if (!fs.existsSync(candidatePath)) {
    return candidatePath;
  }
  const dir = path.dirname(candidatePath);
  const ext = path.extname(candidatePath);
  const base = path.basename(candidatePath, ext);
  for (let i = 1; i <= 1000; i += 1) {
    const next = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(next)) {
      return next;
    }
  }
  fail(`could not allocate unique archive path for ${candidatePath}`);
}

export interface ExtractHandoffOptions {
  required?: boolean;
}

export function extractHandoffMatches(scopeDir: string, targetMeta: TargetMeta, options: ExtractHandoffOptions = {}): HandoffMatch[] {
  const rawMatches = Array.isArray(targetMeta.handoff_matches)
    ? targetMeta.handoff_matches
    : Array.isArray(targetMeta.matches)
      ? targetMeta.matches
      : [];
  const out: HandoffMatch[] = [];
  const seen = new Set<string>();

  for (const item of rawMatches) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const rawPath = asOptionalString((item as Record<string, unknown>).path);
    if (!rawPath) {
      continue;
    }
    const fullPath = ensureInsideScope(scopeDir, rawPath);
    if (seen.has(fullPath)) {
      continue;
    }
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    seen.add(fullPath);
    out.push({
      path: fullPath,
      name: asOptionalString((item as Record<string, unknown>).name) || path.basename(fullPath),
      kind: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : null
    });
  }

  const required = options.required !== false;
  if (required && out.length === 0) {
    fail('scripted explorer mutation requires handoff matches from explorer_read_agent');
  }

  return out;
}

function executeCreate(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const rawPath = asOptionalString(targetMeta.resolved_path || targetMeta.path);
  if (!rawPath) {
    fail('create requires resolved_path or path');
  }

  const fullPath = resolveInScope(scopeDir, rawPath, 'path');
  const kind = inferCreateKind(rawPath, targetMeta.kind);

  if (kind === 'directory') {
    const script = `mkdir -p ${JSON.stringify(fullPath)}`;
    if (!dryRun) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    return {
      operation: 'create_directory',
      path: fullPath,
      script,
      applied: !dryRun
    };
  }

  const ensureParent = targetMeta.ensure_parent !== false;
  const overwrite = targetMeta.overwrite === true;
  const content = typeof targetMeta.content === 'string' ? targetMeta.content : '';
  const requestedOperation = normalizeAction(targetMeta.operation || '');
  const createPdf =
    requestedOperation === 'create_pdf' ||
    requestedOperation === 'pdf' ||
    fullPath.toLowerCase().endsWith('.pdf');

  if (createPdf) {
    const pdfBuffer = createPdfBufferFromText(content);
    const script = `create_pdf ${JSON.stringify(fullPath)} <<'TEXT'\n${content}\nTEXT`;
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && !overwrite) {
        fail(`target file already exists: ${fullPath}`);
      }
      fs.writeFileSync(fullPath, pdfBuffer, {
        flag: overwrite ? 'w' : 'wx'
      });
    }
    return {
      operation: 'create_pdf',
      path: fullPath,
      overwrite,
      bytes_written: pdfBuffer.length,
      text_bytes: Buffer.byteLength(content, 'utf8'),
      script,
      applied: !dryRun
    };
  }

  const script = overwrite
    ? `cat > ${JSON.stringify(fullPath)} <<'EOF'\n${content}\nEOF`
    : `cat > ${JSON.stringify(fullPath)} (fails if exists)`;

  if (!dryRun) {
    if (ensureParent) {
      ensureParentDir(fullPath);
    }
    if (fs.existsSync(fullPath) && !overwrite) {
      fail(`target file already exists: ${fullPath}`);
    }
    fs.writeFileSync(fullPath, content, {
      encoding: 'utf8',
      flag: overwrite ? 'w' : 'wx'
    });
  }

  return {
    operation: 'create_file',
    path: fullPath,
    bytes_written: Buffer.byteLength(content, 'utf8'),
    overwrite,
    script,
    applied: !dryRun
  };
}

export function executeDeleteByExtension(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const extensions = parseExtensionList(targetMeta);
  if (extensions.length === 0) {
    fail('delete_by_extension requires target.extensions');
  }
  const extensionSet = new Set(extensions);
  const handoffMatches = extractHandoffMatches(scopeDir, targetMeta);
  const candidates = handoffMatches.filter((item) => item.kind === 'file' && extensionSet.has(normalizeExtensionToken(extensionFromName(item.name)) as string));

  if (candidates.length === 0) {
    fail(`delete_by_extension found no matching files for extensions: ${extensions.join(', ')}`);
  }

  const scriptLines: string[] = [];
  for (const item of candidates) {
    scriptLines.push(`rm -f ${JSON.stringify(item.path)}`);
    if (!dryRun) {
      fs.rmSync(item.path, { force: false, recursive: false });
    }
  }

  return {
    operation: 'delete_by_extension',
    extensions,
    deleted_count: candidates.length,
    deleted_paths: candidates.slice(0, 200).map((item) => item.path),
    script: scriptLines.join('\n'),
    applied: !dryRun
  };
}

export function executeCleanup(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const cleanupProfile = asOptionalString(targetMeta.cleanup_profile) || 'default';
  const requestedExt = parseExtensionList(targetMeta);
  const cleanupExt = new Set([...DEFAULT_CLEANUP_EXTENSIONS, ...requestedExt]);
  const handoffMatches = extractHandoffMatches(scopeDir, targetMeta);
  const candidates = handoffMatches.filter((item) => {
    if (item.kind !== 'file') {
      return false;
    }
    const lowerName = String(item.name || '').toLowerCase();
    if (DEFAULT_CLEANUP_NAMES.has(lowerName)) {
      return true;
    }
    const ext = normalizeExtensionToken(extensionFromName(lowerName));
    return ext ? cleanupExt.has(ext) : false;
  });

  if (candidates.length === 0) {
    fail(`cleanup(${cleanupProfile}) found no candidate files in ${scopeDir}`);
  }

  const scriptLines: string[] = [];
  for (const item of candidates) {
    scriptLines.push(`rm -f ${JSON.stringify(item.path)}`);
    if (!dryRun) {
      fs.rmSync(item.path, { force: false, recursive: false });
    }
  }

  return {
    operation: 'cleanup',
    cleanup_profile: cleanupProfile,
    deleted_count: candidates.length,
    deleted_paths: candidates.slice(0, 200).map((item) => item.path),
    script: scriptLines.join('\n'),
    applied: !dryRun
  };
}

function resolveArchiveDir(scopeDir: string, sourcePath: string, targetMeta: TargetMeta): string {
  const requested = asOptionalString(targetMeta.archive_destination);
  if (!requested) {
    return path.dirname(sourcePath);
  }
  const resolved = path.isAbsolute(requested)
    ? ensureInsideScope(scopeDir, requested)
    : ensureInsideScope(scopeDir, path.join(scopeDir, requested));
  ensureParentDir(path.join(resolved, '.keep'));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    fail(`archive_destination must resolve to a directory: ${resolved}`);
  }
  return resolved;
}

export function executeZipFilesOverSize(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const scriptPlan =
    targetMeta.script_plan && typeof targetMeta.script_plan === 'object' && !Array.isArray(targetMeta.script_plan)
      ? (targetMeta.script_plan as Record<string, unknown>)
      : null;
  const minSizeBytes = toPositiveInt(targetMeta.min_size_bytes) ?? (scriptPlan ? toPositiveInt(scriptPlan.min_size_bytes) : null);
  if (minSizeBytes === null) {
    fail('zip_files_over_size requires target.min_size_bytes');
  }

  const deleteSource = targetMeta.delete_source === true;
  const handoffMatches = extractHandoffMatches(scopeDir, targetMeta);
  const candidates = handoffMatches.filter(
    (item) => item.kind === 'file' && typeof item.size === 'number' && item.size >= minSizeBytes
  );
  if (candidates.length === 0) {
    fail(`zip_files_over_size found no files >= ${minSizeBytes} bytes`);
  }

  const archives: Record<string, unknown>[] = [];
  const scriptLines: string[] = [];

  for (const item of candidates) {
    const sourcePath = ensureInsideScope(scopeDir, item.path);
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) {
      continue;
    }
    if (sourceStat.size > MAX_ZIP_SOURCE_BYTES) {
      fail(`zip source too large (${sourceStat.size} bytes) for ${sourcePath}; max ${MAX_ZIP_SOURCE_BYTES}`);
    }

    const archiveDir = resolveArchiveDir(scopeDir, sourcePath, targetMeta);
    const baseName = path.basename(sourcePath);
    const zipBase = baseName.endsWith('.zip') ? `${baseName}.packed.zip` : `${baseName}.zip`;
    let destinationPath = ensureInsideScope(scopeDir, path.join(archiveDir, zipBase));
    destinationPath = ensureUniquePath(destinationPath);

    scriptLines.push(`zip ${JSON.stringify(destinationPath)} ${JSON.stringify(sourcePath)}`);

    let zipBytes: number | null = null;
    if (!dryRun) {
      const sourceBuffer = fs.readFileSync(sourcePath);
      const zipBuffer = createSingleFileZipBuffer(baseName, sourceBuffer, sourceStat.mtime);
      ensureParentDir(destinationPath);
      fs.writeFileSync(destinationPath, zipBuffer, { flag: 'wx' });
      zipBytes = zipBuffer.length;
      if (deleteSource) {
        fs.rmSync(sourcePath, { recursive: false, force: false });
      }
    }

    archives.push({
      source_path: sourcePath,
      destination_path: destinationPath,
      source_bytes: sourceStat.size,
      archive_bytes: zipBytes,
      deleted_source: deleteSource && !dryRun
    });
  }

  return {
    operation: 'zip_files_over_size',
    min_size_bytes: minSizeBytes,
    archive_count: archives.length,
    delete_source: deleteSource,
    archives,
    script: scriptLines.join('\n'),
    applied: !dryRun
  };
}

function executeUpdate(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const operation = normalizeScriptOperation(chooseUpdateOperation(targetMeta));
  if (SCRIPT_MUTATION_OPERATIONS.has(operation)) {
    return executeScriptedOperation(scopeDir, { ...targetMeta, operation }, dryRun);
  }

  const sourcePath = resolveInScope(
    scopeDir,
    targetMeta.resolved_path || targetMeta.path,
    'resolved_path/path'
  );
  if (!fs.existsSync(sourcePath)) {
    fail(`update source path not found: ${sourcePath}`);
  }

  if (operation === 'rename') {
    const newName = asOptionalString(targetMeta.new_name);
    if (!newName) {
      fail('rename operation requires new_name');
    }
    if (newName.includes('/') || newName.includes('\\')) {
      fail('new_name must be a single filename, not a path');
    }

    const destinationPath = ensureInsideScope(scopeDir, path.join(path.dirname(sourcePath), newName));
    const script = `mv ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`;

    if (!dryRun) {
      fs.renameSync(sourcePath, destinationPath);
    }

    return {
      operation: 'rename',
      source_path: sourcePath,
      destination_path: destinationPath,
      script,
      applied: !dryRun
    };
  }

  if (operation === 'move') {
    const rawDestination = asOptionalString(targetMeta.destination);
    if (!rawDestination) {
      fail('move operation requires destination');
    }

    let destinationPath = resolveInScope(scopeDir, rawDestination, 'destination');
    if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
      destinationPath = ensureInsideScope(
        scopeDir,
        path.join(destinationPath, path.basename(sourcePath))
      );
    }

    const script = `mv ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`;

    if (!dryRun) {
      ensureParentDir(destinationPath);
      fs.renameSync(sourcePath, destinationPath);
    }

    return {
      operation: 'move',
      source_path: sourcePath,
      destination_path: destinationPath,
      script,
      applied: !dryRun
    };
  }

  if (operation === 'write' || operation === 'replace') {
    const content = typeof targetMeta.content === 'string' ? targetMeta.content : '';
    const script = `cat > ${JSON.stringify(sourcePath)} <<'EOF'\n${content}\nEOF`;

    if (!dryRun) {
      if (!fs.statSync(sourcePath).isFile()) {
        fail(`write operation requires a file target: ${sourcePath}`);
      }
      fs.writeFileSync(sourcePath, content, { encoding: 'utf8', flag: 'w' });
    }

    return {
      operation: 'write',
      path: sourcePath,
      bytes_written: Buffer.byteLength(content, 'utf8'),
      script,
      applied: !dryRun
    };
  }

  if (operation === 'append') {
    const content = typeof targetMeta.content === 'string' ? targetMeta.content : '';
    const script = `cat >> ${JSON.stringify(sourcePath)} <<'EOF'\n${content}\nEOF`;

    if (!dryRun) {
      if (!fs.statSync(sourcePath).isFile()) {
        fail(`append operation requires a file target: ${sourcePath}`);
      }
      fs.appendFileSync(sourcePath, content, { encoding: 'utf8' });
    }

    return {
      operation: 'append',
      path: sourcePath,
      bytes_appended: Buffer.byteLength(content, 'utf8'),
      script,
      applied: !dryRun
    };
  }

  fail(
    `unsupported update operation '${operation}'. Supported: rename|move|write|append|cleanup|delete_by_extension|zip_files_over_size|run_script`
  );
}

function executeDelete(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const operation = normalizeScriptOperation(targetMeta.operation || '');
  if (SCRIPT_MUTATION_OPERATIONS.has(operation)) {
    return executeScriptedOperation(scopeDir, { ...targetMeta, operation }, dryRun);
  }

  const fullPath = resolveInScope(
    scopeDir,
    targetMeta.resolved_path || targetMeta.path,
    'resolved_path/path'
  );

  if (!fs.existsSync(fullPath)) {
    fail(`delete target not found: ${fullPath}`);
  }

  const stat = fs.statSync(fullPath);
  const recursive = targetMeta.recursive !== false;
  if (stat.isDirectory() && !recursive) {
    fail(`delete target is a directory; set recursive=true to remove: ${fullPath}`);
  }

  const script = stat.isDirectory()
    ? `rm -rf ${JSON.stringify(fullPath)}`
    : `rm -f ${JSON.stringify(fullPath)}`;

  if (!dryRun) {
    fs.rmSync(fullPath, { recursive, force: false });
  }

  return {
    operation: 'delete',
    path: fullPath,
    kind: stat.isDirectory() ? 'directory' : 'file',
    recursive,
    script,
    applied: !dryRun
  };
}

interface ExecuteMutationResult {
  scopeDir: string;
  dryRun: boolean;
  result: MutationResult;
}

function executeMutation(action: string, targetMeta: TargetMeta): ExecuteMutationResult {
  const scopeDir = path.resolve(asOptionalString(targetMeta.scope_dir) || DEFAULT_SCOPE_DIR);
  ensureDirectory(scopeDir, 'scope_dir');

  const dryRun = targetMeta.dry_run === true;
  const scriptedOperation = normalizeScriptOperation(targetMeta.operation || '');

  let result: MutationResult;
  if (SCRIPT_MUTATION_OPERATIONS.has(scriptedOperation)) {
    result = executeScriptedOperation(scopeDir, { ...targetMeta, operation: scriptedOperation }, dryRun);
  } else if (action === 'create') {
    result = executeCreate(scopeDir, targetMeta, dryRun);
  } else if (action === 'update') {
    result = executeUpdate(scopeDir, targetMeta, dryRun);
  } else {
    result = executeDelete(scopeDir, targetMeta, dryRun);
  }

  return { scopeDir, dryRun, result };
}

try {
  const { request } = pluginContext();
  const requestAction = normalizeAction(request.action);
  if (!SUPPORTED_REQUEST_ACTIONS.has(requestAction)) {
    fail(`explorer_write_agent does not support request action '${requestAction}'`);
  }

  let targetMeta = parseTargetMeta(request.target);
  const action = normalizeAction(targetMeta.desired_action || requestAction);
  if (!MUTATION_ACTIONS.has(action)) {
    fail(
      `explorer_write_agent requires desired_action=create|update|delete (got '${action || requestAction}')`
    );
  }

  const channel = asOptionalString(targetMeta.socket_channel);
  if (!channel) {
    fail('explorer_write_agent requires socket_channel handoff from explorer_read_agent');
  }

  const socketApplied = applySocketHandoff(targetMeta, action);
  targetMeta = socketApplied.targetMeta;
  const { scopeDir, dryRun, result } = executeMutation(action, targetMeta);

  respond({
    ok: true,
    plugin: 'explorer_write_agent',
    mode: 'socket_apply',
    request_action: requestAction,
    desired_action: action,
    scope_dir: scopeDir,
    dry_run: dryRun,
    socket_handoff: socketApplied.handoff,
    result
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
