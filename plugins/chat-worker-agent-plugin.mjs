import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { pluginContext, respond, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_ACTIONS = new Set(['create', 'read', 'update', 'delete']);
const EXPLORER_RESOURCE = 'plugin:explorer_agent';

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

function normalizeRuntime(value) {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'unsafe_host' || runtime === 'host') {
    return 'unsafe_host';
  }
  return 'container';
}

function asOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveAgentBinary() {
  const candidates = [
    process.env.PINOKIO_AGENT_BIN,
    'pinokio-agent',
    '/usr/local/bin/pinokio-agent',
    './target/debug/pinokio-agent',
    './target/release/pinokio-agent'
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      env: process.env
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return 'pinokio-agent';
}

function buildContainerLlmEnv() {
  const env = { ...process.env };
  const childHome =
    typeof env.PINOKIO_CHILD_HOME === 'string' && env.PINOKIO_CHILD_HOME.trim()
      ? env.PINOKIO_CHILD_HOME.trim()
      : '/var/lib/pinokio-oauth';
  const childBins = [`${childHome}/.npm-global/bin`, `${childHome}/.local/bin`];
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';

  env.PINOKIO_CHILD_MODE = '1';
  env.PINOKIO_CHILD_HOME = childHome;
  env.PATH = `${childBins.join(':')}${pathValue ? `:${pathValue}` : ''}`;
  return env;
}

function runChatLlm({ profile, prompt, timeoutMs = 240000 }) {
  const agentBin = resolveAgentBinary();
  const out = spawnSync(agentBin, ['llm', '--profile', profile, '--prompt', prompt], {
    encoding: 'utf8',
    env: buildContainerLlmEnv(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 4
  });

  if (out.error) {
    if (out.error && out.error.code === 'ETIMEDOUT') {
      throw new Error(`chat llm timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run ${agentBin} llm: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `chat llm command failed (${out.status}): ${(out.stderr || out.stdout || '').trim()}`
    );
  }

  const payload = parseJsonOutput(out.stdout);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('chat llm command returned non-JSON output');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    throw new Error('chat llm response was empty');
  }

  return {
    text,
    profile,
    provider: typeof payload.provider === 'string' ? payload.provider : 'unknown',
    model: typeof payload.model === 'string' ? payload.model : 'unknown'
  };
}

function resolveProbeHosts(profile) {
  const normalized = String(profile || '').trim().toLowerCase();
  if (normalized.includes('claude')) {
    return ['api.anthropic.com', 'claude.ai'];
  }
  if (
    normalized.includes('codex') ||
    normalized.includes('openai') ||
    normalized.includes('chatgpt')
  ) {
    return ['api.openai.com', 'chatgpt.com', 'openai.com'];
  }
  return ['api.openai.com', 'api.anthropic.com', 'openai.com', 'claude.ai'];
}

function probeHttpsHost(host, timeoutMs = 5000) {
  const effectiveTimeout = Math.max(1000, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const failProbe = (detail) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${host} -> ${detail}`));
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const req = https.request(
      { host, method: 'HEAD', path: '/', servername: host },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 100) {
          succeed();
          return;
        }
        failProbe(`unexpected HTTPS status ${String(res.statusCode)}`);
      }
    );
    req.on('error', (error) => {
      const detail =
        error && typeof error === 'object'
          ? `${String(error.code || 'error')}: ${String(error.message || 'unknown error')}`
          : String(error || 'unknown error');
      failProbe(detail);
    });
    req.setTimeout(effectiveTimeout, () => {
      req.destroy();
      failProbe(`timeout after ${effectiveTimeout}ms`);
    });
    req.end();
  });
}

async function probeAnyHttpsHost(hosts, timeoutMs = 5000, rounds = 2) {
  const uniqueHosts = Array.from(new Set((hosts || []).filter(Boolean)));
  if (uniqueHosts.length === 0) {
    return { ok: false, host: null, errors: ['no probe hosts configured'] };
  }

  const failures = [];
  const totalRounds = Math.max(1, Number.parseInt(String(rounds), 10) || 1);
  for (let round = 1; round <= totalRounds; round += 1) {
    for (const host of uniqueHosts) {
      try {
        await probeHttpsHost(host, timeoutMs);
        return { ok: true, host, errors: failures };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`round ${round}: ${detail}`);
      }
    }
  }

  return { ok: false, host: null, errors: failures };
}

