import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface PlaywrightActionStep {
  type: string;
  selector?: string;
  label_key?: string;
  selector_key?: string;
  target_key?: string;
  role?: string;
  name?: string;
  aria_label?: string;
  placeholder?: string;
  test_id?: string;
  data_testid?: string;
  text_match?: string;
  value?: string;
  text?: string;
  url?: string;
  key?: string;
  timeout_ms?: number;
  wait_until?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  expression?: string;
  arg?: unknown;
  [key: string]: unknown;
}

export interface PlaywrightApiAttempt {
  url?: string;
  path_template?: string;
  path?: string;
  endpoint_key?: string;
  candidate_key?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PlaywrightServicePayload {
  action: 'read_title' | 'discover' | 'run_actions';
  url?: string;
  prompt?: string;
  timeout_ms?: number;
  headless?: boolean;
  use_stealth?: boolean;
  use_user_context?: boolean;
  user_data_dir?: string;
  storage_state_path?: string;
  capture_screenshot?: boolean;
  max_network_events?: number;
  actions?: PlaywrightActionStep[];
  api_attempts?: PlaywrightApiAttempt[];
  allow_unsafe?: boolean;
  auto_install_chromium?: boolean;
  auto_install_deps?: boolean;
  install_command?: string;
  install_deps_command?: string;
  probe_training_mode?: boolean;
  probe_walkthrough_plan?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatLlmResult {
  text: string;
  profile: string;
  provider: string;
  model: string;
}

export interface PlaywrightExecutionPolicy {
  useUserContext: boolean;
  headless: boolean;
  userDataDir: string | null;
  requestedUserContext: boolean;
  inferredAuthenticatedTask: boolean;
  containerFallbackNonAuth: boolean;
  permissionGranted: boolean;
  requirePermission: boolean;
  allowlistedDomain: boolean;
  allowAnyUserContextDomain: boolean;
  resolvedHost: string | null;
  reason: string | null;
}

const DEFAULT_AUTH_DOMAIN_HINTS: string[] = [
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
const DEFAULT_SERVICE_URL_MAP: Array<{ keyword: string; url: string }> = [
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

export function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toBool(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function toInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function firstJsonStart(text: string): number {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

export function parseJsonOutput(raw: unknown): unknown {
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

export function parseTargetMeta(target: unknown): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
}

export function resolveServiceCommand(): string {
  return (
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_PLUGIN_SERVICE_COMMAND) ||
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_SERVICE_COMMAND) ||
    'node workers/playwright-service.ts'
  );
}

export function runPlaywrightService(
  payload: PlaywrightServicePayload,
  timeoutMs: number = 120000
): Record<string, unknown> {
  const command = resolveServiceCommand();
  const out = spawnSync('sh', ['-lc', command], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 16
  });
  if (out.error) {
    if ((out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`playwright service timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run playwright service: ${out.error.message}`);
  }
  if (out.status !== 0) {
    const stderr = String(out.stderr || '').trim();
    const stdout = String(out.stdout || '').trim();
    throw new Error(
      `playwright service failed (${String(out.status)}): ${stderr || stdout || 'unknown error'}`
    );
  }
  const parsed = parseJsonOutput(out.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('playwright service returned non-JSON output');
  }
  return parsed as Record<string, unknown>;
}

export function normalizeActionStep(value: unknown): PlaywrightActionStep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const step = { ...(value as Record<string, unknown>) };
  const type = asOptionalString(step.type || step.op || step.action)?.toLowerCase();
  if (!type) {
    return null;
  }
  const normalized: PlaywrightActionStep = { type };
  const selector = asOptionalString(step.selector);
  const text = asOptionalString(step.text);
  const valueText = asOptionalString(step.value);
  const url = asOptionalString(step.url);
  const key = asOptionalString(step.key);
  const expression = asOptionalString(step.expression);
  const waitUntil = asOptionalString(step.wait_until);
  const method = asOptionalString(step.method);
  const labelKey = asOptionalString(step.label_key);
  const selectorKey = asOptionalString(step.selector_key);
  const targetKey = asOptionalString(step.target_key);
  const role = asOptionalString(step.role);
  const name = asOptionalString(step.name);
  const ariaLabel = asOptionalString(step.aria_label);
  const placeholder = asOptionalString(step.placeholder);
  const testId = asOptionalString(step.test_id);
  const dataTestid = asOptionalString(step.data_testid);
  const textMatch = asOptionalString(step.text_match);
  if (selector) normalized.selector = selector;
  if (labelKey) normalized.label_key = labelKey;
  if (selectorKey) normalized.selector_key = selectorKey;
  if (targetKey) normalized.target_key = targetKey;
  if (role) normalized.role = role;
  if (name) normalized.name = name;
  if (ariaLabel) normalized.aria_label = ariaLabel;
  if (placeholder) normalized.placeholder = placeholder;
  if (testId) normalized.test_id = testId;
  if (dataTestid) normalized.data_testid = dataTestid;
  if (textMatch) normalized.text_match = textMatch;
  if (text) normalized.text = text;
  if (valueText) normalized.value = valueText;
  if (url) normalized.url = url;
  if (key) normalized.key = key;
  if (expression) normalized.expression = expression;
  if (waitUntil) normalized.wait_until = waitUntil;
  if (method) normalized.method = method.toUpperCase();
  if (step.headers && typeof step.headers === 'object' && !Array.isArray(step.headers)) {
    normalized.headers = Object.fromEntries(
      Object.entries(step.headers as Record<string, unknown>)
        .map(([k, v]) => [String(k), String(v ?? '')])
        .filter(([k, v]) => k.trim().length > 0 && v.trim().length > 0)
    );
  }
  if (step.body !== undefined) {
    normalized.body = step.body;
  }
  const timeout = Number(step.timeout_ms);
  if (Number.isFinite(timeout) && timeout > 0) {
    normalized.timeout_ms = Math.min(Math.max(Math.trunc(timeout), 100), 300000);
  }
  if (step.arg !== undefined) {
    normalized.arg = step.arg;
  }
  return normalized;
}

export function parseActionSteps(value: unknown): PlaywrightActionStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeActionStep(item))
    .filter((item): item is PlaywrightActionStep => Boolean(item))
    .slice(0, 128);
}

export function parseApiAttempts(value: unknown): PlaywrightApiAttempt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: PlaywrightApiAttempt[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const url = asOptionalString(row.url);
    const pathTemplate = asOptionalString(row.path_template);
    const pathValue = asOptionalString(row.path);
    const endpointKey = asOptionalString(row.endpoint_key);
    const candidateKey = asOptionalString(row.candidate_key);
    if (!url && !pathTemplate && !pathValue && !endpointKey && !candidateKey) {
      continue;
    }
    const entry: PlaywrightApiAttempt = {};
    if (url) {
      entry.url = url;
    }
    if (pathTemplate) {
      entry.path_template = pathTemplate;
    }
    if (pathValue) {
      entry.path = pathValue;
    }
    if (endpointKey) {
      entry.endpoint_key = endpointKey;
    }
    if (candidateKey) {
      entry.candidate_key = candidateKey;
    }
    const method = asOptionalString(row.method);
    if (method) {
      entry.method = method.toUpperCase();
    }
    if (row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)) {
      entry.headers = Object.fromEntries(
        Object.entries(row.headers as Record<string, unknown>)
          .map(([k, v]) => [String(k), String(v ?? '')])
          .filter(([k, v]) => k.trim().length > 0 && v.trim().length > 0)
      );
    }
    if (row.body !== undefined) {
      entry.body = row.body;
    }
    out.push(entry);
    if (out.length >= 64) {
      break;
    }
  }
  return out;
}

