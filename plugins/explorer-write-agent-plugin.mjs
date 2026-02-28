import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { pluginContext, respond, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_REQUEST_ACTIONS = new Set(['create', 'read', 'update', 'delete']);
const MUTATION_ACTIONS = new Set(['create', 'update', 'delete']);
const DEFAULT_SCOPE_DIR = process.env.PINOKIO_EXPLORER_SCOPE || '/app';
const SCRIPTED_MUTATION_OPERATIONS = new Set([
  'delete_by_extension',
  'cleanup',
  'zip_files_over_size',
  'archive_large_files',
  'run_script'
]);
const DEFAULT_CLEANUP_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
const DEFAULT_CLEANUP_EXTENSIONS = new Set(['tmp', 'bak', 'old', 'log', 'dmp', 'rar']);
const MAX_ZIP_SOURCE_BYTES = 512 * 1024 * 1024;
const PACKAGE_STEP_TIMEOUT_MS = 600_000;
const PACKAGE_LEDGER_VERSION = 1;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      if ((c & 1) !== 0) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c >>> 0;
  }
  return table;
})();

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

function normalizeStage(value) {
  const stage = String(value || '').trim().toLowerCase();
  return stage || 'collect_socket';
}

function asOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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

function parseExtensionList(targetMeta) {
  const out = [];
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

function parseTargetMeta(target) {
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
      return parsed;
    }
  } catch {
    return { path: trimmed };
  }
  return {};
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

function resolveInScope(scopeDir, value, fieldName) {
  const input = asOptionalString(value);
  if (!input) {
    fail(`${fieldName} is required`);
  }
  if (path.isAbsolute(input)) {
    return ensureInsideScope(scopeDir, input);
  }
  return ensureInsideScope(scopeDir, path.join(scopeDir, input));
}

function inferCreateKind(pathValue, requestedKind) {
  const explicitKind = asOptionalString(requestedKind);
  if (explicitKind === 'file' || explicitKind === 'directory') {
    return explicitKind;
  }
  if (String(pathValue || '').endsWith('/')) {
    return 'directory';
  }
  return 'file';
}

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function extensionFromName(name) {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index <= 0 || index === value.length - 1) {
    return '';
  }
  return value.slice(index + 1).toLowerCase();
}

function chooseUpdateOperation(targetMeta) {
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

function extractSocketResultPayload(targetMeta) {
  const direct =
    targetMeta.__socket_result &&
    typeof targetMeta.__socket_result === 'object' &&
    !Array.isArray(targetMeta.__socket_result)
      ? targetMeta.__socket_result
      : null;

  if (direct) {
    return direct;
  }

  const all = Array.isArray(targetMeta.__socket_results) ? targetMeta.__socket_results : [];
  for (const item of all) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return item;
    }
  }

  return null;
}