function parseJsonLinesReverse(raw, maxLines = 64) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
    const parsed = parseJsonOutput(lines[i]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.push(parsed);
    }
  }
  return out;
}

function resolveSocketBusPluginsIndexPath() {
  const busDir = asOptionalString(process.env.PINOKIO_SOCKET_BUS_DIR);
  if (!busDir) {
    return null;
  }
  return path.join(busDir, 'plugins_index.jsonl');
}

function loadPluginCatalogFromSocketBus() {
  const indexPath = resolveSocketBusPluginsIndexPath();
  if (!indexPath || !fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const candidates = parseJsonLinesReverse(raw, 80);
    for (const candidate of candidates) {
      const directPayload =
        candidate && typeof candidate === 'object' && candidate.schema === 'pinokio.plugins.index/v1'
          ? candidate
          : null;
      const envelopePayload =
        candidate &&
        typeof candidate === 'object' &&
        candidate.payload &&
        typeof candidate.payload === 'object' &&
        !Array.isArray(candidate.payload) &&
        candidate.payload.schema === 'pinokio.plugins.index/v1'
          ? candidate.payload
          : null;
      if (directPayload) {
        return directPayload;
      }
      if (envelopePayload) {
        return envelopePayload;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function summarizePluginCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return 'Plugin catalog unavailable in this turn.';
  }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  if (plugins.length === 0) {
    return 'Plugin catalog is available but currently empty.';
  }

  const lines = [];
  for (const plugin of plugins.slice(0, 20)) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      continue;
    }
    const manifestId = asOptionalString(plugin.manifest_id) || 'unknown';
    const name = asOptionalString(plugin.name) || manifestId;
    const description = asOptionalString(plugin.description) || 'no description';
    const resources = Array.isArray(plugin.resources)
      ? plugin.resources.filter((item) => typeof item === 'string').slice(0, 6).join(', ')
      : 'none';
    lines.push(`- ${name} (${manifestId}): ${description} [resources: ${resources}]`);
  }

  if (plugins.length > 20) {
    lines.push(`- ...and ${plugins.length - 20} more`);
  }

  return lines.length > 0 ? lines.join('\n') : 'Plugin catalog parsed but no readable entries.';
}

function hasResourceInCatalog(catalog, resource) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return false;
  }
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const normalizedResource = String(resource || '').trim().toLowerCase();
  if (!normalizedResource) {
    return false;
  }
  return plugins.some((plugin) => {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      return false;
    }
    const resources = Array.isArray(plugin.resources)
      ? plugin.resources.filter((item) => typeof item === 'string')
      : [];
    return resources.some((item) => item.trim().toLowerCase() === normalizedResource);
  });
}

function looksLikeFilesystemIntent(message) {
  const lower = String(message || '').toLowerCase();
  if (!lower) {
    return false;
  }
  if (/\b[\w .-]+\.[a-z0-9]{2,8}\b/.test(lower)) {
    return true;
  }
  const keywords = [
    'file',
    'files',
    'folder',
    'folders',
    'directory',
    'directories',
    'rename',
    'move',
    'delete',
    'remove',
    'create file',
    'create folder',
    'list files',
    'show files',
    'folder size',
    'directory size',
    'how big',
    'clean up',
    'cleanup',
    'zip',
    'archive',
    'compress',
    'rar',
    '.rar',
    'documents folder',
    'documents',
    'downloads',
    'desktop',
    'use explorer',
    'explorer'
  ];
  return keywords.some((keyword) => lower.includes(keyword));
}

