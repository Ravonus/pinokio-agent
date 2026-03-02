import type {
  ConversationTurn,
  CleanupPolicyPreset,
  PendingFilesystemState,
  BrowserWorkflowState,
  BrowserWorkflowEventType,
  TargetMeta
} from './types.ts';
import { asOptionalString, parseJsonOutput } from '../plugin-utils.ts';

export const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

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

export const COMMON_FILE_EXTENSIONS: Set<string> = new Set([
  'txt', 'md', 'pdf', 'csv', 'json', 'yaml', 'yml', 'xml', 'toml', 'ini',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'css', 'scss', 'sass', 'less',
  'rs', 'py', 'java', 'kt', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'php',
  'rb', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'db', 'sqlite',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'avi', 'mkv',
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
]);

export function normalizeMessage(summary: unknown, targetMeta: TargetMeta): string {
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

export function conversationSummaryForPrompt(turns: ConversationTurn[], maxTurns: number = 8): string {
  if (!Array.isArray(turns) || turns.length === 0) {
    return '';
  }
  return turns
    .slice(-Math.max(1, maxTurns))
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    .join('\n');
}

export function inferAssistantFollowUpQuestion(text: string): string | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const last = lines[lines.length - 1];
  if (!last.endsWith('?')) {
    return null;
  }
  return last.slice(0, 400);
}

export function looksLikeExplicitNewConversation(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\bnew\s+(conversation|task|request|topic|question)\b/.test(lower) ||
    /\bdifferent\s+(task|request|topic|question)\b/.test(lower) ||
    /\bstart\s+over\b/.test(lower) ||
    /\breset\b/.test(lower) ||
    /\bnever\s+mind\b/.test(lower) ||
    /\bnvm\b/.test(lower) ||
    /\bignore\s+(that|previous|last)\b/.test(lower)
  );
}

export function looksLikeBrowserWorkflowCancelMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(cancel|stop|abort|end|exit|reset|clear)\b/.test(lower) &&
    /\b(playwright|browser|automation|probe|workflow|cleanup)\b/.test(lower)
  );
}

export function looksLikeBrowserWorkflowStatusMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(browser|playwright|automation|probe|workflow)\b/.test(lower) &&
    /\b(status|state|progress|where are we|what step)\b/.test(lower)
  );
}

export function looksLikeBrowserWorkflowResumeMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(resume|continue|proceed|carry on|keep going|pick up)\b/.test(lower) &&
    /\b(browser|playwright|automation|probe|workflow)\b/.test(lower)
  );
}

export function shouldBiasToConversationFollowUp(params: {
  message: string;
  pendingFilesystem: PendingFilesystemState | null;
  lastAssistantQuestion: string | null;
  browserPolicyPending: boolean;
  browserWorkflowEvent?: BrowserWorkflowEventType | null;
}): boolean {
  if (looksLikeExplicitNewConversation(params.message)) {
    return false;
  }
  const browserWorkflowActive =
    Boolean(params.browserWorkflowEvent) && params.browserWorkflowEvent !== 'RESET';
  return Boolean(
    params.pendingFilesystem ||
    params.lastAssistantQuestion ||
    params.browserPolicyPending ||
    browserWorkflowActive
  );
}

export function messageReferencesPriorFile(message: string): boolean {
  const raw = String(message || '');
  if (/\b(?:that|this|the|last|previous)\s+(?:text\s+)?(?:file|document)\b/i.test(raw)) {
    return true;
  }
  if (/\blast\s+file\s+(?:created|made|generated)\b/i.test(raw)) {
    return true;
  }
  return /\b(?:write|put|insert|append|update|edit|replace)\b[\s\S]{0,120}\bit\b/i.test(raw);
}

// ---------------------------------------------------------------------------
// Internal helpers used by looksLikeBrowserAutomationIntent
// ---------------------------------------------------------------------------