function applySocketHandoff(targetMeta, desiredAction) {
  const socketResult = extractSocketResultPayload(targetMeta);
  if (!socketResult) {
    fail('missing __socket_result payload after socket consume stage');
  }

  const messages = Array.isArray(socketResult.messages) ? socketResult.messages : [];
  if (messages.length === 0) {
    const channel = asOptionalString(socketResult.channel) || asOptionalString(targetMeta.socket_channel);
    fail(
      `socket consume returned no messages${channel ? ` on channel '${channel}'` : ''}. retry request after read agent publishes handoff`
    );
  }

  const envelope = messages[messages.length - 1];
  const payload =
    envelope && envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload
      : null;
  if (!payload) {
    fail('socket handoff payload is missing or malformed');
  }
  if (String(payload.schema || '') !== 'pinokio.explorer.handoff/v1') {
    fail('socket handoff payload schema mismatch');
  }

  const payloadAction = normalizeAction(payload.desired_action || '');
  if (!payloadAction || payloadAction !== desiredAction) {
    fail(
      `socket handoff action mismatch: expected '${desiredAction}', received '${payloadAction || 'unknown'}'`
    );
  }

  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};

  const merged = { ...targetMeta };
  if (!asOptionalString(merged.scope_dir) && asOptionalString(payload.scope_dir)) {
    merged.scope_dir = payload.scope_dir;
  }
  if (!asOptionalString(merged.query) && asOptionalString(payload.query)) {
    merged.query = payload.query;
  }
  if (!asOptionalString(merged.resolved_path) && asOptionalString(payload.resolved_path)) {
    merged.resolved_path = payload.resolved_path;
  }
  if (!asOptionalString(merged.path) && asOptionalString(payload.resolved_path)) {
    merged.path = payload.resolved_path;
  }
  if (!asOptionalString(merged.operation) && asOptionalString(options.operation)) {
    merged.operation = normalizeScriptOperation(options.operation);
  } else if (asOptionalString(merged.operation)) {
    merged.operation = normalizeScriptOperation(merged.operation);
  }
  if (!asOptionalString(merged.kind) && asOptionalString(options.kind)) {
    merged.kind = options.kind;
  }
  if (typeof merged.content !== 'string' && typeof options.content === 'string') {
    merged.content = options.content;
  }
  if (typeof merged.overwrite !== 'boolean' && typeof options.overwrite === 'boolean') {
    merged.overwrite = options.overwrite;
  }
  if (typeof merged.ensure_parent !== 'boolean' && typeof options.ensure_parent === 'boolean') {
    merged.ensure_parent = options.ensure_parent;
  }
  if (!asOptionalString(merged.new_name) && asOptionalString(options.new_name)) {
    merged.new_name = options.new_name;
  }
  if (!asOptionalString(merged.destination) && asOptionalString(options.destination)) {
    merged.destination = options.destination;
  }
  if (typeof merged.recursive !== 'boolean' && typeof options.recursive === 'boolean') {
    merged.recursive = options.recursive;
  }
  if (typeof merged.dry_run !== 'boolean' && typeof options.dry_run === 'boolean') {
    merged.dry_run = options.dry_run;
  }
  if (!merged.extensions && options.extensions) {
    merged.extensions = options.extensions;
  }
  if (!asOptionalString(merged.cleanup_profile) && asOptionalString(options.cleanup_profile)) {
    merged.cleanup_profile = options.cleanup_profile;
  }
  if (!toPositiveInt(merged.min_size_bytes) && toPositiveInt(options.min_size_bytes)) {
    merged.min_size_bytes = toPositiveInt(options.min_size_bytes);
  }
  if (!asOptionalString(merged.archive_destination) && asOptionalString(options.archive_destination)) {
    merged.archive_destination = options.archive_destination;
  }
  if (typeof merged.delete_source !== 'boolean' && typeof options.delete_source === 'boolean') {
    merged.delete_source = options.delete_source;
  }
  if (!Array.isArray(merged.handoff_matches) && Array.isArray(payload.matches)) {
    merged.handoff_matches = payload.matches;
  }
  if (!merged.script_plan && payload.script_plan && typeof payload.script_plan === 'object') {
    merged.script_plan = payload.script_plan;
  }
  if (!merged.script && options.script) {
    merged.script = options.script;
  }
  if (
    typeof merged.require_handoff_matches !== 'boolean' &&
    typeof options.require_handoff_matches === 'boolean'
  ) {
    merged.require_handoff_matches = options.require_handoff_matches;
  }

  return {
    targetMeta: merged,
    handoff: {
      channel: asOptionalString(socketResult.channel) || asOptionalString(targetMeta.socket_channel),
      sender_agent_id: asOptionalString(envelope.sender_agent_id),
      seq: Number(envelope.seq || 0),
      request_id: asOptionalString(payload.request_id),
      message_count: messages.length
    }
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const dt = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, dt.getFullYear()));
  const month = dt.getMonth() + 1;
  const day = dt.getDate();
  const hour = dt.getHours();
  const minute = dt.getMinutes();
  const second = Math.floor(dt.getSeconds() / 2);
  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function createSingleFileZipBuffer(entryName, content, modifiedAt) {
  const fileNameBuffer = Buffer.from(entryName.replace(/\\/g, '/'), 'utf8');
  const compressed = zlib.deflateRawSync(content, { level: 9 });
  const crc = crc32(content);
  const { dosTime, dosDate } = toDosDateTime(modifiedAt);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileNameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralDirectory = Buffer.concat([centralHeader, fileNameBuffer]);
  const localSection = Buffer.concat([localHeader, fileNameBuffer, compressed]);

  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(0, 4);
  endOfCentral.writeUInt16LE(0, 6);
  endOfCentral.writeUInt16LE(1, 8);
  endOfCentral.writeUInt16LE(1, 10);
  endOfCentral.writeUInt32LE(centralDirectory.length, 12);
  endOfCentral.writeUInt32LE(localSection.length, 16);
  endOfCentral.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralDirectory, endOfCentral]);
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '');
}

