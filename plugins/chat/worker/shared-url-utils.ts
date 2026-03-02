import { asOptionalString, parseJsonOutput } from '../../plugin-utils.ts';

// ── Default URL/domain constants ────────────────────────────────────

export const DEFAULT_AUTH_DOMAIN_HINTS: string[] = [
  'mail.google.com',
  'accounts.google.com',
  'gmail.com',
  'outlook.live.com',
  'login.live.com',
  'live.com',
  'outlook.com',
  'hotmail.com',
  'outlook.office.com',
  'office.com',
  'account.microsoft.com',
  'twitch.tv',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'discord.com',
  'slack.com'
];

export const DEFAULT_PLAYWRIGHT_SERVICE_URL_MAP: Array<{ keyword: string; url: string }> = [
  { keyword: 'gmail', url: 'https://mail.google.com/' },
  { keyword: 'hotmail', url: 'https://outlook.live.com/mail/' },
  { keyword: 'outlook', url: 'https://outlook.live.com/mail/' },
  { keyword: 'twitch', url: 'https://www.twitch.tv/' },
  { keyword: 'twitter', url: 'https://x.com/' },
  { keyword: 'x.com', url: 'https://x.com/' },
  { keyword: 'linkedin', url: 'https://www.linkedin.com/' },
  { keyword: 'instagram', url: 'https://www.instagram.com/' },
  { keyword: 'facebook', url: 'https://www.facebook.com/' },
  { keyword: 'youtube', url: 'https://www.youtube.com/' },
  { keyword: 'discord', url: 'https://discord.com/' },
  { keyword: 'slack', url: 'https://app.slack.com/' },
  { keyword: 'notion', url: 'https://www.notion.so/' },
  { keyword: 'jira', url: 'https://www.atlassian.com/software/jira' },
  { keyword: 'asana', url: 'https://app.asana.com/' },
  { keyword: 'trello', url: 'https://trello.com/' },
  { keyword: 'shopify', url: 'https://admin.shopify.com/' }
];

// ── URL normalization & inference ───────────────────────────────────

export function normalizeDetectedUrlCandidate(value: string): string | null {
  let trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  trimmed = trimmed.replace(/^["'`(<\[]+/, '').replace(/[>"'`)\].,;!?]+$/, '');
  if (!trimmed) {
    return null;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

export function parseServiceUrlMapFromEnv(): Array<{ keyword: string; url: string }> {
  const raw = asOptionalString(process.env.PINOKIO_PLAYWRIGHT_SERVICE_URL_MAP);
  if (!raw) {
    return [];
  }
  const out: Array<{ keyword: string; url: string }> = [];
  const parsed = parseJsonOutput(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const keyword = String(key || '').trim().toLowerCase();
      const normalizedUrl = normalizeDetectedUrlCandidate(String(value || ''));
      if (!keyword || !normalizedUrl) {
        continue;
      }
      out.push({ keyword, url: normalizedUrl });
    }
    return out;
  }
  const rows = raw.split(/[,\n]+/g).map((item) => item.trim()).filter(Boolean);
  for (const row of rows) {
    const idx = row.indexOf('=');
    if (idx <= 0 || idx >= row.length - 1) {
      continue;
    }
    const keyword = row.slice(0, idx).trim().toLowerCase();
    const normalizedUrl = normalizeDetectedUrlCandidate(row.slice(idx + 1));
    if (!keyword || !normalizedUrl) {
      continue;
    }
    out.push({ keyword, url: normalizedUrl });
  }
  return out;
}

export function inferPlaywrightUrlFromMessage(message: string): string | null {
  const raw = String(message || '');
  const explicit = raw.match(/\bhttps?:\/\/[^\s"'`<>]+/i);
  if (explicit && explicit[0]) {
    return normalizeDetectedUrlCandidate(explicit[0]);
  }
  const bareDomain = raw.match(
    /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})(\/[^\s"'`<>]*)?/i
  );
  if (bareDomain && bareDomain[0] && !bareDomain[0].includes('@')) {
    const normalized = normalizeDetectedUrlCandidate(bareDomain[0]);
    if (normalized) {
      return normalized;
    }
  }
  const lower = raw.toLowerCase();
  const allMappings = [...parseServiceUrlMapFromEnv(), ...DEFAULT_PLAYWRIGHT_SERVICE_URL_MAP];
  for (const mapping of allMappings) {
    if (!lower.includes(mapping.keyword)) {
      continue;
    }
    const normalized = normalizeDetectedUrlCandidate(mapping.url);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}