function normalizeDetectedUrlCandidate(value: string): string | null {
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

function parseServiceUrlMapFromEnv(): Array<{ keyword: string; url: string }> {
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

function inferPlaywrightUrlFromMessage(message: string): string | null {
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

// ---------------------------------------------------------------------------
// Browser automation intent
// ---------------------------------------------------------------------------

export function looksLikeBrowserAutomationIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }

  if (/\bwhat\s+is\s+playwright\b/.test(lower)) {
    return false;
  }
  if (/\b(?:use|via|through)\s+playwright\b/.test(lower)) {
    return true;
  }
  if (lower.includes('plugin:playwright_agent') || lower.includes('playwright')) {
    return true;
  }
  if (inferPlaywrightUrlFromMessage(message)) {
    return true;
  }

  const serviceKeywords: string[] = [
    'gmail',
    'hotmail',
    'outlook',
    'outlook.com',
    'outlook.live.com',
    'mail.google.com',
    'inbox',
    'mailbox',
    'twitch',
    'twitter',
    'x.com',
    'linkedin',
    'instagram',
    'facebook',
    'youtube',
    'discord',
    'slack',
    'website',
    'web app',
    'webapp',
    'site',
    'service',
    'platform',
    'portal',
    'dashboard',
    'console',
    'admin',
    'settings',
    'account',
    'workspace',
    'tenant',
    'website',
    'browser',
    'cloudflare',
    'captcha'
  ];
  const automationKeywords: string[] = [
    'organize',
    'automation',
    'automate',
    'triage',
    'reply',
    'respond',
    'post',
    'send',
    'check',
    'go through',
    'scrape',
    'discover',
    'non-headless',
    'headless',
    'login',
    'sign in',
    'mfa',
    '2fa',
    'monitor',
    'classify',
    'tag',
    'label',
    'workflow',
    'rules',
    'filter'
  ];
  const hasServiceKeyword = serviceKeywords.some((keyword) => lower.includes(keyword));
  const hasAutomationKeyword = automationKeywords.some((keyword) => lower.includes(keyword));
  if (hasServiceKeyword && hasAutomationKeyword) {
    return true;
  }
  if (hasServiceKeyword && /\b(?:email|emails|messages|message)\b/.test(lower)) {
    return true;
  }
  if (/\b(?:email|emails)\b/.test(lower) && hasAutomationKeyword) {
    return true;
  }
  if (hasServiceKeyword && /\b(?:login|log in|sign in|mfa|2fa|captcha|cloudflare)\b/.test(lower)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cleanup & browser workflow intent helpers
// ---------------------------------------------------------------------------

export function inferCleanupIntentFromMessage(message: string, desiredAction: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (
    lower.includes('cleanup') ||
    lower.includes('clean up') ||
    lower.includes('organize') ||
    lower.includes('triage') ||
    lower.includes('junk') ||
    lower.includes('spam') ||
    lower.includes('inbox zero')
  ) {
    return true;
  }
  const messagingContext =
    lower.includes('email') ||
    lower.includes('emails') ||
    lower.includes('inbox') ||
    lower.includes('mailbox') ||
    lower.includes('messages') ||
    lower.includes('dm');
  const workflowVerb =
    lower.includes('go through') ||
    lower.includes('sort') ||
    lower.includes('filter') ||
    lower.includes('classify') ||
    lower.includes('archive') ||
    lower.includes('delete');
  if (messagingContext && workflowVerb) {
    return true;
  }
  return desiredAction === 'delete' && messagingContext;
}

export function messageHasCleanupPolicyDetails(message: string): boolean {
  const raw = String(message || '');
  const lower = raw.toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (parseCleanupPolicyPreset(message)) {
    return true;
  }
  const policySignals: RegExp[] = [
    /\bolder than\b/,
    /\bnewer than\b/,
    /\blast \d+\s*(?:day|days|week|weeks|month|months|year|years)\b/,
    /\bfrom\s+[@\w.-]+\b/,
    /\bsender\b/,
    /\bsubject\b/,
    /\bcontains\b/,
    /\bkeyword\b/,
    /\barchive\b/,
    /\bdelete\b/,
    /\bkeep\b/,
    /\bnever delete\b/,
    /\bprotect\b/,
    /\ballowlist\b/,
    /\bwhitelist\b/,
    /\blabel\b/,
    /\bcategory\b/,
    /\bfolder\b/,
    /\bunread\b/,
    /\bread\b/
  ];
  if (policySignals.some((re) => re.test(lower))) {
    return true;
  }
  return /[:\n].{10,}/.test(raw) && (lower.includes('junk') || lower.includes('rule'));
}

export function isBrowserFollowupAckMessage(message: string): boolean {
  const normalized = String(message || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\bnot\s+ready\b/.test(normalized)) {
    return false;
  }
  if (/^(ready|done|ok|okay|continue|go ahead|next|proceed|yes)\b/.test(normalized)) {
    return true;
  }
  if (/\b(i am|i'm|im|we are|we're)\s+ready\b/.test(normalized)) {
    return true;
  }
  return /\bready\b/.test(normalized);
}

export function looksLikeBrowserSkillExportIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim() || !lower.includes('skill')) {
    return false;
  }
  if (
    /\b(convert|save|turn|make|export|create|generate|publish)\b/.test(lower) &&
    /\b(skill|workflow)\b/.test(lower)
  ) {
    return true;
  }
  return /\buse this as a skill\b/.test(lower) || /\bskill from this\b/.test(lower);
}

export function parseSkillNameFromMessage(message: string): string | null {
  const raw = String(message || '');
  const quoted =
    raw.match(/\b(?:skill\s+name|named|called)\s*[:=]?\s*["'`]([^"'`]{2,80})["'`]/i) ||
    raw.match(/\bas\s+skill\s+["'`]([^"'`]{2,80})["'`]/i);
  const direct =
    raw.match(/\b(?:skill\s+name|named|called)\s*[:=]?\s*([a-z0-9][a-z0-9_.-]{2,80})/i) ||
    raw.match(/\bas\s+([a-z0-9][a-z0-9_.-]{2,80})\s+skill\b/i);
  const candidate = quoted?.[1] || direct?.[1] || '';
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return normalized.length >= 3 ? normalized.slice(0, 80) : null;
}

export function messageRequestsProbeLabelMode(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (/\b(enable|start|turn on|open|use)\s+(?:label mode|labels?|annotation mode)\b/.test(lower)) {
    return true;
  }
  if (/\b(label|annotate|mark|tag)\b/.test(lower) && /\b(field|input|button|element|selector|login)\b/.test(lower)) {
    return true;
  }
  return /\bclick-to-label\b/.test(lower);
}

export function messageRequestsUseSavedLabels(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\buse\s+(?:my|the)\s+saved\s+labels?\b/.test(lower) ||
    /\bapply\s+(?:my|the)\s+saved\s+labels?\b/.test(lower) ||
    /\bcontinue\b[\s\S]{0,40}\bsaved\s+labels?\b/.test(lower)
  );
}

export function messageRequestsProbeLabelReset(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\b(clear|reset|remove|wipe)\s+(?:saved\s+)?labels?\b/.test(lower) ||
    /\bforget\b[\s\S]{0,40}\blabels?\b/.test(lower)
  );
}

export function messageRequestsNetworkCandidatePreview(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\bshow\s+(?:api|network)\s+candidates\b/.test(lower) ||
    /\bshow\s+candidates\b/.test(lower) ||
    /\bnetwork\s+(?:requests?|calls?|analysis|summary)\b/.test(lower) ||
    /\bapi\s+(?:calls?|requests?|candidates?)\b/.test(lower) ||
    /\b(?:show|build|gather|get)\s+(?:a\s+)?(?:site|automation|network|request)?\s*map\b/.test(lower) ||
    /\bmap\s+(?:the|this)\s+(?:site|workflow|flow|requests?|network)\b/.test(lower)
  );
}

export function looksLikeBrowserWorkflowControlMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (messageRequestsNetworkCandidatePreview(message)) {
    return true;
  }
  if (messageRequestsProbeLabelMode(message) || messageRequestsProbeLabelReset(message)) {
    return true;
  }
  if (messageRequestsUseSavedLabels(message)) {
    return true;
  }
  if (/\bcontinue\s+with\s+(?:the\s+)?plan\b/.test(lower)) {
    return true;
  }
  if (/\bresume\s+workflow\b/.test(lower) || /\bcancel\s+workflow\b/.test(lower)) {
    return true;
  }
  if (/\bsave\s+probe\s+as\s+skill\b/.test(lower)) {
    return true;
  }
  return false;
}