function createPdfBufferFromText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .slice(0, 200)
    .map((line) => escapePdfText(line));
  const nonEmpty = lines.length > 0 ? lines : [''];
  const ops = ['BT', '/F1 12 Tf', '50 780 Td'];
  for (let i = 0; i < nonEmpty.length; i += 1) {
    ops.push(`(${nonEmpty[i]}) Tj`);
    if (i < nonEmpty.length - 1) {
      ops.push('0 -16 Td');
    }
  }
  ops.push('ET');
  const streamData = `${ops.join('\n')}\n`;
  const streamLength = Buffer.byteLength(streamData, 'utf8');

  const objects = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    4: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    5: `<< /Length ${streamLength} >>\nstream\n${streamData}endstream`
  };

  const chunks = [Buffer.from('%PDF-1.4\n', 'utf8')];
  const offsets = [0];
  let cursor = chunks[0].length;

  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = cursor;
    const objectChunk = Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`, 'utf8');
    chunks.push(objectChunk);
    cursor += objectChunk.length;
  }

  const xrefOffset = cursor;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'utf8'));

  return Buffer.concat(chunks);
}

function ensureUniquePath(candidatePath) {
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

function extractHandoffMatches(scopeDir, targetMeta, options = {}) {
  const rawMatches = Array.isArray(targetMeta.handoff_matches)
    ? targetMeta.handoff_matches
    : Array.isArray(targetMeta.matches)
      ? targetMeta.matches
      : [];
  const out = [];
  const seen = new Set();

  for (const item of rawMatches) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const rawPath = asOptionalString(item.path);
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
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    seen.add(fullPath);
    out.push({
      path: fullPath,
      name: asOptionalString(item.name) || path.basename(fullPath),
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

function executeCreate(scopeDir, targetMeta, dryRun) {
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

function executeDeleteByExtension(scopeDir, targetMeta, dryRun) {
  const extensions = parseExtensionList(targetMeta);
  if (extensions.length === 0) {
    fail('delete_by_extension requires target.extensions');
  }
  const extensionSet = new Set(extensions);
  const handoffMatches = extractHandoffMatches(scopeDir, targetMeta);
  const candidates = handoffMatches.filter((item) => item.kind === 'file' && extensionSet.has(normalizeExtensionToken(extensionFromName(item.name))));

  if (candidates.length === 0) {
    fail(`delete_by_extension found no matching files for extensions: ${extensions.join(', ')}`);
  }

  const scriptLines = [];
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

function executeCleanup(scopeDir, targetMeta, dryRun) {
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

  const scriptLines = [];
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

function resolveArchiveDir(scopeDir, sourcePath, targetMeta) {
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

function executeZipFilesOverSize(scopeDir, targetMeta, dryRun) {
  const minSizeBytes =
    toPositiveInt(targetMeta.min_size_bytes) ||
    (targetMeta.script_plan && toPositiveInt(targetMeta.script_plan.min_size_bytes));
  if (!minSizeBytes) {
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

  const archives = [];
  const scriptLines = [];

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

    let zipBytes = null;
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

function normalizeScriptStepOperation(value) {
  const op = normalizeAction(value);
  if (!op) {
    return '';
  }
  if (op === 'mkdirp') {
    return 'mkdir';
  }
  if (op === 'write' || op === 'replace') {
    return 'write_file';
  }
  if (op === 'append') {
    return 'append_file';
  }
  if (op === 'copy') {
    return 'copy_file';
  }
  if (op === 'delete' || op === 'remove') {
    return 'delete_path';
  }
  if (op === 'zip') {
    return 'zip_file';
  }
  if (op === 'install_packages' || op === 'apt_install') {
    return 'ensure_packages';
  }
  if (op === 'uninstall_packages' || op === 'apt_remove' || op === 'purge_packages') {
    return 'remove_packages';
  }
  if (op === 'restore_ledger_packages' || op === 'restore_packages') {
    return 'restore_packages';
  }
  return op;
}

function parseScriptDefinition(targetMeta) {
  let script = null;
  if (Array.isArray(targetMeta.script)) {
    script = { steps: targetMeta.script };
  } else if (targetMeta.script && typeof targetMeta.script === 'object' && !Array.isArray(targetMeta.script)) {
    script = targetMeta.script;
  } else if (
    targetMeta.script_plan &&
    typeof targetMeta.script_plan === 'object' &&
    !Array.isArray(targetMeta.script_plan) &&
    targetMeta.script_plan.script &&
    typeof targetMeta.script_plan.script === 'object' &&
    !Array.isArray(targetMeta.script_plan.script)
  ) {
    script = targetMeta.script_plan.script;
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
    fail('run_script requires script.steps with at least one step');
  }
  if (rawSteps.length > 200) {
    fail('run_script supports at most 200 steps');
  }

  const steps = rawSteps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      fail(`run_script step #${index + 1} must be an object`);
    }
    const op = normalizeScriptStepOperation(step.op || step.operation);
    if (!op) {
      fail(`run_script step #${index + 1} requires op`);
    }
    return {
      ...step,
      op
    };
  });

  const requireMatches =
    typeof script.require_handoff_matches === 'boolean'
      ? script.require_handoff_matches
      : typeof targetMeta.require_handoff_matches === 'boolean'
        ? targetMeta.require_handoff_matches
        : true;

  return {
    steps,
    stop_on_error: script.stop_on_error !== false,
    require_handoff_matches: requireMatches
  };
}

function resolveTemplateString(value, context) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token) => {
    const key = String(token || '').trim().toLowerCase();
    if (key === 'scope_dir') {
      return String(context.scope_dir || '');
    }
    if (key === 'index') {
      return String(context.index ?? 0);
    }
    if (key.startsWith('match.')) {
      if (!context.match || typeof context.match !== 'object') {
        fail(`template token '${token}' requires for_each_match context`);
      }
      const field = key.slice('match.'.length);
      if (field === 'path') {
        return String(context.match.path || '');
      }
      if (field === 'name') {
        return String(context.match.name || '');
      }
      if (field === 'kind') {
        return String(context.match.kind || '');
      }
      if (field === 'size') {
        return String(context.match.size ?? '');
      }
    }
    fail(`unsupported template token '${token}'`);
  });
}

function resolveScriptPath(scopeDir, rawValue, fieldName, context) {
  const templateValue = resolveTemplateString(rawValue, context);
  const input = asOptionalString(templateValue);
  if (!input) {
    fail(`${fieldName} is required in run_script`);
  }
  if (path.isAbsolute(input)) {
    return ensureInsideScope(scopeDir, input);
  }
  return ensureInsideScope(scopeDir, path.join(scopeDir, input));
}