export function inferUrlFromMessage(message: string): string | null {
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
  const serviceMap = [...parseServiceUrlMapFromEnv(), ...DEFAULT_SERVICE_URL_MAP];
  for (const entry of serviceMap) {
    if (!lower.includes(entry.keyword)) {
      continue;
    }
    const normalized = normalizeDetectedUrlCandidate(entry.url);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

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

export function resolveAgentBinary(): string {
  const candidates: string[] = [
    asOptionalString(process.env.PINOKIO_AGENT_BIN),
    'pinokio-agent',
    '/usr/local/bin/pinokio-agent',
    './target/debug/pinokio-agent',
    './target/release/pinokio-agent'
  ].filter((item): item is string => Boolean(item));

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

export function buildContainerLlmEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const childHome =
    asOptionalString(env.PINOKIO_CHILD_HOME) || '/var/lib/pinokio-oauth';
  const childBins = [`${childHome}/.npm-global/bin`, `${childHome}/.local/bin`];
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  env.PINOKIO_CHILD_MODE = '1';
  env.PINOKIO_CHILD_HOME = childHome;
  env.PATH = `${childBins.join(':')}${pathValue ? `:${pathValue}` : ''}`;
  return env;
}

export function runChatLlm(params: {
  profile: string;
  prompt: string;
  timeoutMs?: number;
}): ChatLlmResult {
  const timeoutMs = toInt(params.timeoutMs, 120000, 10000, 600000);
  const agentBin = resolveAgentBinary();
  const out = spawnSync(agentBin, ['llm', '--profile', params.profile, '--prompt', params.prompt], {
    encoding: 'utf8',
    env: buildContainerLlmEnv(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8
  });

  if (out.error) {
    if ((out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`chat llm timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run ${agentBin} llm: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `chat llm command failed (${out.status}): ${(out.stderr || out.stdout || '').trim()}`
    );
  }
  const parsed = parseJsonOutput(out.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('chat llm command returned non-JSON output');
  }
  const payload = parsed as Record<string, unknown>;
  const text = asOptionalString(payload.text);
  if (!text) {
    throw new Error('chat llm response was empty');
  }
  return {
    text,
    profile: params.profile,
    provider: asOptionalString(payload.provider) || 'unknown',
    model: asOptionalString(payload.model) || 'unknown'
  };
}

export function shouldUseUnsafeBrowser(targetMeta: Record<string, unknown>): boolean {
  return toBool(targetMeta.unsafe_browser, false) || toBool(targetMeta.unsafe_mode, false);
}

function parseDomainList(value: string | null, fallback: string[]): string[] {
  if (!value) {
    return [...fallback];
  }
  const parsed = value
    .split(/[,\n]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (parsed.length === 0) {
    return [...fallback];
  }
  return Array.from(new Set(parsed));
}

function normalizedDomainPattern(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '');
}

function expandHomePath(value: string): string {
  if (!value.startsWith('~')) {
    return value;
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function extractUrlHost(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function domainMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const normalizedHost = normalizedDomainPattern(host);
  for (const rawPattern of allowlist) {
    const pattern = normalizedDomainPattern(rawPattern);
    if (!pattern) {
      continue;
    }
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      if (
        normalizedHost === suffix ||
        normalizedHost.endsWith(`.${suffix}`)
      ) {
        return true;
      }
      continue;
    }
    if (pattern.includes('*')) {
      const escaped = pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const re = new RegExp(`^${escaped}$`, 'i');
      if (re.test(normalizedHost)) {
        return true;
      }
      continue;
    }
    if (
      normalizedHost === pattern ||
      normalizedHost.endsWith(`.${pattern}`)
    ) {
      return true;
    }
  }
  return false;
}

export function authDomainHintsFromEnv(): string[] {
  return parseDomainList(
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_AUTH_DOMAIN_HINTS),
    DEFAULT_AUTH_DOMAIN_HINTS
  );
}

export function userContextAllowlistFromEnv(): string[] {
  return parseDomainList(
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_USER_CONTEXT_DOMAIN_ALLOWLIST),
    authDomainHintsFromEnv()
  );
}

export function isLikelyAuthenticatedSite(
  url: string | null,
  message: string
): boolean {
  const host = extractUrlHost(url);
  const authHints = authDomainHintsFromEnv();
  if (host && domainMatchesAllowlist(host, authHints)) {
    return true;
  }
  const lower = String(message || '').toLowerCase();
  const authKeywords = [
    'gmail',
    'hotmail',
    'outlook',
    'inbox',
    'email',
    'account',
    'profile',
    'messages',
    'dm',
    'login',
    'sign in'
  ];
  return authKeywords.some((keyword) => lower.includes(keyword));
}

export function resolvePlaywrightExecutionPolicy(params: {
  targetMeta: Record<string, unknown>;
  url: string | null;
  message?: string | null;
}): PlaywrightExecutionPolicy {
  const { targetMeta, url } = params;
  const defaultUseUserContext = toBool(
    process.env.PINOKIO_PLAYWRIGHT_DEFAULT_USE_USER_CONTEXT,
    true
  );
  const hasExplicitUseUserContext = targetMeta.use_user_context !== undefined;
  const containerFallbackNonAuth = toBool(
    process.env.PINOKIO_PLAYWRIGHT_CONTAINER_FALLBACK_NON_AUTH,
    true
  );
  const inferredAuthenticatedTask = isLikelyAuthenticatedSite(
    url,
    asOptionalString(params.message) || ''
  );
  const defaultHeadless = toBool(
    process.env.PINOKIO_PLAYWRIGHT_DEFAULT_HEADLESS,
    false
  );
  let requestedUserContext = toBool(
    targetMeta.use_user_context,
    defaultUseUserContext
  );
  if (
    !hasExplicitUseUserContext &&
    containerFallbackNonAuth &&
    !inferredAuthenticatedTask
  ) {
    requestedUserContext = false;
  }
  const explicitHeadless =
    targetMeta.headless !== undefined
      ? targetMeta.headless
      : targetMeta.execution_headless;
  const headless = toBool(explicitHeadless, defaultHeadless);
  const requirePermission = toBool(
    process.env.PINOKIO_PLAYWRIGHT_REQUIRE_USER_CONTEXT_PERMISSION,
    true
  );
  const permissionGranted = toBool(targetMeta.allow_user_context, false);
  const resolvedHost = extractUrlHost(url);
  const allowlist = userContextAllowlistFromEnv();
  const allowlistedDomain =
    resolvedHost !== null && domainMatchesAllowlist(resolvedHost, allowlist);
  const allowAnyUserContextDomain = toBool(
    process.env.PINOKIO_PLAYWRIGHT_ALLOW_USER_CONTEXT_ANY_DOMAIN,
    true
  );

  let useUserContext = requestedUserContext;
  let reason: string | null = null;
  if (useUserContext && requirePermission && !permissionGranted) {
    useUserContext = false;
    reason = 'user_context_permission_required';
  }
  if (useUserContext && resolvedHost && !allowlistedDomain && !allowAnyUserContextDomain) {
    useUserContext = false;
    reason = resolvedHost
      ? `user_context_domain_not_allowlisted:${resolvedHost}`
      : 'user_context_missing_allowlisted_url';
  }
  if (useUserContext && !resolvedHost && !allowAnyUserContextDomain) {
    useUserContext = false;
    reason = 'user_context_missing_host';
  }
  const userDataDir = useUserContext ? defaultUserDataDirForUrl(url) : null;
  return {
    useUserContext,
    headless,
    userDataDir,
    requestedUserContext,
    inferredAuthenticatedTask,
    containerFallbackNonAuth,
    permissionGranted,
    requirePermission,
    allowlistedDomain,
    allowAnyUserContextDomain,
    resolvedHost,
    reason
  };
}

export function normalizeScopeLabel(url: string | null): string {
  if (!url) {
    return 'unknown-site';
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/[^a-z0-9.-]+/gi, '_').toLowerCase();
    return host || 'unknown-site';
  } catch {
    const slug = String(url)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return slug || 'unknown-site';
  }
}

export function defaultUserDataDirForUrl(url: string | null): string {
  const scope = normalizeScopeLabel(url);
  const base =
    expandHomePath(
      asOptionalString(process.env.PINOKIO_PLAYWRIGHT_USER_CONTEXT_DIR) ||
        (process.env.PINOKIO_CHILD_MODE === '1'
          ? '/app/.pinokio-agent/playwright-profile'
          : path.join(os.homedir(), '.pinokio-agent', 'playwright-profile'))
    );
  return path.join(base, scope);
}
