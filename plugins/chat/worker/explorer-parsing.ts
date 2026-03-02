/**
 * Path parsing, content parsing, and file metadata inference helpers
 * extracted from explorer-routing.ts.
 */

import { SUPPORTED_ACTIONS } from './shared-actions.ts';

/* ------------------------------------------------------------------ */
/*  Inference helpers                                                   */
/* ------------------------------------------------------------------ */

export function inferCrudActionFromMessage(message: string, fallback: string = 'read'): string {
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
    lower.includes('write to') ||
    lower.includes('write into') ||
    lower.includes('put into') ||
    lower.includes('insert into')
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

export function sanitizeInferredPath(value: unknown): string | null {
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
  // Users often wrap filenames in parentheses in natural language.
  if (trimmed.startsWith('(') && trimmed.endsWith(')') && trimmed.length > 2) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed || null;
}

export function inferPathFromMessage(message: string): string | null {
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

export function parseInlineCreateContent(message: string): string | null {
  const raw = String(message || '');
  const contentMatch = raw.match(/(?:content|text)\s*[:=]\s*([\s\S]+)$/i);
  if (contentMatch && contentMatch[1]) {
    const value = contentMatch[1].trim();
    if (value) {
      return value;
    }
  }
  const putInsideMatch = raw.match(
    /\b(?:put|write|insert)\s+(?:(?:inside|into)(?:\s+of)?\s+)?(?:(?:the|that|this)\s+)?(?:text\s+file|file|document)\s*[>:. -]?\s*([\s\S]+)$/i
  );
  if (putInsideMatch && putInsideMatch[1]) {
    let value = putInsideMatch[1].trim().replace(/^[>.:;\-\s]+/, '').trim();
    value = value
      .replace(/\s+and\s+save\s+(?:it\s+)?as\s+[^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8})?.*$/i, '')
      .trim();
    if (value) {
      return value;
    }
  }
  const putTextInsideItMatch = raw.match(
    /\b(?:put|write|insert)\s+(?:this|the)?\s*text\s+(?:inside|into)\s+(?:of\s+)?(?:it|that|this)\s*[>:. -]?\s*([\s\S]+)$/i
  );
  if (putTextInsideItMatch && putTextInsideItMatch[1]) {
    const value = putTextInsideItMatch[1].trim().replace(/^[>.:;\-\s]+/, '').trim();
    if (value) {
      return value;
    }
  }
  const saysMatch = raw.match(
    /\bsay(?:s|ing)?\s+(.+?)(?:\s+(?:on|in|at)\s+(?:my\s+)?(?:desktop|documents|downloads)\b[\s\S]*)?$/i
  );
  if (saysMatch && saysMatch[1]) {
    let value = saysMatch[1].trim();
    value = value
      .replace(/\s+and\s+save\s+(?:it\s+)?as\s+[^\s"'`\\/]+(?:\.[a-zA-Z0-9]{2,8})?.*$/i, '')
      .trim();
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

export function parseRenameNewNameFromMessage(message: string): string | null {
  const raw = String(message || '');
  const quoted = raw.match(
    /\brename\b[\s\S]*?\bto\s+["'`]\s*([^"'`\\/]+(?:\.[a-zA-Z0-9]{1,10})?)\s*["'`]/i
  );
  if (quoted && quoted[1]) {
    return sanitizeInferredPath(quoted[1]);
  }
  const plain = raw.match(/\brename\b[\s\S]*?\bto\s+([^\s"'`\\/]+(?:\.[a-zA-Z0-9]{1,10})?)/i);
  if (plain && plain[1]) {
    return sanitizeInferredPath(plain[1]);
  }
  return null;
}

export function formatTimestampForFileName(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}

export function inferDefaultCreateFileName(message: string): string {
  const lower = String(message || '').toLowerCase();
  const extension =
    lower.includes('pdf') ? '.pdf'
      : lower.includes('json') ? '.json'
      : lower.includes('markdown') || lower.includes('.md') ? '.md'
      : '.txt';
  return `document-${formatTimestampForFileName(new Date())}${extension}`;
}

export function parseSizeToBytes(rawSize: string, rawUnit: string): number | null {
  const n = Number.parseFloat(String(rawSize || '').trim());
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = String(rawUnit || 'b').trim().toLowerCase();
  const multipliers: Record<string, number> = {
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

export function parseMinSizeBytesFromMessage(message: string): number | null {
  const raw = String(message || '');
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(bytes?|kb|mb|gb|tb|[kmgt]b?|b)\b/i);
  if (!match) {
    return null;
  }
  return parseSizeToBytes(match[1], match[2]);
}

export function parseExtensionListFromMessage(message: string): string[] {
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

export function formatHumanBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units: string[] = ['KB', 'MB', 'GB', 'TB', 'PB'];
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

export function maybeReadableBytesReply(message: string): string | null {
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

export function inferScopeFromMessage(lower: string, fallbackScope: string, hostDocumentsScope: string, hostDesktopScope: string): string {
  if (lower.includes('desktop')) {
    return hostDesktopScope;
  }
  if (lower.includes('documents')) {
    return hostDocumentsScope;
  }
  return fallbackScope;
}