function resolveScriptString(rawValue, fieldName, context, allowEmpty = false) {
  const templateValue = resolveTemplateString(rawValue, context);
  const value = typeof templateValue === 'string' ? templateValue : String(templateValue ?? '');
  if (!allowEmpty && !value.trim()) {
    fail(`${fieldName} is required in run_script`);
  }
  return value;
}

function filterMatches(matches, selector) {
  const mode = normalizeAction(selector || 'all');
  if (mode === 'file' || mode === 'files') {
    return matches.filter((item) => item.kind === 'file');
  }
  if (mode === 'directory' || mode === 'directories' || mode === 'dir' || mode === 'dirs') {
    return matches.filter((item) => item.kind === 'directory');
  }
  return matches;
}

function isTruthy(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function assertContainerPackageInstallsEnabled(stepOp) {
  if (isTruthy(process.env.PINOKIO_CONTAINER_PACKAGE_INSTALLS_ENABLED)) {
    return;
  }
  fail(
    `${stepOp} is disabled by manager policy. Enable container package installs in /ui/configure (Manager Security Policy) to allow apt/apk/dnf/yum operations.`
  );
}

function sanitizePackageName(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9+._:-]{0,127}$/i.test(raw)) {
    fail(`invalid package name '${raw}'`);
  }
  return raw;
}

function parsePackageList(rawValue, context) {
  const resolved = resolveTemplateString(rawValue, context);
  const items = [];
  if (Array.isArray(resolved)) {
    for (const value of resolved) {
      const token = sanitizePackageName(resolveTemplateString(value, context));
      if (token) {
        items.push(token);
      }
    }
  } else if (typeof resolved === 'string') {
    for (const token of resolved.split(/[\s,;|]+/)) {
      const normalized = sanitizePackageName(token);
      if (normalized) {
        items.push(normalized);
      }
    }
  } else if (resolved !== null && resolved !== undefined) {
    const normalized = sanitizePackageName(String(resolved));
    if (normalized) {
      items.push(normalized);
    }
  }

  const deduped = Array.from(new Set(items));
  if (deduped.length === 0) {
    fail('run_script package operations require at least one package');
  }
  return deduped;
}

function commandAvailable(command) {
  const probe = spawnSync('which', [command], { encoding: 'utf8' });
  return probe.status === 0;
}

function detectPackageManager(preferred) {
  const normalizedPreferred = asOptionalString(preferred)?.toLowerCase() || null;
  const supported = ['apt-get', 'apk', 'dnf', 'yum'];
  const candidates = normalizedPreferred
    ? [normalizedPreferred, ...supported.filter((item) => item !== normalizedPreferred)]
    : supported;

  for (const candidate of candidates) {
    if (!supported.includes(candidate)) {
      continue;
    }
    if (commandAvailable(candidate)) {
      return candidate;
    }
  }

  fail(
    `no supported package manager found in this container. checked: ${supported.join(', ')}`
  );
}

function packageInstallPlan(manager, packages, updateIndex) {
  if (manager === 'apt-get') {
    const plan = [];
    if (updateIndex !== false) {
      plan.push({ command: 'apt-get', args: ['update'] });
    }
    plan.push({ command: 'apt-get', args: ['install', '-y', ...packages] });
    return plan;
  }
  if (manager === 'apk') {
    return [{ command: 'apk', args: ['add', '--no-cache', ...packages] }];
  }
  if (manager === 'dnf') {
    return [{ command: 'dnf', args: ['install', '-y', ...packages] }];
  }
  if (manager === 'yum') {
    return [{ command: 'yum', args: ['install', '-y', ...packages] }];
  }
  fail(`unsupported package manager '${manager}'`);
}

function packageRemovePlan(manager, packages, autoremove) {
  if (manager === 'apt-get') {
    const plan = [{ command: 'apt-get', args: ['remove', '-y', ...packages] }];
    if (autoremove) {
      plan.push({ command: 'apt-get', args: ['autoremove', '-y'] });
    }
    return plan;
  }
  if (manager === 'apk') {
    return [{ command: 'apk', args: ['del', ...packages] }];
  }
  if (manager === 'dnf') {
    return [{ command: 'dnf', args: ['remove', '-y', ...packages] }];
  }
  if (manager === 'yum') {
    return [{ command: 'yum', args: ['remove', '-y', ...packages] }];
  }
  fail(`unsupported package manager '${manager}'`);
}

function shellLineForCommand(command, args) {
  return [command, ...args.map((arg) => JSON.stringify(arg))].join(' ');
}

function runPackagePlan(plan, dryRun) {
  const outputs = [];
  if (dryRun) {
    return outputs;
  }
  for (const step of plan) {
    const out = spawnSync(step.command, step.args, {
      encoding: 'utf8',
      timeout: PACKAGE_STEP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
      env: {
        ...process.env,
        DEBIAN_FRONTEND: 'noninteractive'
      }
    });
    if (out.error) {
      if (out.error.code === 'ETIMEDOUT') {
        fail(
          `package command timed out after ${PACKAGE_STEP_TIMEOUT_MS}ms: ${shellLineForCommand(
            step.command,
            step.args
          )}`
        );
      }
      fail(
        `package command failed to start: ${shellLineForCommand(step.command, step.args)} (${out.error.message})`
      );
    }
    const output = `${String(out.stdout || '')}${String(out.stderr || '')}`.trim();
    outputs.push({
      command: step.command,
      args: step.args,
      status: out.status ?? 1,
      output: output.slice(-4000)
    });
    if (out.status !== 0) {
      fail(
        `package command failed (${out.status}): ${shellLineForCommand(step.command, step.args)}${output ? `\n${output}` : ''}`
      );
    }
  }
  return outputs;
}