export function messageHasCleanupExecutionApproval(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (/\bpilot\s+(delete|archive)\b/.test(lower)) {
    return true;
  }
  if (
    /\b(approve|approved|go ahead|proceed|run it|execute|do it)\b/.test(lower) &&
    /\b(cleanup|clean up|delete|archive|junk|spam|message|messages|email|emails|inbox)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

export function inferCleanupExecutionMode(message: string): string | null {
  const lower = String(message || '').toLowerCase();
  if (/\bpilot\s+delete\b/.test(lower)) {
    return 'pilot_delete';
  }
  if (/\bpilot\s+archive\b/.test(lower)) {
    return 'pilot_archive';
  }
  if (/\bpilot\b/.test(lower)) {
    return 'pilot';
  }
  if (/\barchive\b/.test(lower)) {
    return 'archive';
  }
  if (/\bdelete\b/.test(lower)) {
    return 'delete';
  }
  return null;
}

export function parseCleanupPolicyPreset(message: string): CleanupPolicyPreset | null {
  const raw = String(message || '').trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  const compact = lower
    .replace(/^[\s"'`([{]+/, '')
    .replace(/[\s"'`)\]}.,:;!?-]+$/, '')
    .trim();

  const isSimpleChoice = compact.length <= 24;
  const isChoice1 =
    (isSimpleChoice && /^(?:option|policy)?\s*1$/.test(compact)) ||
    (isSimpleChoice && /^one$/.test(compact)) ||
    /\bconservative\b/.test(lower);
  const isChoice2 =
    (isSimpleChoice && /^(?:option|policy)?\s*2$/.test(compact)) ||
    (isSimpleChoice && /^two$/.test(compact)) ||
    /\bbalanced\b/.test(lower);
  const isChoice3 =
    (isSimpleChoice && /^(?:option|policy)?\s*3$/.test(compact)) ||
    (isSimpleChoice && /^three$/.test(compact)) ||
    /\baggressive\b/.test(lower);

  if (isChoice1) {
    return {
      choice: '1',
      label: 'conservative',
      policyText:
        'Conservative cleanup policy: archive-only (no permanent delete). Preview candidates first. Treat promotional/newsletter/social/no-reply mail as junk candidates older than 30 days. Keep flagged mail, protected senders/folders, and recent important threads.'
    };
  }
  if (isChoice2) {
    return {
      choice: '2',
      label: 'balanced',
      policyText:
        'Balanced cleanup policy: archive promotional/newsletter/social/no-reply candidates older than 30 days. Delete Junk Email older than 7 days and Deleted Items older than 14 days. Keep flagged mail and protected senders/folders. Run candidate preview and pilot before broader actions.'
    };
  }
  if (isChoice3) {
    return {
      choice: '3',
      label: 'aggressive',
      policyText:
        'Aggressive cleanup policy: after preview, bulk-delete junk candidates by age (promotional/newsletter/social/no-reply older than 30 days, Junk Email older than 7 days, Deleted Items older than 14 days). Preserve protected senders/folders and flagged important mail.'
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filesystem intent helpers
// ---------------------------------------------------------------------------

export function hasLikelyFilenameToken(message: string): boolean {
  const tokens = String(message || '')
    .split(/\s+/g)
    .map((token) =>
      token
        .trim()
        .replace(/^["'`(<\[]+/, '')
        .replace(/[>"'`)\].,;!?]+$/, '')
    )
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^https?:\/\//i.test(token) || token.startsWith('www.')) {
      continue;
    }
    if (token.includes('@')) {
      continue;
    }
    const basename = token.split(/[\\/]/g).pop() || token;
    const match = basename.match(/^[\w .-]+\.(\w{1,10})$/i);
    if (!match) {
      continue;
    }
    const ext = String(match[1] || '').toLowerCase();
    if (COMMON_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}

// Internal helper used by looksLikeFilesystemIntent
function looksLikeExplicitPathSyntax(message: string): boolean {
  const raw = String(message || '');
  if (!raw.trim()) {
    return false;
  }
  if (/(^|\s)(~\/|\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(raw)) {
    return true;
  }
  return /`[^`]*[\/\\][^`]*`/.test(raw);
}

export function looksLikeFilesystemIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower) {
    return false;
  }
  const explicitPathSyntax = looksLikeExplicitPathSyntax(message);
  const messagingContext =
    /\b(?:email|emails|inbox|mailbox|message|messages|gmail|outlook|hotmail|dm)\b/.test(lower);
  if (messagingContext && !explicitPathSyntax) {
    return false;
  }
  if (
    (lower.includes('playwright') || lower.includes('browser') || lower.includes('gmail') || lower.includes('hotmail') || lower.includes('outlook')) &&
    /\b(?:not|dont|don't)\s+(?:folder|folders|explorer)\b/.test(lower)
  ) {
    return false;
  }
  if (hasLikelyFilenameToken(message)) {
    return true;
  }
  const keywords: string[] = [
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

// ---------------------------------------------------------------------------
// Mutation / prior-file intent helpers
// ---------------------------------------------------------------------------

export function isMutationAction(action: string): boolean {
  return action === 'create' || action === 'update' || action === 'delete';
}

export function isExplicitPriorFileWriteIntent(message: string, lastFilePath: string | null): boolean {
  if (!lastFilePath) {
    return false;
  }
  const lower = String(message || '').toLowerCase();
  if (
    lower.includes('create') ||
    lower.includes('make ') ||
    lower.includes('new file') ||
    lower.includes('new document') ||
    lower.includes('text document')
  ) {
    return false;
  }
  if (!messageReferencesPriorFile(message)) {
    return false;
  }
  return /\b(?:write|put|insert|append|update|edit|replace)\b/.test(lower);
}