function inferCrudActionFromMessage(message, fallback = 'read') {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('delete') || lower.includes('remove')) {
    return 'delete';
  }
  if (
    lower.includes('rename') ||
    lower.includes('move') ||
    lower.includes('edit') ||
    lower.includes('update') ||
    lower.includes('append') ||
    lower.includes('write to')
  ) {
    return 'update';
  }
  if (
    lower.includes('create') ||
    lower.includes('make ') ||
    lower.includes('new file') ||
    lower.includes('new folder') ||
    /\b(name|call)\s+it\s+[\w .-]+\.[a-z0-9]{2,8}\b/.test(lower) ||
    /\b(save|saved)\s+(it\s+)?as\s+[\w .-]+\.[a-z0-9]{2,8}\b/.test(lower)
  ) {
    return 'create';
  }
  return SUPPORTED_ACTIONS.has(fallback) ? fallback : 'read';
}

function sanitizeInferredPath(value) {
  if (typeof value !== 'string') {
    return null;
  }
  let trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  trimmed = trimmed.replace(/^["'`]+/, '').replace(/["'`]+$/, '');

  // Natural language often appends punctuation to paths (for example "/host/Desktop:").
  while (/[,:;.!?]+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  while (trimmed.endsWith(')') && !trimmed.includes('(')) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  while (trimmed.endsWith(']') && !trimmed.includes('[')) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }

  return trimmed || null;
}

function inferPathFromMessage(message) {
  const raw = String(message || '');
  const backtickMatch = raw.match(/`([^`]+)`/);
  if (backtickMatch && backtickMatch[1]) {
    return sanitizeInferredPath(backtickMatch[1]);
  }

  const namedFileMatch = raw.match(
    /\b(?:name|call)\s+it\s+([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8}))/i
  );
  if (namedFileMatch && namedFileMatch[1]) {
    return sanitizeInferredPath(namedFileMatch[1]);
  }

  const saveAsMatch = raw.match(
    /\b(?:save|saved)\s+(?:it\s+)?as\s+([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8}))/i
  );
  if (saveAsMatch && saveAsMatch[1]) {
    return sanitizeInferredPath(saveAsMatch[1]);
  }

  const unixPathMatch = raw.match(/(~\/[^\s,;]+|\/[^\s,;]+)/);
  if (unixPathMatch && unixPathMatch[1]) {
    return sanitizeInferredPath(unixPathMatch[1]);
  }

  const windowsPathMatch = raw.match(/[A-Za-z]:\\[^\s,;]+/);
  if (windowsPathMatch && windowsPathMatch[0]) {
    return sanitizeInferredPath(windowsPathMatch[0]);
  }

  const filenameMatch = raw.match(/\b([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8}))\b/);
  if (filenameMatch && filenameMatch[1]) {
    return sanitizeInferredPath(filenameMatch[1]);
  }

  return null;
}

function parseInlineCreateContent(message) {
  const raw = String(message || '');
  const contentMatch = raw.match(/(?:content|text)\s*[:=]\s*([\s\S]+)$/i);
  if (contentMatch && contentMatch[1]) {
    const value = contentMatch[1].trim();
    if (value) {
      return value;
    }
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length >= 2) {
    const trailing = lines.slice(1).join('\n').trim();
    if (trailing) {
      return trailing;
    }
  }
  return null;
}

function parseSizeToBytes(rawSize, rawUnit) {
  const n = Number.parseFloat(String(rawSize || '').trim());
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = String(rawUnit || 'b').trim().toLowerCase();
  const multipliers = {
    b: 1,
    byte: 1,
    bytes: 1,
    kb: 1024,
    k: 1024,
    mb: 1024 * 1024,
    m: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    g: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
    t: 1024 * 1024 * 1024 * 1024
  };
  const multiplier = multipliers[unit] || 1;
  return Math.max(1, Math.floor(n * multiplier));
}

function parseMinSizeBytesFromMessage(message) {
  const raw = String(message || '');
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(bytes?|kb|mb|gb|tb|[kmgt]b?|b)\b/i);
  if (!match) {
    return null;
  }
  return parseSizeToBytes(match[1], match[2]);
}

function parseExtensionListFromMessage(message) {
  const lower = String(message || '').toLowerCase();
  const extensionMatches = lower.match(/\.([a-z0-9]{1,10})/g) || [];
  const out = extensionMatches
    .map((token) => token.replace('.', '').trim())
    .filter(Boolean);
  if (/\brars?\b/.test(lower)) {
    out.push('rar');
  }
  if (/\bzips?\b/.test(lower)) {
    out.push('zip');
  }
  return Array.from(new Set(out));
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

function maybeReadableBytesReply(message) {
  const raw = String(message || '');
  const lower = raw.toLowerCase();
  if (!lower.includes('readable') && !lower.includes('human')) {
    return null;
  }
  const match = raw.match(/(\d{1,18})\s*bytes?\b/i);
  if (!match || !match[1]) {
    return null;
  }
  const bytes = Number.parseInt(match[1], 10);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  const human = formatHumanBytes(bytes);
  if (!human) {
    return null;
  }
  return `${bytes.toLocaleString()} bytes (${human})`;
}

function inferScopeFromMessage(lower, fallbackScope, hostDocumentsScope, hostDesktopScope) {
  if (lower.includes('desktop')) {
    return hostDesktopScope;
  }
  if (lower.includes('documents')) {
    return hostDocumentsScope;
  }
  return fallbackScope;
}

function buildExplorerTargetFromMessage(message, requestedAction, options = {}) {
  const lower = String(message || '').toLowerCase();
  const defaultScope = asOptionalString(process.env.PINOKIO_EXPLORER_SCOPE) || '/app';
  const hostDocumentsScope =
    asOptionalString(process.env.PINOKIO_HOST_DOCUMENTS_SCOPE) || defaultScope;
  const hostDesktopScope =
    asOptionalString(process.env.PINOKIO_HOST_DESKTOP_SCOPE) || '/host/Desktop';
  const channel = asOptionalString(options.channel) || 'default';
  const responseFormat = asOptionalString(options.response_format);
  const scopeDir = inferScopeFromMessage(
    lower,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope
  );
  const inferredAction = inferCrudActionFromMessage(message, requestedAction);
  const inferredPath = inferPathFromMessage(message);
  const inferredPathIsBareFilename =
    Boolean(inferredPath) &&
    !String(inferredPath).includes('/') &&
    !String(inferredPath).includes('\\') &&
    !String(inferredPath).startsWith('~');
  const listIntent =
    lower.includes('list') ||
    lower.includes('show') ||
    lower.includes('display') ||
    lower.includes('get a list');
  const infoIntent =
    lower.includes('size') ||
    lower.includes('folder size') ||
    lower.includes('directory size') ||
    lower.includes('how big') ||
    lower.includes('disk usage') ||
    lower.includes('details for') ||
    lower.includes('info about');
  const cleanupIntent =
    lower.includes('clean up') || lower.includes('cleanup') || lower.includes('organize');
  const zipIntent =
    lower.includes('zip') || lower.includes('archive') || lower.includes('compress');
  const deleteAllExtIntent =
    (lower.includes('delete') || lower.includes('remove')) &&
    (lower.includes('all') || lower.includes('every')) &&
    (lower.includes('.rar') || lower.includes('rars') || lower.includes('extensions'));
  const extensionsFromMessage = parseExtensionListFromMessage(message);
  const minSizeBytes = parseMinSizeBytesFromMessage(message);

  if (infoIntent && inferredAction === 'read') {
    const target = {
      scope_dir: scopeDir,
      desired_action: 'info',
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    if (inferredPath) {
      target.path = inferredPath;
    } else {
      target.path = scopeDir;
    }
    return {
      action: 'read',
      target
    };
  }

  if (cleanupIntent && lower.includes('desktop')) {
    const target = {
      scope_dir: hostDesktopScope,
      desired_action: 'update',
      operation: 'cleanup',
      cleanup_profile: 'desktop',
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'update',
      target
    };
  }

  if (deleteAllExtIntent || (extensionsFromMessage.length > 0 && lower.includes('delete'))) {
    const target = {
      scope_dir: scopeDir,
      desired_action: 'delete',
      operation: 'delete_by_extension',
      extensions: extensionsFromMessage.length > 0 ? extensionsFromMessage : ['rar'],
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'delete',
      target
    };
  }

  if (zipIntent && minSizeBytes) {
    const target = {
      scope_dir: scopeDir,
      desired_action: 'update',
      operation: 'zip_files_over_size',
      min_size_bytes: minSizeBytes,
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'update',
      target
    };
  }

  const target = {
    scope_dir: scopeDir,
    desired_action: inferredAction,
    channel,
    dry_run: false
  };
  if (responseFormat) {
    target.response_format = responseFormat;
  }

  if (inferredPath) {
    if (inferredPathIsBareFilename) {
      target.path = path.join(scopeDir, inferredPath);
    } else {
      target.path = inferredPath;
    }
  }

  if (!inferredPath && inferredAction === 'read') {
    const directFolderListing =
      listIntent &&
      (lower.includes('documents') || lower.includes('downloads') || lower.includes('desktop'));
    if (!directFolderListing) {
      target.query = message;
    }
  }

  if (inferredAction === 'create') {
    if (lower.includes('folder') || lower.includes('directory')) {
      target.kind = 'directory';
    } else {
      target.kind = 'file';
    }
    const targetPath = typeof target.path === 'string' ? target.path.toLowerCase() : '';
    if (targetPath.endsWith('.pdf') || lower.includes('pdf')) {
      target.operation = 'create_pdf';
      target.kind = 'file';
    }
    const inlineContent = parseInlineCreateContent(message);
    if (inlineContent) {
      target.content = inlineContent;
    }
  }

  if (inferredAction === 'delete' && lower.includes('recursive')) {
    target.recursive = true;
  }

  if ((inferredAction === 'create' || inferredAction === 'update' || inferredAction === 'delete') && !target.path) {
    return null;
  }

  return {
    action: inferredAction,
    target
  };
}

function buildChatPrompt(message, systemContext, pluginCatalogSummary) {
  const blocks = [
    'You are a dedicated plugin-first chat coordinator for Pinokio.',
    'Reply directly to the user in a concise, practical style.',
    'Always evaluate available plugins/systems before saying you cannot do something.',
    'If a request maps to an installed plugin, propose using that plugin path first.',
    'For filesystem requests, prefer Directory Plugin (plugin:explorer_agent) via manager flow.',
    'Never claim "no access" until you checked plugin context below.',
    'Do not mention MCP server requirements for built-in plugins in this system.',
    'Do not run shell commands yourself.',
    'Return only the chat reply text.',
    pluginCatalogSummary ? `Plugin catalog context:\n${pluginCatalogSummary}` : '',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ];
  return blocks.filter(Boolean).join('\n\n');
}

function resolveTimeoutMs() {
  const raw = Number.parseInt(String(process.env.PINOKIO_CHAT_LLM_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 10000) {
    return Math.min(raw, 600000);
  }
  return 240000;
}

function shouldFailOnProbe() {
  const raw = String(process.env.PINOKIO_STRICT_EGRESS_PROBE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

(async () => {
try {
  const { request } = pluginContext();
  const action = String(request.action || '').toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`chat_worker_agent plugin does not support action '${action}'`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const message = normalizeMessage(request.summary, targetMeta);
  const requestedProfile =
    (typeof targetMeta.profile === 'string' && targetMeta.profile.trim()) ||
    (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
    'codex';
  const systemContext =
    typeof targetMeta.system === 'string' ? targetMeta.system.trim() : '';
  const runtime = normalizeRuntime(targetMeta.runtime);
  const channel = asOptionalString(targetMeta.channel) || 'default';
  const responseFormat = asOptionalString(targetMeta.response_format);
  const pluginCatalog = loadPluginCatalogFromSocketBus();
  const pluginCatalogSummary = summarizePluginCatalog(pluginCatalog);
  const explorerAvailable = hasResourceInCatalog(pluginCatalog, EXPLORER_RESOURCE);
  const filesystemIntent = looksLikeFilesystemIntent(message);
  const readableBytesReply = maybeReadableBytesReply(message);

  if (readableBytesReply) {
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'local_readable_bytes',
      runtime: 'container',
      chat_response: readableBytesReply
    });
    return;
  }

  if (explorerAvailable && filesystemIntent) {
    const explorerCall = buildExplorerTargetFromMessage(message, action, {
      channel,
      response_format: responseFormat
    });
    if (explorerCall) {
      spawnChild(
        {
          summary: `directory request: ${message}`,
          resource: EXPLORER_RESOURCE,
          action: explorerCall.action,
          target: JSON.stringify(explorerCall.target),
          container_image: null,
          llm_profile: requestedProfile
        },
        {
          ok: true,
          plugin: 'chat_worker_agent',
          mode: 'plugin_first_directory',
          runtime: 'container',
          routed_resource: EXPLORER_RESOURCE,
          routed_action: explorerCall.action,
          routed_target: explorerCall.target
        }
      );
      return;
    }
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'plugin_filesystem_needs_details',
      runtime: 'container',
      chat_response:
        'I can run that through Directory Plugin, but I need a concrete target path or filename (and content for file creation when needed).'
    });
    return;
  }

  if (filesystemIntent && !explorerAvailable) {
    respond({
      ok: true,
      plugin: 'chat_worker_agent',
      mode: 'plugin_missing_directory',
      runtime: 'container',
      chat_response:
        "Directory Plugin isn't available right now. Install/enable `pinokio.explorer` in /ui/plugins, then retry."
    });
    return;
  }

  if (runtime === 'unsafe_host') {
    const mode =
      typeof targetMeta.mode === 'string' && targetMeta.mode.trim().toLowerCase() === 'command'
        ? 'command'
        : 'llm';
    const delegateTarget = {
      mode,
      message,
      profile: requestedProfile,
      system: systemContext
    };
    if (mode === 'command') {
      const command = typeof targetMeta.command === 'string' ? targetMeta.command.trim() : '';
      if (!command) {
        fail('unsafe host command mode requires target.command');
      }
      delegateTarget.command = command;
    }

    spawnChild(
      {
        summary: message,
        resource: 'plugin:unsafe_host_agent',
        action: 'read',
        target: JSON.stringify(delegateTarget),
        container_image: null,
        llm_profile: requestedProfile
      },
      {
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'spawn_child_unsafe_host',
        runtime: 'unsafe_host'
      }
    );
  } else {
    const prompt = buildChatPrompt(message, systemContext, pluginCatalogSummary);
    const probeHosts = resolveProbeHosts(requestedProfile);
    const probe = await probeAnyHttpsHost(probeHosts, 8000, 2);
    if (!probe.ok && shouldFailOnProbe()) {
      throw new Error(
        [
          `container outbound HTTPS probe failed for provider profile '${requestedProfile}'.`,
          `hosts checked: ${probeHosts.join(', ')}`,
          `probe detail: ${probe.errors[probe.errors.length - 1] || 'unknown'}.`,
          'This container runtime cannot reliably reach provider APIs from inside Docker.',
          `If you are using Colima, verify VM egress with: colima ssh -- curl -I -m 8 https://${probeHosts[0]}`
        ].join(' ')
      );
    }

    try {
      const timeoutMs = resolveTimeoutMs();
      const chat = runChatLlm({ profile: requestedProfile, prompt, timeoutMs });
      respond({
        ok: true,
        plugin: 'chat_worker_agent',
        mode: 'chat',
        runtime: 'container',
        profile: chat.profile,
        provider: chat.provider,
        model: chat.model,
        chat_prompt: message,
        chat_response: chat.text,
        network_probe: {
          ok: probe.ok,
          host: probe.host,
          checked_hosts: probeHosts
        }
      });
    } catch (error) {
      if (!probe.ok) {
        const llmError = error instanceof Error ? error.message : String(error);
        throw new Error(
          [
            llmError,
            `egress probe also failed across hosts: ${probeHosts.join(', ')}.`,
            `last probe error: ${probe.errors[probe.errors.length - 1] || 'unknown'}.`
          ].join(' ')
        );
      }
      throw error;
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
})();