function resolvePackageLedgerPath() {
  return asOptionalString(process.env.PINOKIO_PACKAGE_LEDGER_PATH) || '/app/.pka/package-ledger.json';
}

function normalizeLedgerScopeData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manager: null, packages: [] };
  }
  const manager = asOptionalString(raw.manager);
  const packages = [];
  if (Array.isArray(raw.packages)) {
    for (const value of raw.packages) {
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      if (/^[a-z0-9][a-z0-9+._:-]{0,127}$/i.test(trimmed)) {
        packages.push(trimmed);
      }
    }
  }
  return {
    manager,
    packages: Array.from(new Set(packages))
  };
}

function loadPackageLedger(ledgerPath) {
  const empty = {
    version: PACKAGE_LEDGER_VERSION,
    updated_at: new Date().toISOString(),
    scopes: {},
    events: []
  };
  if (!fs.existsSync(ledgerPath)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return empty;
    }
    const scopes = {};
    if (parsed.scopes && typeof parsed.scopes === 'object' && !Array.isArray(parsed.scopes)) {
      for (const [key, value] of Object.entries(parsed.scopes)) {
        scopes[key] = normalizeLedgerScopeData(value);
      }
    }
    const events = Array.isArray(parsed.events)
      ? parsed.events.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)).slice(-5000)
      : [];
    return {
      version: PACKAGE_LEDGER_VERSION,
      updated_at: asOptionalString(parsed.updated_at) || empty.updated_at,
      scopes,
      events
    };
  } catch {
    return empty;
  }
}

function savePackageLedger(ledgerPath, ledger) {
  ensureParentDir(ledgerPath);
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify(
      {
        ...ledger,
        version: PACKAGE_LEDGER_VERSION,
        updated_at: new Date().toISOString(),
        events: Array.isArray(ledger.events) ? ledger.events.slice(-5000) : []
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function ledgerScopeKey(scopeDir) {
  const resource = asOptionalString(process.env.PINOKIO_SOCKET_RESOURCE) || 'unknown_resource';
  const agentId = asOptionalString(process.env.PINOKIO_SOCKET_AGENT_ID) || 'unknown_agent';
  return `${resource}::${agentId}::${scopeDir}`;
}

function updatePackageLedger(scopeDir, manager, packages, action, dryRun) {
  const ledgerPath = resolvePackageLedgerPath();
  const scopeKey = ledgerScopeKey(scopeDir);
  if (dryRun) {
    return {
      ledger_path: ledgerPath,
      scope_key: scopeKey,
      recorded: false
    };
  }

  const ledger = loadPackageLedger(ledgerPath);
  const existing = normalizeLedgerScopeData(ledger.scopes[scopeKey]);
  const currentPackages = new Set(existing.packages);
  const normalizedPackages = packages.map((value) => sanitizePackageName(value)).filter(Boolean);

  if (action === 'install') {
    for (const pkg of normalizedPackages) {
      currentPackages.add(pkg);
    }
  } else if (action === 'remove') {
    for (const pkg of normalizedPackages) {
      currentPackages.delete(pkg);
    }
  }

  ledger.scopes[scopeKey] = {
    manager,
    packages: Array.from(currentPackages).sort((a, b) => a.localeCompare(b))
  };
  const resource = asOptionalString(process.env.PINOKIO_SOCKET_RESOURCE);
  const agentId = asOptionalString(process.env.PINOKIO_SOCKET_AGENT_ID);
  ledger.events.push({
    at: new Date().toISOString(),
    action,
    manager,
    packages: normalizedPackages,
    scope_key: scopeKey,
    scope_dir: scopeDir,
    resource,
    agent_id: agentId
  });
  savePackageLedger(ledgerPath, ledger);

  return {
    ledger_path: ledgerPath,
    scope_key: scopeKey,
    recorded: true,
    installed_packages: ledger.scopes[scopeKey].packages
  };
}

function readScopePackagesFromLedger(scopeDir) {
  const ledgerPath = resolvePackageLedgerPath();
  const scopeKey = ledgerScopeKey(scopeDir);
  const ledger = loadPackageLedger(ledgerPath);
  const scoped = normalizeLedgerScopeData(ledger.scopes[scopeKey]);
  return {
    ledger_path: ledgerPath,
    scope_key: scopeKey,
    manager: scoped.manager,
    packages: scoped.packages
  };
}

function executeEnsurePackagesStep(scopeDir, step, context, dryRun) {
  assertContainerPackageInstallsEnabled('ensure_packages');
  const packages = parsePackageList(step.packages ?? step.package ?? step.names, context);
  const manager = detectPackageManager(resolveTemplateString(step.package_manager ?? step.manager, context));
  const plan = packageInstallPlan(manager, packages, step.update_index !== false);
  const outputs = runPackagePlan(plan, dryRun);
  const ledger = updatePackageLedger(scopeDir, manager, packages, 'install', dryRun);
  return {
    operation: 'ensure_packages',
    manager,
    packages,
    command_count: plan.length,
    script: plan.map((entry) => shellLineForCommand(entry.command, entry.args)).join('\n'),
    command_outputs: outputs,
    ledger,
    applied: !dryRun
  };
}

function executeRemovePackagesStep(scopeDir, step, context, dryRun) {
  assertContainerPackageInstallsEnabled('remove_packages');
  const packages = parsePackageList(step.packages ?? step.package ?? step.names, context);
  const manager = detectPackageManager(resolveTemplateString(step.package_manager ?? step.manager, context));
  const plan = packageRemovePlan(manager, packages, step.autoremove !== false);
  const outputs = runPackagePlan(plan, dryRun);
  const ledger = updatePackageLedger(scopeDir, manager, packages, 'remove', dryRun);
  return {
    operation: 'remove_packages',
    manager,
    packages,
    command_count: plan.length,
    script: plan.map((entry) => shellLineForCommand(entry.command, entry.args)).join('\n'),
    command_outputs: outputs,
    ledger,
    applied: !dryRun
  };
}

function executeRestorePackagesStep(scopeDir, step, context, dryRun) {
  assertContainerPackageInstallsEnabled('restore_packages');
  const fromLedger = readScopePackagesFromLedger(scopeDir);
  if (!Array.isArray(fromLedger.packages) || fromLedger.packages.length === 0) {
    fail(
      `restore_packages found no tracked packages for this scope in ${fromLedger.ledger_path}`
    );
  }
  const manager = detectPackageManager(
    resolveTemplateString(step.package_manager ?? step.manager, context) || fromLedger.manager
  );
  const plan = packageInstallPlan(manager, fromLedger.packages, step.update_index !== false);
  const outputs = runPackagePlan(plan, dryRun);
  const ledger = updatePackageLedger(scopeDir, manager, fromLedger.packages, 'install', dryRun);
  return {
    operation: 'restore_packages',
    manager,
    packages: fromLedger.packages,
    command_count: plan.length,
    script: plan.map((entry) => shellLineForCommand(entry.command, entry.args)).join('\n'),
    command_outputs: outputs,
    ledger,
    restored_from: fromLedger.ledger_path,
    applied: !dryRun
  };
}

function executeRunScriptStep(scopeDir, step, context, dryRun) {
  const op = normalizeScriptStepOperation(step.op || step.operation);

  if (op === 'mkdir') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const recursive = step.recursive !== false;
    if (!dryRun) {
      fs.mkdirSync(fullPath, { recursive });
    }
    return {
      operation: 'mkdir',
      path: fullPath,
      recursive,
      script: `mkdir ${recursive ? '-p ' : ''}${JSON.stringify(fullPath)}`.trim()
    };
  }

  if (op === 'write_file') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const overwrite = step.overwrite !== false;
    const ensureParent = step.ensure_parent !== false;
    const content = resolveScriptString(step.content ?? '', 'content', context, true);
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && !overwrite) {
        fail(`write_file target already exists: ${fullPath}`);
      }
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        fail(`write_file target is a directory: ${fullPath}`);
      }
      fs.writeFileSync(fullPath, content, {
        encoding: 'utf8',
        flag: overwrite ? 'w' : 'wx'
      });
    }
    return {
      operation: 'write_file',
      path: fullPath,
      overwrite,
      bytes_written: Buffer.byteLength(content, 'utf8'),
      script: overwrite
        ? `cat > ${JSON.stringify(fullPath)} <<'EOF'\n${content}\nEOF`
        : `cat > ${JSON.stringify(fullPath)} (fails if exists)`
    };
  }

  if (op === 'append_file') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const ensureParent = step.ensure_parent !== false;
    const content = resolveScriptString(step.content ?? '', 'content', context, true);
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        fail(`append_file target is a directory: ${fullPath}`);
      }
      fs.appendFileSync(fullPath, content, { encoding: 'utf8' });
    }
    return {
      operation: 'append_file',
      path: fullPath,
      bytes_appended: Buffer.byteLength(content, 'utf8'),
      script: `cat >> ${JSON.stringify(fullPath)} <<'EOF'\n${content}\nEOF`
    };
  }

  if (op === 'create_pdf') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const overwrite = step.overwrite !== false;
    const ensureParent = step.ensure_parent !== false;
    const content = resolveScriptString(step.content ?? '', 'content', context, true);
    const pdfBuffer = createPdfBufferFromText(content);
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && !overwrite) {
        fail(`create_pdf target already exists: ${fullPath}`);
      }
      fs.writeFileSync(fullPath, pdfBuffer, { flag: overwrite ? 'w' : 'wx' });
    }
    return {
      operation: 'create_pdf',
      path: fullPath,
      overwrite,
      bytes_written: pdfBuffer.length,
      script: `create_pdf ${JSON.stringify(fullPath)} <<'TEXT'\n${content}\nTEXT`
    };
  }

  if (op === 'delete_path') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const recursive = step.recursive !== false;
    const ignoreMissing = step.ignore_missing === true;
    if (!dryRun) {
      if (!fs.existsSync(fullPath)) {
        if (!ignoreMissing) {
          fail(`delete_path target not found: ${fullPath}`);
        }
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && !recursive) {
          fail(`delete_path target is a directory; set recursive=true: ${fullPath}`);
        }
        fs.rmSync(fullPath, { recursive, force: false });
      }
    }
    return {
      operation: 'delete_path',
      path: fullPath,
      recursive,
      ignore_missing: ignoreMissing,
      script: recursive
        ? `rm -rf ${JSON.stringify(fullPath)}`
        : `rm -f ${JSON.stringify(fullPath)}`
    };
  }

  if (op === 'rename') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const newName = resolveScriptString(step.new_name, 'new_name', context);
    if (newName.includes('/') || newName.includes('\\')) {
      fail('rename new_name must be a single filename');
    }
    const destinationPath = ensureInsideScope(scopeDir, path.join(path.dirname(sourcePath), newName));
    if (!dryRun) {
      if (!fs.existsSync(sourcePath)) {
        fail(`rename source does not exist: ${sourcePath}`);
      }
      fs.renameSync(sourcePath, destinationPath);
    }
    return {
      operation: 'rename',
      source_path: sourcePath,
      destination_path: destinationPath,
      script: `mv ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`
    };
  }

  if (op === 'move') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    let destinationPath = resolveScriptPath(scopeDir, step.destination, 'destination', context);
    if (!dryRun) {
      if (!fs.existsSync(sourcePath)) {
        fail(`move source does not exist: ${sourcePath}`);
      }
      if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
        destinationPath = ensureInsideScope(scopeDir, path.join(destinationPath, path.basename(sourcePath)));
      }
      ensureParentDir(destinationPath);
      fs.renameSync(sourcePath, destinationPath);
    }
    return {
      operation: 'move',
      source_path: sourcePath,
      destination_path: destinationPath,
      script: `mv ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`
    };
  }

  if (op === 'copy_file') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const overwrite = step.overwrite === true;
    let destinationPath = resolveScriptPath(scopeDir, step.destination, 'destination', context);
    if (!dryRun) {
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        fail(`copy_file source must be a file: ${sourcePath}`);
      }
      if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
        destinationPath = ensureInsideScope(scopeDir, path.join(destinationPath, path.basename(sourcePath)));
      }
      if (fs.existsSync(destinationPath) && !overwrite) {
        fail(`copy_file destination already exists: ${destinationPath}`);
      }
      ensureParentDir(destinationPath);
      fs.copyFileSync(sourcePath, destinationPath);
    }
    return {
      operation: 'copy_file',
      source_path: sourcePath,
      destination_path: destinationPath,
      overwrite,
      script: `cp ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`
    };
  }

  if (op === 'zip_file') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const deleteSource = step.delete_source === true;
    const destinationRaw = asOptionalString(resolveTemplateString(step.destination, context));
    if (!dryRun) {
      if (!fs.existsSync(sourcePath)) {
        fail(`zip_file source not found: ${sourcePath}`);
      }
      const sourceStat = fs.statSync(sourcePath);
      if (!sourceStat.isFile()) {
        fail(`zip_file source must be a file: ${sourcePath}`);
      }
      if (sourceStat.size > MAX_ZIP_SOURCE_BYTES) {
        fail(`zip_file source too large (${sourceStat.size} bytes): ${sourcePath}`);
      }
    }
    const sourceStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const baseName = path.basename(sourcePath);
    const defaultZipName = baseName.endsWith('.zip') ? `${baseName}.packed.zip` : `${baseName}.zip`;
    let destinationPath = destinationRaw
      ? resolveScriptPath(scopeDir, destinationRaw, 'destination', context)
      : ensureInsideScope(scopeDir, path.join(path.dirname(sourcePath), defaultZipName));
    if (!path.extname(destinationPath)) {
      destinationPath = ensureInsideScope(scopeDir, path.join(destinationPath, defaultZipName));
    }
    destinationPath = ensureUniquePath(destinationPath);

    if (!dryRun) {
      const sourceBuffer = fs.readFileSync(sourcePath);
      const zipBuffer = createSingleFileZipBuffer(baseName, sourceBuffer, sourceStat ? sourceStat.mtime : new Date());
      ensureParentDir(destinationPath);
      fs.writeFileSync(destinationPath, zipBuffer, { flag: 'wx' });
      if (deleteSource) {
        fs.rmSync(sourcePath, { recursive: false, force: false });
      }
    }
    return {
      operation: 'zip_file',
      source_path: sourcePath,
      destination_path: destinationPath,
      delete_source: deleteSource,
      script: `zip ${JSON.stringify(destinationPath)} ${JSON.stringify(sourcePath)}`
    };
  }

  if (op === 'ensure_packages') {
    return executeEnsurePackagesStep(scopeDir, step, context, dryRun);
  }

  if (op === 'remove_packages') {
    return executeRemovePackagesStep(scopeDir, step, context, dryRun);
  }

  if (op === 'restore_packages') {
    return executeRestorePackagesStep(scopeDir, step, context, dryRun);
  }

  fail(`unsupported run_script step op '${op}'`);
}

function executeRunScript(scopeDir, targetMeta, dryRun) {
  const definition = parseScriptDefinition(targetMeta);
  const handoffMatches = extractHandoffMatches(scopeDir, targetMeta, {
    required: definition.require_handoff_matches
  });
  const stepResults = [];
  const scriptLines = [];

  for (let stepIndex = 0; stepIndex < definition.steps.length; stepIndex += 1) {
    const step = definition.steps[stepIndex];
    const forEach = step.for_each_match === true;
    const selectedMatches = forEach ? filterMatches(handoffMatches, step.select) : [null];

    if (forEach && selectedMatches.length === 0) {
      if (definition.require_handoff_matches || step.require_match === true) {
        fail(`run_script step #${stepIndex + 1} requires handoff matches`);
      }
      continue;
    }

    for (let matchIndex = 0; matchIndex < selectedMatches.length; matchIndex += 1) {
      const match = selectedMatches[matchIndex];
      const context = {
        scope_dir: scopeDir,
        index: stepIndex,
        match_index: matchIndex,
        match
      };
      try {
        const result = executeRunScriptStep(scopeDir, step, context, dryRun);
        stepResults.push({
          step_index: stepIndex,
          match_index: match ? matchIndex : null,
          match_path: match ? match.path : null,
          ...result
        });
        if (typeof result.script === 'string' && result.script.trim()) {
          scriptLines.push(result.script);
        }
      } catch (error) {
        if (!definition.stop_on_error) {
          stepResults.push({
            step_index: stepIndex,
            match_index: match ? matchIndex : null,
            match_path: match ? match.path : null,
            operation: step.op,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
        throw error;
      }
    }
  }

  return {
    operation: 'run_script',
    step_count: definition.steps.length,
    executed_count: stepResults.length,
    require_handoff_matches: definition.require_handoff_matches,
    handoff_match_count: handoffMatches.length,
    stop_on_error: definition.stop_on_error,
    results: stepResults.slice(0, 500),
    script: scriptLines.join('\n'),
    applied: !dryRun
  };
}

function executeScriptedOperation(scopeDir, targetMeta, dryRun) {
  const operation = normalizeScriptOperation(targetMeta.operation || '');

  if (operation === 'delete_by_extension') {
    return executeDeleteByExtension(scopeDir, targetMeta, dryRun);
  }
  if (operation === 'cleanup') {
    return executeCleanup(scopeDir, targetMeta, dryRun);
  }
  if (operation === 'zip_files_over_size') {
    return executeZipFilesOverSize(scopeDir, targetMeta, dryRun);
  }
  if (operation === 'run_script') {
    return executeRunScript(scopeDir, targetMeta, dryRun);
  }

  fail(`unsupported scripted explorer operation '${operation}'`);
}

function executeUpdate(scopeDir, targetMeta, dryRun) {
  const operation = normalizeScriptOperation(chooseUpdateOperation(targetMeta));
  if (SCRIPTED_MUTATION_OPERATIONS.has(operation)) {
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

function executeDelete(scopeDir, targetMeta, dryRun) {
  const operation = normalizeScriptOperation(targetMeta.operation || '');
  if (SCRIPTED_MUTATION_OPERATIONS.has(operation)) {
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

function executeMutation(action, targetMeta) {
  const scopeDir = path.resolve(asOptionalString(targetMeta.scope_dir) || DEFAULT_SCOPE_DIR);
  ensureDirectory(scopeDir, 'scope_dir');

  const dryRun = targetMeta.dry_run === true;
  const scriptedOperation = normalizeScriptOperation(targetMeta.operation || '');

  let result;
  if (SCRIPTED_MUTATION_OPERATIONS.has(scriptedOperation)) {
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

  const stage = normalizeStage(targetMeta.stage);

  if (stage !== 'apply_socket') {
    const channel = asOptionalString(targetMeta.socket_channel);
    if (!channel) {
      fail('explorer_write_agent requires socket_channel handoff from explorer_read_agent');
    }

    const childTarget = {
      ...targetMeta,
      stage: 'apply_socket'
    };
    delete childTarget.__socket_result;
    delete childTarget.__socket_results;

    spawnChild(
      {
        summary: request.summary || `explorer write apply (${action})`,
        resource: 'plugin:explorer_write_agent',
        action: 'read',
        target: JSON.stringify(childTarget),
        container_image:
          typeof request.container_image === 'string' && request.container_image.trim()
            ? request.container_image.trim()
            : null,
        container_network:
          typeof request.container_network === 'string' && request.container_network.trim()
            ? request.container_network.trim()
            : null,
        llm_profile:
          typeof request.llm_profile === 'string' && request.llm_profile.trim()
            ? request.llm_profile.trim()
            : null
      },
      {
        ok: true,
        plugin: 'explorer_write_agent',
        mode: 'socket_consume_then_apply',
        socket_request: {
          op: 'consume',
          channel,
          max_messages: 1,
          sender_filter: asOptionalString(targetMeta.socket_sender_filter)
        }
      }
    );
    process.exit(0);
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
