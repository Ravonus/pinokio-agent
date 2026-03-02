import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page
} from 'playwright';
import {
  buildSelectorFallbackStack,
  resolveApiAttemptFromCandidates,
  type SiteProfile
} from '../plugins/playwright/runtime-utils.ts';

type PlaywrightAction = 'read_title' | 'discover' | 'run_actions';

interface ServicePayload {
  action: PlaywrightAction;
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
  actions?: BrowserActionStep[];
  api_attempts?: ApiAttempt[];
  allow_unsafe?: boolean;
  auto_install_chromium?: boolean;
  auto_install_deps?: boolean;
  install_command?: string;
  install_deps_command?: string;
  probe_overlay_enabled?: boolean;
  probe_overlay_auto_activate?: boolean;
  probe_overlay_reset?: boolean;
  probe_training_mode?: boolean;
  probe_walkthrough_plan?: Record<string, unknown>;
  site_profile?: SiteProfile;
  label_map?: Record<string, string>;
  selector_retry_limit?: number;
  keep_open_after_discovery_ms?: number;
  non_blocking_keep_open?: boolean;
  background_result_path?: string;
  _background_worker?: boolean;
  [key: string]: unknown;
}

interface BrowserActionStep {
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
  continue_on_error?: boolean;
  [key: string]: unknown;
}

interface ApiAttempt {
  url?: string;
  path_template?: string;
  path?: string;
  endpoint_key?: string;
  candidate_key?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  [key: string]: unknown;
}

interface NetworkEvent {
  url: string;
  method: string;
  status: number | null;
  resource_type: string;
  timestamp: string;
}

interface Session {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
  usedStealthPlugin: boolean;
  usedStealthHardening: boolean;
  headless: boolean;
  userContext: boolean;
}

interface UserCheckpointResult {
  awaited: boolean;
  satisfied: boolean;
  expected_host: string | null;
  final_url: string | null;
  waited_ms: number;
  reason: string | null;
}

function toBool(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
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

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePayload(raw: unknown): ServicePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid payload object');
  }
  const payload = raw as ServicePayload;
  if (!payload.action || !['read_title', 'discover', 'run_actions'].includes(String(payload.action))) {
    throw new Error(`unsupported action: ${String(payload.action || 'unknown')}`);
  }
  return payload;
}

function payloadFromBase64(value: string): ServicePayload {
  let decoded = '';
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch (error) {
    throw new Error(
      `invalid base64 payload: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(
      `invalid JSON payload from base64 env: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parsePayload(parsed);
}

function shouldAutoInstallChromium(payload: ServicePayload): boolean {
  const envDefault = toBool(process.env.PINOKIO_PLAYWRIGHT_AUTO_INSTALL_CHROMIUM, true);
  return toBool(payload.auto_install_chromium, envDefault);
}

function resolveChromiumInstallCommand(payload: ServicePayload): string {
  return (
    asOptionalString(payload.install_command) ||
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_INSTALL_COMMAND) ||
    'if command -v npx >/dev/null 2>&1; then npx playwright install chromium; else npm exec playwright install chromium; fi'
  );
}

function shouldAutoInstallDeps(payload: ServicePayload): boolean {
  const envDefault = toBool(process.env.PINOKIO_PLAYWRIGHT_AUTO_INSTALL_DEPS, true);
  return toBool(payload.auto_install_deps, envDefault);
}

function resolveDepsInstallCommand(payload: ServicePayload): string {
  return (
    asOptionalString(payload.install_deps_command) ||
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_DEPS_INSTALL_COMMAND) ||
    [
      'if command -v apt-get >/dev/null 2>&1; then',
      '  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends',
      '    libglib2.0-0 libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libexpat1 libatspi2.0-0',
      '    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1',
      '    libxcb1 libxkbcommon0 libasound2 libgtk-3-0 ca-certificates &&',
      '  rm -rf /var/lib/apt/lists/*;',
      'elif command -v apk >/dev/null 2>&1; then',
      '  apk add --no-cache',
      '    glib nss nspr dbus-libs atk expat at-spi2-core libx11 libxcomposite',
      '    libxdamage libxext libxfixes libxrandr mesa-gbm libxcb libxkbcommon',
      '    alsa-lib gtk+3.0 ca-certificates;',
      'fi;',
      'if command -v npx >/dev/null 2>&1; then',
      '  npx playwright install chromium;',
      'else',
      '  npm exec playwright install chromium;',
      'fi'
    ].join(' ')
  );
}

function missingChromiumBinary(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message}\n${error.stack || ''}`
      : String(error || '');
  const lower = message.toLowerCase();
  if (!lower.includes('playwright')) {
    return false;
  }
  return (
    lower.includes("executable doesn't exist at") ||
    lower.includes('executable doesnt exist at') ||
    lower.includes('please run the following command to download new browsers') ||
    lower.includes('npx playwright install')
  );
}

function missingBrowserDependencies(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message}\n${error.stack || ''}`
      : String(error || '');
  const lower = message.toLowerCase();
  return (
    lower.includes('host system is missing dependencies to run browsers') ||
    lower.includes('missing libraries:')
  );
}

function installChromium(payload: ServicePayload): void {
  const command = resolveChromiumInstallCommand(payload);
  const timeoutMs = toInt(
    process.env.PINOKIO_PLAYWRIGHT_INSTALL_TIMEOUT_MS,
    600000,
    10000,
    1800000
  );
  const out = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 16
  });
  if (out.error) {
    if ((out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`playwright install timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run playwright install command: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `playwright install command failed (${String(out.status)}): ${String(out.stderr || out.stdout || '').trim()}`
    );
  }
}

function installBrowserDependencies(payload: ServicePayload): void {
  const command = resolveDepsInstallCommand(payload);
  const timeoutMs = toInt(
    process.env.PINOKIO_PLAYWRIGHT_INSTALL_DEPS_TIMEOUT_MS,
    900000,
    10000,
    2700000
  );
  const out = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 32
  });
  if (out.error) {
    if ((out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`playwright dependency install timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run playwright deps install command: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `playwright deps install command failed (${String(out.status)}): ${String(out.stderr || out.stdout || '').trim()}`
    );
  }
}

async function withChromiumInstallRetry<T>(
  payload: ServicePayload,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (initialError) {
    let lastError: unknown = initialError;

    if (shouldAutoInstallDeps(payload)) {
      try {
        installBrowserDependencies(payload);
        return await run();
      } catch (afterDepsError) {
        lastError = afterDepsError;
      }
    }

    if (
      shouldAutoInstallChromium(payload) &&
      (missingChromiumBinary(lastError) || missingChromiumBinary(initialError))
    ) {
      installChromium(payload);
      return await run();
    }

    if (
      shouldAutoInstallDeps(payload) &&
      (missingBrowserDependencies(lastError) || missingBrowserDependencies(initialError))
    ) {
      throw lastError;
    }

    throw initialError;
  }
}

async function readInput(): Promise<ServicePayload> {
  const fromEnv = asOptionalString(process.env.PINOKIO_PLAYWRIGHT_PAYLOAD_B64);
  if (fromEnv) {
    return payloadFromBase64(fromEnv);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('no input payload provided to playwright service');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parsePayload(parsed);
}

function resolveDefaultUserDataDir(payload: ServicePayload): string {
  const explicit = asOptionalString(payload.user_data_dir);
  if (explicit) {
    return explicit;
  }
  const configuredBaseRaw =
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_USER_CONTEXT_DIR) ||
    (process.env.PINOKIO_CHILD_MODE === '1'
      ? '/app/.pinokio-agent/playwright-profile'
      : path.join(os.homedir(), '.pinokio-agent', 'playwright-profile'));
  const configuredBase =
    configuredBaseRaw === '~'
      ? os.homedir()
      : configuredBaseRaw.startsWith('~/')
        ? path.join(os.homedir(), configuredBaseRaw.slice(2))
        : configuredBaseRaw;
  const url = asOptionalString(payload.url) || 'unknown-site';
  let scope = 'unknown-site';
  try {
    scope = new URL(url).hostname || scope;
  } catch {
    scope = url.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || scope;
  }
  return path.join(configuredBase, scope.toLowerCase());
}

function baseLaunchArgs(): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-infobars'
  ];
}

async function tryLaunchWithStealthPlugin(headless: boolean): Promise<Browser | null> {
  try {
    const extraModName = 'playwright-extra';
    const stealthModName = 'playwright-extra-plugin-stealth';
    const extraMod = (await import(extraModName as string)) as Record<string, unknown>;
    const stealthMod = (await import(stealthModName as string)) as Record<string, unknown>;
    const chromiumExtra = extraMod.chromium as {
      use: (plugin: unknown) => void;
      launch: (options?: LaunchOptions) => Promise<Browser>;
    };
    if (!chromiumExtra || typeof chromiumExtra.use !== 'function' || typeof chromiumExtra.launch !== 'function') {
      return null;
    }
    const stealthFactory =
      (stealthMod.default as (() => unknown) | undefined) ||
      (stealthMod.stealth as (() => unknown) | undefined);
    if (!stealthFactory) {
      return null;
    }
    chromiumExtra.use(stealthFactory());
    return await chromiumExtra.launch({
      headless,
      args: baseLaunchArgs()
    });
  } catch {
    return null;
  }
}

async function applyStealthHardening(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9'
  });
  await context.addInitScript(() => {
    const browserGlobal = globalThis as unknown as Record<string, unknown>;
    const navigatorLike = browserGlobal.navigator as Record<string, unknown> | undefined;
    if (!navigatorLike) {
      return;
    }
    Object.defineProperty(navigatorLike, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigatorLike, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigatorLike, 'plugins', { get: () => [1, 2, 3, 4] });

    const permissionsLike = navigatorLike.permissions as
      | { query?: (parameters: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    const originalQuery =
      permissionsLike && typeof permissionsLike.query === 'function'
        ? permissionsLike.query.bind(permissionsLike)
        : null;
    if (permissionsLike && originalQuery) {
      permissionsLike.query = (parameters: Record<string, unknown>) =>
        parameters?.name === 'notifications'
          ? Promise.resolve({
              state:
                (browserGlobal.Notification as { permission?: string } | undefined)?.permission ||
                'default'
            })
          : originalQuery(parameters);
    }
  });
}

async function createSession(payload: ServicePayload): Promise<Session> {
  const timeoutMs = toInt(payload.timeout_ms, 45000, 1000, 300000);
  const defaultHeadless = toBool(process.env.PINOKIO_PLAYWRIGHT_DEFAULT_HEADLESS, false);
  const defaultUseUserContext = toBool(
    process.env.PINOKIO_PLAYWRIGHT_DEFAULT_USE_USER_CONTEXT,
    true
  );
  const headless = toBool(payload.headless, defaultHeadless);
  const useStealth = toBool(payload.use_stealth, true);
  const useUserContext = toBool(payload.use_user_context, defaultUseUserContext);
  const storageStatePath = asOptionalString(payload.storage_state_path);
  const launchOptions: LaunchOptions = {
    headless,
    args: baseLaunchArgs(),
    timeout: timeoutMs
  };

  const browserFallback = async (): Promise<Browser> =>
    chromium.launch(launchOptions);

  if (useUserContext) {
    const userDataDir = resolveDefaultUserDataDir(payload);
    fs.mkdirSync(userDataDir, { recursive: true });
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: baseLaunchArgs(),
      viewport: { width: 1440, height: 900 }
    });
    await applyStealthHardening(context);
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      close: async () => context.close(),
      usedStealthPlugin: false,
      usedStealthHardening: true,
      headless,
      userContext: true
    };
  }

  let browser: Browser | null = null;
  let usedStealthPlugin = false;
  if (useStealth) {
    browser = await tryLaunchWithStealthPlugin(headless);
    usedStealthPlugin = Boolean(browser);
  }
  if (!browser) {
    browser = await browserFallback();
  }

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    viewport: { width: 1440, height: 900 }
  };
  if (storageStatePath && fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
  }
  const context = await browser.newContext(contextOptions);
  await applyStealthHardening(context);
  const page = await context.newPage();
  return {
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
    usedStealthPlugin,
    usedStealthHardening: true,
    headless,
    userContext: false
  };
}

function normalizeWaitUntil(value: unknown): 'load' | 'domcontentloaded' | 'networkidle' | 'commit' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'load' || normalized === 'domcontentloaded' || normalized === 'networkidle' || normalized === 'commit') {
    return normalized;
  }
  return 'domcontentloaded';
}

async function ensureNavigation(page: Page, payload: ServicePayload): Promise<void> {
  const url = asOptionalString(payload.url);
  if (!url) {
    return;
  }
  const timeoutMs = toInt(payload.timeout_ms, 45000, 1000, 300000);
  await page.goto(url, {
    waitUntil: normalizeWaitUntil(payload.wait_until),
    timeout: timeoutMs
  });
}

function resolveExpectedHost(payload: ServicePayload): string | null {
  const explicit = asOptionalString(payload.auth_expected_host);
  if (explicit) {
    return explicit.toLowerCase();
  }
  const targetUrl = asOptionalString(payload.url);
  if (!targetUrl) {
    return null;
  }
  try {
    return new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseUrl(value: string | null): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostMatchesExpected(currentHost: string, expectedHost: string | null): boolean {
  if (!expectedHost) {
    return true;
  }
  const normalizedCurrent = currentHost.trim().toLowerCase();
  const normalizedExpected = expectedHost.trim().toLowerCase();
  if (!normalizedCurrent || !normalizedExpected) {
    return false;
  }
  return (
    normalizedCurrent === normalizedExpected ||
    normalizedCurrent.endsWith(`.${normalizedExpected}`) ||
    normalizedExpected.endsWith(`.${normalizedCurrent}`)
  );
}

function hasMailRoute(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  const hash = url.hash.toLowerCase();
  const search = url.search.toLowerCase();
  return (
    /\/mail(?:\/|$)/.test(path) ||
    /\/mail(?:\/|$)/.test(hash) ||
    search.includes('/mail/') ||
    search.includes('%2fmail%2f') ||
    search.includes('deeplink=%2fmail%2f')
  );
}

function checkpointSatisfiedByUrl(currentUrl: string | null, expectedHost: string | null): boolean {
  const parsed = parseUrl(currentUrl);
  if (!parsed) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!hostMatchesExpected(host, expectedHost)) {
    return false;
  }

  const expected = (expectedHost || '').toLowerCase();
  const expectsOutlook =
    expected.includes('outlook') || expected.includes('hotmail') || host.includes('outlook');
  const expectsGmail =
    expected.includes('gmail') || expected.includes('google') || host.includes('mail.google.com');

  if (expectsOutlook || expectsGmail) {
    return hasMailRoute(parsed);
  }
  return true;
}

function safePageUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

interface OverlayReadySignal {
  ready: boolean;
  source: string | null;
  url: string | null;
  host: string | null;
  at: string | null;
}

interface OverlayToastButton {
  id: string;
  label: string;
  variant?: string;
  prompt?: string;
}

interface OverlayToastPayload {
  title: string;
  message?: string;
  sticky?: boolean;
  timeout_ms?: number;
  buttons?: OverlayToastButton[];
  input_placeholder?: string;
  input_value?: string;
}

async function readOverlayReadySignal(page: Page): Promise<OverlayReadySignal> {
  try {
    return await page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      const storage = (win as { localStorage?: { getItem?: (key: string) => string | null } }).localStorage;
      const raw =
        typeof storage?.getItem === 'function'
          ? storage.getItem('pinokio_probe_ready_v1')
          : null;
      if (!raw) {
        return { ready: false, source: null, url: null, host: null, at: null };
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ready: false, source: null, url: null, host: null, at: null };
        }
        const row = parsed as Record<string, unknown>;
        const ready = Boolean(row.ready);
        return {
          ready,
          source: typeof row.source === 'string' ? row.source : null,
          url: typeof row.url === 'string' ? row.url : null,
          host: typeof row.host === 'string' ? row.host : null,
          at: typeof row.at === 'string' ? row.at : null
        };
      } catch {
        return { ready: false, source: null, url: null, host: null, at: null };
      }
    });
  } catch {
    return { ready: false, source: null, url: null, host: null, at: null };
  }
}

async function clearOverlayReadySignal(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      const storage = (win as { localStorage?: { removeItem?: (key: string) => void } }).localStorage;
      if (typeof storage?.removeItem === 'function') {
        storage.removeItem('pinokio_probe_ready_v1');
      }
    });
  } catch {
    // ignore
  }
}

async function pushOverlayToast(page: Page, payload: OverlayToastPayload): Promise<boolean> {
  try {
    return await page.evaluate((toastPayload) => {
      const win = globalThis as unknown as Record<string, unknown>;
      const overlay = win.__pinokioProbeOverlay as
        | { pushToast?: (payload: OverlayToastPayload) => void }
        | undefined;
      if (!overlay || typeof overlay.pushToast !== 'function') {
        return false;
      }
      overlay.pushToast(toastPayload);
      return true;
    }, payload);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeBackgroundResultIfNeeded(
  payload: ServicePayload,
  result: Record<string, unknown>
): void {
  const resultPath = asOptionalString(payload.background_result_path);
  if (!resultPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  } catch {
    // Best-effort handoff for background mode.
  }
}

async function runDiscoverNonBlocking(payload: ServicePayload): Promise<Record<string, unknown>> {
  const keepOpenMs = toInt(payload.keep_open_after_discovery_ms, 0, 0, 300000);
  if (keepOpenMs <= 0) {
    return runDiscover(payload);
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('cannot spawn background playwright worker: missing script path');
  }

  const timeoutMs = toInt(payload.timeout_ms, 45000, 1000, 300000);
  const waitTimeoutMs = Math.max(timeoutMs + 120000, 30000);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const runDir = path.join(os.tmpdir(), 'pinokio-agent-playwright');
  fs.mkdirSync(runDir, { recursive: true });
  const resultPath = path.join(runDir, `discover-${runId}.json`);
  const errorPath = path.join(runDir, `discover-${runId}.err.json`);

  const childPayload: ServicePayload = {
    ...payload,
    non_blocking_keep_open: false,
    _background_worker: true,
    background_result_path: resultPath
  };
  const encodedPayload = Buffer.from(JSON.stringify(childPayload), 'utf8').toString('base64');
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PINOKIO_PLAYWRIGHT_PAYLOAD_B64: encodedPayload,
      PINOKIO_PLAYWRIGHT_BACKGROUND_ERROR_PATH: errorPath
    }
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < waitTimeoutMs) {
    if (fs.existsSync(errorPath)) {
      try {
        const raw = fs.readFileSync(errorPath, 'utf8').trim();
        fs.unlinkSync(errorPath);
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const message = asOptionalString(parsed.error) || 'background playwright worker failed';
          throw new Error(message);
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(String(error));
      }
      throw new Error('background playwright worker failed');
    }

    if (fs.existsSync(resultPath)) {
      try {
        const raw = fs.readFileSync(resultPath, 'utf8').trim();
        fs.unlinkSync(resultPath);
        if (!raw) {
          throw new Error('background playwright worker returned empty result');
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('background playwright worker returned invalid JSON');
        }
        return parsed as Record<string, unknown>;
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(String(error));
      }
    }
    await sleep(120);
  }

  throw new Error(`background playwright worker timed out after ${waitTimeoutMs}ms`);
}

async function installProbeOverlay(page: Page, payload: ServicePayload): Promise<void> {
  const enabled = toBool(payload.probe_overlay_enabled, false);
  if (!enabled) {
    return;
  }
  const autoActivate = toBool(payload.probe_overlay_auto_activate, true);
  const reset = toBool(payload.probe_overlay_reset, false);
  const trainingMode = toBool(payload.probe_training_mode, false);
  const walkthroughPlan =
    payload.probe_walkthrough_plan && typeof payload.probe_walkthrough_plan === 'object' && !Array.isArray(payload.probe_walkthrough_plan)
      ? payload.probe_walkthrough_plan
      : null;
  await page.evaluate(
    ({ autoActivate: shouldActivate, reset: shouldReset, trainingMode: shouldTraining, walkthroughPlan: rawWalkthroughPlan }) => {
      const win = globalThis as unknown as Record<string, unknown>;
      const doc = (win as { document?: any }).document;
      if (!doc) {
        return;
      }

      const STORAGE_KEY = 'pinokio_probe_labels_v1';
      const READY_KEY = 'pinokio_probe_ready_v1';
      const ACTION_QUEUE_KEY = 'pinokio_probe_actions_v1';
      const TRAINING_STATE_KEY = 'pinokio_probe_training_v1';
      const WALKTHROUGH_STATE_KEY = 'pinokio_probe_walkthrough_v1';
      const ROOT_ID = 'pinokio-probe-overlay-root';
      const STYLE_ID = 'pinokio-probe-overlay-style';
      const TOAST_ROOT_ID = 'pinokio-probe-toast-root';

      const storage = (win as { localStorage?: { getItem?: (key: string) => string | null; setItem?: (key: string, value: string) => void; removeItem?: (key: string) => void } }).localStorage;
      const nav = (win as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<unknown> } } }).navigator;

      const readJson = (key: string, fallback: unknown): unknown => {
        try {
          const raw = typeof storage?.getItem === 'function' ? storage.getItem(key) : null;
          if (!raw) {
            return fallback;
          }
          const parsed = JSON.parse(raw);
          return parsed;
        } catch {
          return fallback;
        }
      };

      const writeJson = (key: string, value: unknown): void => {
        try {
          if (typeof storage?.setItem === 'function') {
            storage.setItem(key, JSON.stringify(value));
          }
        } catch {
          // ignore
        }
      };

      const parseLabels = (): Array<Record<string, unknown>> => {
        const parsed = readJson(STORAGE_KEY, []);
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
      };

      const saveLabels = (labels: Array<Record<string, unknown>>) => {
        writeJson(STORAGE_KEY, labels.slice(0, 200));
      };

      const parseTrainingState = (): Record<string, unknown> => {
        const parsed = readJson(TRAINING_STATE_KEY, {});
        const row = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
        return {
          mode: 'cleanup_training',
          junk_done: Boolean(row.junk_done),
          keep_done: Boolean(row.keep_done),
          mutate_done: Boolean(row.mutate_done),
          updated_at: typeof row.updated_at === 'string' ? row.updated_at : null
        };
      };

      const saveTrainingState = (state: Record<string, unknown>) => {
        writeJson(TRAINING_STATE_KEY, {
          mode: 'cleanup_training',
          junk_done: Boolean(state.junk_done),
          keep_done: Boolean(state.keep_done),
          mutate_done: Boolean(state.mutate_done),
          updated_at: new Date().toISOString()
        });
      };

      const normalizeToken = (value: unknown): string => {
        return String(value || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 96);
      };

      const parseWalkthroughPlan = (): {
        goal: string;
        steps: Array<{
          id: string;
          kind: 'label' | 'action';
          title: string;
          instruction: string;
          suggested_label: string | null;
          required: boolean;
        }>;
      } | null => {
        const raw = rawWalkthroughPlan && typeof rawWalkthroughPlan === 'object' && !Array.isArray(rawWalkthroughPlan)
          ? rawWalkthroughPlan as Record<string, unknown>
          : null;
        if (!raw) {
          return null;
        }
        const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
        const steps: Array<{
          id: string;
          kind: 'label' | 'action';
          title: string;
          instruction: string;
          suggested_label: string | null;
          required: boolean;
        }> = [];
        for (const item of rawSteps.slice(0, 20)) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
          }
          const row = item as Record<string, unknown>;
          const kind = String(row.kind || 'label').toLowerCase() === 'action' ? 'action' : 'label';
          const id = normalizeToken(row.id || row.suggested_label || row.title || `step_${steps.length + 1}`);
          if (!id) {
            continue;
          }
          const title = String(row.title || id).trim().slice(0, 200) || id;
          const instruction = String(row.instruction || '').trim().slice(0, 1000) ||
            (kind === 'label'
              ? 'Label this control in the overlay.'
              : 'Perform this action and mark the step done.');
          const suggestedLabelRaw = normalizeToken(row.suggested_label || row.id || '');
          steps.push({
            id,
            kind,
            title,
            instruction,
            suggested_label: kind === 'label' ? (suggestedLabelRaw || id) : null,
            required: row.required !== false
          });
        }
        if (steps.length === 0) {
          return null;
        }
        const goal = String(raw.goal || 'Guided walkthrough').trim().slice(0, 240) || 'Guided walkthrough';
        return {
          goal,
          steps
        };
      };

      const walkthroughPlan = parseWalkthroughPlan();

      const parseWalkthroughState = (): Record<string, unknown> | null => {
        if (!walkthroughPlan) {
          return null;
        }
        const planKey = walkthroughPlan.steps.map((step) => `${step.kind}:${step.id}`).join('|');
        const parsed = readJson(WALKTHROUGH_STATE_KEY, {});
        const row = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
        const completedRaw = Array.isArray(row.completed_ids) ? row.completed_ids : [];
        const completedIds = completedRaw
          .map((item) => normalizeToken(item))
          .filter((item) => item.length > 0)
          .slice(0, 200);
        const activeIndexRaw = Number(row.active_index);
        const activeIndex = Number.isFinite(activeIndexRaw) && activeIndexRaw >= 0
          ? Math.trunc(activeIndexRaw)
          : 0;
        if (String(row.plan_key || '') !== planKey) {
          return {
            plan_key: planKey,
            completed_ids: [],
            active_index: 0,
            updated_at: new Date().toISOString()
          };
        }
        return {
          plan_key: planKey,
          completed_ids: completedIds,
          active_index: activeIndex,
          updated_at: typeof row.updated_at === 'string' ? row.updated_at : null
        };
      };

      const saveWalkthroughState = (state: Record<string, unknown>) => {
        writeJson(WALKTHROUGH_STATE_KEY, {
          plan_key: String(state.plan_key || ''),
          completed_ids: Array.isArray(state.completed_ids) ? state.completed_ids.slice(0, 200) : [],
          active_index: Number.isFinite(Number(state.active_index)) ? Math.max(0, Math.trunc(Number(state.active_index))) : 0,
          updated_at: new Date().toISOString()
        });
      };

      const pushActionEvent = (eventType: string, payload: Record<string, unknown> = {}) => {
        const rawQueue = readJson(ACTION_QUEUE_KEY, []);
        const queue = Array.isArray(rawQueue) ? rawQueue : [];
        queue.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          type: eventType,
          payload,
          at: new Date().toISOString(),
          url: ((win as { location?: { href?: string } }).location?.href) || null
        });
        writeJson(ACTION_QUEUE_KEY, queue.slice(-200));
      };

      const ensureStyle = () => {
        if (doc.getElementById(STYLE_ID)) {
          return;
        }
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
          #${ROOT_ID} {
            position: fixed;
            right: max(12px, env(safe-area-inset-right));
            bottom: max(12px, env(safe-area-inset-bottom));
            z-index: 2147483647;
            width: min(380px, calc(100vw - 24px));
            max-height: min(64vh, 560px);
            overflow: auto;
            box-sizing: border-box;
            background: rgba(15, 23, 42, 0.95);
            color: #f8fafc;
            border: 1px solid rgba(148, 163, 184, 0.35);
            border-radius: 14px;
            padding: 12px;
            box-shadow: 0 18px 40px rgba(2, 6, 23, 0.55);
            backdrop-filter: blur(8px);
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          #${ROOT_ID} * {
            box-sizing: border-box;
          }
          .pinokio-probe-title {
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.01em;
          }
          .pinokio-probe-muted {
            font-size: 12px;
            opacity: 0.82;
            line-height: 1.35;
            margin: 8px 0 10px;
          }
          .pinokio-probe-actions {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 8px;
          }
          .pinokio-probe-btn {
            border: 1px solid rgba(148, 163, 184, 0.4);
            background: rgba(30, 41, 59, 0.8);
            color: #f8fafc;
            border-radius: 10px;
            padding: 8px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            text-align: center;
          }
          .pinokio-probe-btn:hover {
            background: rgba(51, 65, 85, 0.95);
          }
          .pinokio-probe-btn[data-variant="success"] {
            background: rgba(16, 185, 129, 0.22);
            border-color: rgba(16, 185, 129, 0.65);
          }
          .pinokio-probe-btn[data-variant="danger"] {
            background: rgba(239, 68, 68, 0.24);
            border-color: rgba(248, 113, 113, 0.7);
          }
          .pinokio-probe-btn[data-variant="primary"] {
            background: rgba(37, 99, 235, 0.28);
            border-color: rgba(96, 165, 250, 0.8);
          }
          .pinokio-probe-kpi {
            font-size: 12px;
            opacity: 0.84;
          }
          #${TOAST_ROOT_ID} {
            position: fixed;
            right: max(12px, env(safe-area-inset-right));
            top: max(12px, env(safe-area-inset-top));
            z-index: 2147483647;
            width: min(360px, calc(100vw - 24px));
            display: flex;
            flex-direction: column;
            gap: 8px;
            pointer-events: none;
          }
          .pinokio-probe-toast {
            pointer-events: auto;
            background: rgba(15, 23, 42, 0.97);
            border: 1px solid rgba(148, 163, 184, 0.35);
            border-radius: 12px;
            padding: 10px;
            color: #e2e8f0;
            box-shadow: 0 12px 30px rgba(2, 6, 23, 0.45);
            animation: pinokio-toast-in 180ms ease-out;
          }
          .pinokio-probe-toast-title {
            font-size: 12px;
            font-weight: 700;
            margin-bottom: 4px;
          }
          .pinokio-probe-toast-message {
            font-size: 12px;
            line-height: 1.35;
            opacity: 0.92;
          }
          .pinokio-probe-toast-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
          }
          .pinokio-probe-input {
            width: 100%;
            margin-top: 8px;
            border: 1px solid rgba(148, 163, 184, 0.45);
            background: rgba(15, 23, 42, 0.85);
            color: #f8fafc;
            border-radius: 10px;
            padding: 8px 10px;
            font-size: 12px;
          }
          .pinokio-probe-backdrop {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: rgba(2, 6, 23, 0.45);
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
          }
          .pinokio-probe-backdrop[data-open="1"] {
            display: flex;
            animation: pinokio-fade-in 180ms ease-out;
          }
          .pinokio-probe-modal {
            width: min(460px, calc(100vw - 32px));
            background: rgba(15, 23, 42, 0.98);
            border: 1px solid rgba(148, 163, 184, 0.4);
            border-radius: 14px;
            padding: 14px;
            color: #f8fafc;
            box-shadow: 0 20px 50px rgba(2, 6, 23, 0.6);
            animation: pinokio-modal-in 220ms ease-out;
          }
          .pinokio-probe-mark {
            outline: 2px solid rgba(34, 197, 94, 0.95) !important;
            outline-offset: 2px !important;
          }
          @keyframes pinokio-toast-in {
            from { opacity: 0; transform: translateY(-8px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes pinokio-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes pinokio-modal-in {
            from { opacity: 0; transform: translateY(10px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          @media (max-height: 640px) {
            #${ROOT_ID} {
              top: max(12px, env(safe-area-inset-top));
              bottom: auto;
              max-height: min(72vh, 480px);
            }
          }
        `;
        doc.head?.appendChild(style);
      };

      const normalizeSelectorHint = (el: any): string => {
        const id = (el.getAttribute('id') || '').trim();
        if (id) {
          return `#${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
        }
        const tag = (el.tagName || 'div').toLowerCase();
        const attrs = [
          { name: 'name', value: (el.getAttribute('name') || '').trim() },
          { name: 'aria-label', value: (el.getAttribute('aria-label') || '').trim() },
          { name: 'placeholder', value: (el.getAttribute('placeholder') || '').trim() },
          { name: 'data-testid', value: (el.getAttribute('data-testid') || '').trim() },
          { name: 'role', value: (el.getAttribute('role') || '').trim() },
          { name: 'type', value: (el.getAttribute('type') || '').trim() }
        ].filter((pair) => pair.value.length > 0);
        if (attrs.length > 0) {
          const first = attrs[0];
          const name = first?.name || 'name';
          const value = first?.value || '';
          const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return `${tag}[${name}="${escaped}"]`;
        }
        return tag;
      };

      const shortText = (value: string, max: number = 160): string => {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        if (normalized.length <= max) {
          return normalized;
        }
        return `${normalized.slice(0, Math.max(0, max - 1))}…`;
      };

      const escapeHtml = (value: unknown): string => {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      };

      const elementLabel = (el: any): string => {
        const explicit =
          el.getAttribute('aria-label') ||
          el.getAttribute('name') ||
          el.getAttribute('placeholder');
        if (explicit && explicit.trim().length > 0) {
          return shortText(explicit, 80);
        }
        const text = shortText(String(el.innerText || el.textContent || ''), 80);
        if (text) {
          return text;
        }
        return `${(el.tagName || 'element').toLowerCase()} field`;
      };

      const ensureToastRoot = () => {
        let toastRoot = doc.getElementById(TOAST_ROOT_ID);
        if (!toastRoot) {
          toastRoot = doc.createElement('div');
          toastRoot.id = TOAST_ROOT_ID;
          doc.body.appendChild(toastRoot);
        }
        return toastRoot;
      };

      const showToast = (options: {
        title: string;
        message?: string;
        sticky?: boolean;
        timeout_ms?: number;
        buttons?: Array<{ id: string; label: string; variant?: string; prompt?: string }>;
        input_placeholder?: string;
        input_value?: string;
      }) => {
        const toastRoot = ensureToastRoot();
        const toast = doc.createElement('div');
        toast.className = 'pinokio-probe-toast';
        const title = shortText(options.title || 'Pinokio', 96);
        const message = shortText(options.message || '', 260);
        toast.innerHTML = `
          <div class="pinokio-probe-toast-title">${escapeHtml(title)}</div>
          ${message ? `<div class="pinokio-probe-toast-message">${escapeHtml(message)}</div>` : ''}
        `;

        const buttonList = Array.isArray(options.buttons) ? options.buttons : [];
        if (buttonList.length > 0) {
          const actions = doc.createElement('div');
          actions.className = 'pinokio-probe-toast-actions';
          for (const button of buttonList.slice(0, 4)) {
            const el = doc.createElement('button');
            el.className = 'pinokio-probe-btn';
            el.setAttribute('data-variant', button.variant || 'primary');
            el.textContent = shortText(button.label || 'Action', 26);
            el.addEventListener('click', () => {
              if (button.id === 'ready') {
                const url = ((win as { location?: { href?: string } }).location?.href) || null;
                const host = (() => {
                  try {
                    return url ? new URL(url).hostname : null;
                  } catch {
                    return null;
                  }
                })();
                writeJson(READY_KEY, {
                  ready: true,
                  source: 'toast',
                  url,
                  host,
                  at: new Date().toISOString()
                });
                pushActionEvent('ready', { source: 'toast' });
              }
              if (button.prompt) {
                pushActionEvent('prompt', { prompt: button.prompt });
              }
              toast.remove();
            });
            actions.appendChild(el);
          }
          toast.appendChild(actions);
        }

        if (options.input_placeholder || options.input_value) {
          const input = doc.createElement('input');
          input.className = 'pinokio-probe-input';
          input.placeholder = String(options.input_placeholder || 'Type here...');
          input.value = String(options.input_value || '');
          toast.appendChild(input);
          const submitRow = doc.createElement('div');
          submitRow.className = 'pinokio-probe-toast-actions';
          const sendButton = doc.createElement('button');
          sendButton.className = 'pinokio-probe-btn';
          sendButton.setAttribute('data-variant', 'primary');
          sendButton.textContent = 'Submit';
          sendButton.addEventListener('click', () => {
            const value = String(input.value || '').trim();
            if (!value) {
              return;
            }
            pushActionEvent('input', { value });
            toast.remove();
          });
          submitRow.appendChild(sendButton);
          toast.appendChild(submitRow);
        }

        toastRoot.appendChild(toast);
        const sticky = Boolean(options.sticky);
        const timeoutMs = Math.max(1500, Math.min(30000, Number(options.timeout_ms || 7000)));
        if (!sticky) {
          setTimeout(() => {
            toast.remove();
          }, timeoutMs);
        }
      };

      let labels = parseLabels();
      let trainingState = parseTrainingState();
      let walkthroughState = parseWalkthroughState();
      if (shouldReset) {
        labels = [];
        saveLabels(labels);
        trainingState = {
          mode: 'cleanup_training',
          junk_done: false,
          keep_done: false,
          mutate_done: false,
          updated_at: new Date().toISOString()
        };
        saveTrainingState(trainingState);
        if (walkthroughState) {
          walkthroughState = {
            plan_key: String(walkthroughState.plan_key || ''),
            completed_ids: [],
            active_index: 0,
            updated_at: new Date().toISOString()
          };
          saveWalkthroughState(walkthroughState);
        }
        try {
          if (typeof storage?.removeItem === 'function') {
            storage.removeItem(READY_KEY);
          } else {
            writeJson(READY_KEY, null);
          }
        } catch {
          // ignore
        }
      }

      ensureStyle();

      let root = doc.getElementById(ROOT_ID);
      if (!root) {
        root = doc.createElement('div');
        root.id = ROOT_ID;
        doc.body.appendChild(root);
      }

      let modalOpen = false;
      const promptForLabel = (defaultLabel: string): Promise<string | null> => {
        return new Promise((resolve) => {
          if (modalOpen) {
            resolve(null);
            return;
          }
          modalOpen = true;
          const backdrop = doc.createElement('div');
          backdrop.className = 'pinokio-probe-backdrop';
          backdrop.setAttribute('data-open', '1');
          backdrop.innerHTML = `
            <div class="pinokio-probe-modal" role="dialog" aria-modal="true" aria-label="Label element">
              <div class="pinokio-probe-title">Label Element</div>
              <p class="pinokio-probe-muted">Add a reusable label for this field/button so automation can target it reliably.</p>
              <input class="pinokio-probe-input" data-label-input />
              <div class="pinokio-probe-actions" style="margin-top:10px;">
                <button class="pinokio-probe-btn" data-variant="primary" data-modal-action="save">Save Label</button>
                <button class="pinokio-probe-btn" data-modal-action="cancel">Cancel</button>
              </div>
            </div>
          `;
          doc.body.appendChild(backdrop);
          const input = backdrop.querySelector('[data-label-input]') as any;
          if (input) {
            input.value = defaultLabel;
            input.focus();
            input.select();
          }

          const close = (value: string | null) => {
            modalOpen = false;
            backdrop.remove();
            resolve(value && value.trim() ? value.trim() : null);
          };

          backdrop.addEventListener('click', (event: any) => {
            const target = event?.target as any;
            if (!target) return;
            if (target === backdrop) {
              close(null);
              return;
            }
            const action = target.getAttribute && target.getAttribute('data-modal-action');
            if (action === 'cancel') {
              close(null);
              return;
            }
            if (action === 'save') {
              close(String(input?.value || ''));
            }
          });

          backdrop.addEventListener('keydown', (event: any) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close(null);
              return;
            }
            if (event.key === 'Enter' && input === doc.activeElement) {
              event.preventDefault();
              close(String(input?.value || ''));
            }
          });
        });
      };

      let active = shouldActivate;
      const mark = (el: any) => {
        el.setAttribute('data-pinokio-probe-labeled', '1');
        el.classList?.add('pinokio-probe-mark');
      };

      const normalizeWalkthroughId = (value: unknown): string => normalizeToken(value);

      const getWalkthroughCompletedSet = (): Set<string> => {
        const out = new Set<string>();
        if (!walkthroughState || !Array.isArray(walkthroughState.completed_ids)) {
          return out;
        }
        for (const item of walkthroughState.completed_ids) {
          const id = normalizeWalkthroughId(item);
          if (id) {
            out.add(id);
          }
        }
        return out;
      };

      const setWalkthroughCompletedSet = (completed: Set<string>) => {
        if (!walkthroughPlan || !walkthroughState) {
          return;
        }
        walkthroughState.completed_ids = Array.from(completed).slice(0, 200);
        saveWalkthroughState(walkthroughState);
      };

      const syncWalkthroughFromLabels = () => {
        if (!walkthroughPlan || !walkthroughState) {
          return;
        }
        const completed = getWalkthroughCompletedSet();
        let changed = false;
        for (const step of walkthroughPlan.steps) {
          if (step.kind !== 'label') {
            continue;
          }
          const stepId = normalizeWalkthroughId(step.id);
          if (!stepId || completed.has(stepId)) {
            continue;
          }
          const expectedLabel = normalizeWalkthroughId(step.suggested_label || step.id);
          const matched = labels.some((item) => {
            const label = normalizeWalkthroughId((item as { label?: unknown }).label || '');
            return Boolean(label && expectedLabel && label === expectedLabel);
          });
          if (matched) {
            completed.add(stepId);
            changed = true;
          }
        }
        if (changed) {
          setWalkthroughCompletedSet(completed);
        }
      };

      const getCurrentWalkthroughStep = (): {
        index: number;
        step: {
          id: string;
          kind: 'label' | 'action';
          title: string;
          instruction: string;
          suggested_label: string | null;
          required: boolean;
        } | null;
      } => {
        if (!walkthroughPlan || !walkthroughState) {
          return { index: -1, step: null };
        }
        syncWalkthroughFromLabels();
        const completed = getWalkthroughCompletedSet();
        const start = Number.isFinite(Number(walkthroughState.active_index))
          ? Math.max(0, Math.trunc(Number(walkthroughState.active_index)))
          : 0;
        for (let i = start; i < walkthroughPlan.steps.length; i += 1) {
          const step = walkthroughPlan.steps[i];
          const stepId = normalizeWalkthroughId(step.id);
          if (!stepId || completed.has(stepId)) {
            continue;
          }
          walkthroughState.active_index = i;
          saveWalkthroughState(walkthroughState);
          return { index: i, step };
        }
        for (let i = 0; i < walkthroughPlan.steps.length; i += 1) {
          const step = walkthroughPlan.steps[i];
          const stepId = normalizeWalkthroughId(step.id);
          if (!stepId || completed.has(stepId)) {
            continue;
          }
          walkthroughState.active_index = i;
          saveWalkthroughState(walkthroughState);
          return { index: i, step };
        }
        walkthroughState.active_index = walkthroughPlan.steps.length;
        saveWalkthroughState(walkthroughState);
        return { index: walkthroughPlan.steps.length, step: null };
      };

      const markWalkthroughStepDone = (step: { id: string; title: string }, source: string) => {
        if (!walkthroughPlan || !walkthroughState) {
          return;
        }
        const stepId = normalizeWalkthroughId(step.id);
        if (!stepId) {
          return;
        }
        const completed = getWalkthroughCompletedSet();
        if (!completed.has(stepId)) {
          completed.add(stepId);
          setWalkthroughCompletedSet(completed);
          pushActionEvent('walkthrough_step_done', {
            step_id: stepId,
            step_title: step.title,
            source
          });
        }
        const next = getCurrentWalkthroughStep();
        if (next.step) {
          showToast({
            title: 'Next Walkthrough Step',
            message: `${next.step.title}: ${next.step.instruction}`,
            timeout_ms: 8000
          });
        } else {
          showToast({
            title: 'Walkthrough Complete',
            message: 'All required walkthrough steps are complete. Click READY to continue.',
            timeout_ms: 9000
          });
        }
      };

      const setGlobal = (currentActive: boolean) => {
        const readyAck = readJson(READY_KEY, null);
        win.__pinokioProbeOverlay = {
          active: currentActive,
          labels,
          storage_key: STORAGE_KEY,
          ready_ack: readyAck,
          training_state: shouldTraining ? trainingState : null,
          walkthrough_state: walkthroughPlan ? walkthroughState : null,
          updated_at: new Date().toISOString(),
          pushToast: (payload: unknown) => {
            const row = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
            const title = shortText(String(row.title || row.message || 'Pinokio'), 96);
            const message = shortText(String(row.message || ''), 260);
            const buttonsRaw = Array.isArray(row.buttons) ? row.buttons : [];
            const buttons = buttonsRaw
              .map((item) => {
                if (!item || typeof item !== 'object') return null;
                const rec = item as Record<string, unknown>;
                const id = String(rec.id || '').trim();
                const label = String(rec.label || '').trim();
                if (!id || !label) return null;
                return {
                  id,
                  label,
                  variant: String(rec.variant || ''),
                  prompt: String(rec.prompt || '')
                };
              })
              .filter((item) => item !== null) as Array<{ id: string; label: string; variant?: string; prompt?: string }>;
            showToast({
              title,
              message,
              sticky: Boolean(row.sticky),
              timeout_ms: Number(row.timeout_ms || 7000),
              input_placeholder: String(row.input_placeholder || ''),
              input_value: String(row.input_value || ''),
              buttons
            });
          }
        };
      };

      const setReadyAck = (source: string) => {
        const url = ((win as { location?: { href?: string } }).location?.href) || null;
        const host = (() => {
          try {
            return url ? new URL(url).hostname : null;
          } catch {
            return null;
          }
        })();
        writeJson(READY_KEY, {
          ready: true,
          source,
          url,
          host,
          at: new Date().toISOString()
        });
        pushActionEvent('ready', { source, url, host });
        showToast({
          title: 'Ready Confirmed',
          message: 'Checkpoint marked ready. Keep this browser open while chat continues automation.',
          timeout_ms: 5000
        });
      };

      const render = (currentActive: boolean) => {
        if (!root) return;
        const count = labels.length;
        const walkthroughCurrent = getCurrentWalkthroughStep();
        const walkthroughCompleted = getWalkthroughCompletedSet();
        const walkthroughRequiredCount = walkthroughPlan
          ? walkthroughPlan.steps.filter((step) => step.required !== false).length
          : 0;
        const walkthroughDoneCount = walkthroughPlan
          ? walkthroughPlan.steps.filter((step) => {
              const stepId = normalizeWalkthroughId(step.id);
              if (!stepId) {
                return false;
              }
              return walkthroughCompleted.has(stepId);
            }).length
          : 0;
        const walkthroughHtml = walkthroughPlan
          ? (() => {
              const current = walkthroughCurrent.step;
              const total = walkthroughPlan.steps.length;
              if (!current) {
                return `
                  <p class="pinokio-probe-muted" style="margin-top:10px;">
                    Guided walkthrough complete (${walkthroughDoneCount}/${Math.max(1, walkthroughRequiredCount)} required steps).
                  </p>
                `;
              }
              const currentNumber = walkthroughCurrent.index + 1;
              const actionButtons = current.kind === 'action'
                ? `
                    <div class="pinokio-probe-actions" style="margin-top:8px;">
                      <button data-pinokio-action="walk_done" class="pinokio-probe-btn" data-variant="success">Mark Step Done</button>
                    </div>
                  `
                : '';
              const labelHint = current.kind === 'label' && current.suggested_label
                ? `<div class="pinokio-probe-kpi" style="margin-top:4px;">Expected label key: ${escapeHtml(current.suggested_label)}</div>`
                : '';
              return `
                <p class="pinokio-probe-muted" style="margin-top:10px;">
                  Guided walkthrough: ${walkthroughDoneCount}/${Math.max(1, walkthroughRequiredCount)} required steps complete.
                </p>
                <div class="pinokio-probe-muted" style="margin:0;">
                  Step ${currentNumber}/${total}: <strong>${escapeHtml(current.title)}</strong>
                </div>
                <div class="pinokio-probe-muted" style="margin-top:4px;">
                  ${escapeHtml(current.instruction)}
                </div>
                ${labelHint}
                ${actionButtons}
              `;
            })()
          : '';
        const trainingDoneCount =
          Number(Boolean(trainingState.junk_done)) +
          Number(Boolean(trainingState.keep_done)) +
          Number(Boolean(trainingState.mutate_done));
        const trainingHtml = shouldTraining && !walkthroughPlan
          ? `
            <p class="pinokio-probe-muted" style="margin-top:10px;">
              Training examples: ${trainingDoneCount}/3 complete.
            </p>
            <div class="pinokio-probe-actions" style="margin-bottom:8px;">
              <button data-pinokio-action="train_junk" class="pinokio-probe-btn" data-variant="${trainingState.junk_done ? 'success' : 'primary'}">${trainingState.junk_done ? 'JUNK DONE' : 'Mark JUNK'}</button>
              <button data-pinokio-action="train_keep" class="pinokio-probe-btn" data-variant="${trainingState.keep_done ? 'success' : 'primary'}">${trainingState.keep_done ? 'KEEP DONE' : 'Mark KEEP'}</button>
              <button data-pinokio-action="train_mutate" class="pinokio-probe-btn" data-variant="${trainingState.mutate_done ? 'success' : 'danger'}">${trainingState.mutate_done ? 'MUTATION DONE' : 'Mark DELETE/ARCHIVE'}</button>
            </div>
          `
          : '';
        root.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <strong class="pinokio-probe-title">Pinokio Browser Assistant</strong>
            <span class="pinokio-probe-kpi">${count} label${count === 1 ? '' : 's'}</span>
          </div>
          <p class="pinokio-probe-muted">
            ${currentActive ? 'Label mode is ON. Click any field/button to tag it. Press ESC to stop.' : 'Label mode is OFF. Turn it on to capture reusable selectors.'}
          </p>
          <div class="pinokio-probe-actions">
            <button data-pinokio-action="ready" class="pinokio-probe-btn" data-variant="success">READY</button>
            <button data-pinokio-action="toggle" class="pinokio-probe-btn" data-variant="${currentActive ? 'success' : 'primary'}">${currentActive ? 'Disable Labels' : 'Enable Labels'}</button>
            <button data-pinokio-action="copy" class="pinokio-probe-btn">Copy Labels</button>
            <button data-pinokio-action="clear" class="pinokio-probe-btn" data-variant="danger">Clear Labels</button>
          </div>
          ${walkthroughHtml}
          ${trainingHtml}
        `;
      };

      const setTrainingMark = (kind: 'junk' | 'keep' | 'mutate') => {
        if (!shouldTraining) {
          return;
        }
        if (kind === 'junk') {
          trainingState.junk_done = true;
        } else if (kind === 'keep') {
          trainingState.keep_done = true;
        } else if (kind === 'mutate') {
          trainingState.mutate_done = true;
        }
        saveTrainingState(trainingState);
        pushActionEvent('training_mark', { kind });
        setGlobal(active);
        render(active);
        showToast({
          title: 'Training Step Recorded',
          message: `Marked ${kind.toUpperCase()} example.`,
          timeout_ms: 2600
        });
      };

      let lastPassiveCaptureAtMs = 0;
      const capturePassiveEvent = (eventType: string, target: any, valueSample?: string) => {
        if (!shouldTraining && !walkthroughPlan) {
          return;
        }
        if (!target || !root) {
          return;
        }
        if (root.contains(target)) {
          return;
        }
        const nowMs = Date.now();
        if (nowMs - lastPassiveCaptureAtMs < 250) {
          return;
        }
        lastPassiveCaptureAtMs = nowMs;
        pushActionEvent(eventType, {
          selector_hint: normalizeSelectorHint(target),
          tag: (target.tagName || '').toLowerCase(),
          role: target.getAttribute ? (target.getAttribute('role') || null) : null,
          type: target.getAttribute ? (target.getAttribute('type') || null) : null,
          name: target.getAttribute ? (target.getAttribute('name') || null) : null,
          text_sample: shortText(String(target.innerText || target.textContent || ''), 80),
          value_sample: valueSample ? shortText(valueSample, 80) : undefined
        });
      };

      const onPassiveClick = (event: any) => {
        if ((!shouldTraining && !walkthroughPlan) || modalOpen) {
          return;
        }
        const target = event?.target as any;
        capturePassiveEvent('ui_click', target);
      };

      const onPassiveChange = (event: any) => {
        if ((!shouldTraining && !walkthroughPlan) || modalOpen) {
          return;
        }
        const target = event?.target as any;
        if (!target || !target.getAttribute) {
          return;
        }
        const inputType = String(target.getAttribute('type') || '').toLowerCase();
        if (inputType === 'password') {
          return;
        }
        const valueSample = typeof target.value === 'string' ? target.value : '';
        capturePassiveEvent('ui_input', target, valueSample);
      };

      const onClick = async (event: any) => {
        if (!active || modalOpen) return;
        const target = event?.target as any;
        if (!target || !root) return;
        if (root.contains(target)) return;
        event.preventDefault();
        event.stopPropagation();
        const walkthroughCurrent = getCurrentWalkthroughStep().step;
        const walkthroughLabelHint =
          walkthroughCurrent && walkthroughCurrent.kind === 'label'
            ? (walkthroughCurrent.suggested_label || normalizeWalkthroughId(walkthroughCurrent.id))
            : null;
        const defaultLabel = walkthroughLabelHint || elementLabel(target);
        const label = await promptForLabel(defaultLabel);
        if (!label) {
          return;
        }
        const selectorHint = normalizeSelectorHint(target);
        const item = {
          label,
          selector_hint: selectorHint,
          tag: (target.tagName || '').toLowerCase(),
          role: target.getAttribute('role') || null,
          type: target.getAttribute('type') || null,
          name: target.getAttribute('name') || null,
          placeholder: target.getAttribute('placeholder') || null,
          aria_label: target.getAttribute('aria-label') || null,
          text_sample: shortText(String(target.innerText || target.textContent || '')),
          url: ((win as { location?: { href?: string } }).location?.href) || null,
          created_at: new Date().toISOString()
        };
        if (walkthroughCurrent && walkthroughCurrent.kind === 'label') {
          item.label = walkthroughCurrent.suggested_label || normalizeWalkthroughId(walkthroughCurrent.id) || item.label;
        }
        const dedupeKey = `${item.label}::${item.selector_hint}`;
        const existingIndex = labels.findIndex((row) => {
          const key = `${String((row as { label?: unknown }).label || '')}::${String((row as { selector_hint?: unknown }).selector_hint || '')}`;
          return key === dedupeKey;
        });
        if (existingIndex >= 0) {
          labels[existingIndex] = item;
        } else {
          labels.push(item);
        }
        saveLabels(labels);
        pushActionEvent('label_saved', { label, selector_hint: selectorHint });
        setGlobal(active);
        render(active);
        mark(target);
        if (walkthroughCurrent && walkthroughCurrent.kind === 'label') {
          markWalkthroughStepDone(walkthroughCurrent, 'label_capture');
          setGlobal(active);
          render(active);
        }
        showToast({
          title: 'Label Saved',
          message: `${label} -> ${selectorHint}`,
          timeout_ms: 4200
        });
      };

      const onKey = (event: any) => {
        if (event.key === 'Escape' && active && !modalOpen) {
          active = false;
          setGlobal(active);
          render(active);
        }
      };

      const ensureListeners = () => {
        const winState = win as Record<string, unknown>;
        if (winState.__pinokioProbeOverlayListeners !== true) {
          doc.addEventListener('click', onClick, true);
          doc.addEventListener('keydown', onKey, true);
          winState.__pinokioProbeOverlayListeners = true;
        }
        if ((shouldTraining || walkthroughPlan) && winState.__pinokioProbeOverlayTrainingListeners !== true) {
          doc.addEventListener('click', onPassiveClick, true);
          doc.addEventListener('change', onPassiveChange, true);
          winState.__pinokioProbeOverlayTrainingListeners = true;
        }
      };

      render(active);
      setGlobal(active);
      ensureListeners();

      const rootEl = root as any;
      if (rootEl.dataset.pinokioBound !== '1') {
        rootEl.dataset.pinokioBound = '1';
        root.addEventListener('click', (event: any) => {
          const target = (event as any)?.target as any;
          if (!target) return;
          const action = target.getAttribute('data-pinokio-action');
          if (!action) return;
          event.preventDefault();
          if (action === 'walk_done') {
            const current = getCurrentWalkthroughStep().step;
            if (current && current.kind === 'action') {
              markWalkthroughStepDone(current, 'manual_done');
              setGlobal(active);
              render(active);
            }
            return;
          }
          if (action === 'train_junk') {
            setTrainingMark('junk');
            return;
          }
          if (action === 'train_keep') {
            setTrainingMark('keep');
            return;
          }
          if (action === 'train_mutate') {
            setTrainingMark('mutate');
            return;
          }
          if (action === 'toggle') {
            active = !active;
            pushActionEvent('label_mode_toggle', { active });
            setGlobal(active);
            render(active);
            return;
          }
          if (action === 'ready') {
            setReadyAck('panel_button');
            setGlobal(active);
            return;
          }
          if (action === 'copy') {
            const serialized = JSON.stringify(labels, null, 2);
            if (typeof nav?.clipboard?.writeText === 'function') {
              nav.clipboard.writeText(serialized).catch(() => undefined);
            }
            showToast({
              title: 'Copied',
              message: 'Saved labels copied to clipboard.',
              timeout_ms: 2600
            });
            return;
          }
          if (action === 'clear') {
            labels = [];
            saveLabels(labels);
            pushActionEvent('labels_cleared', {});
            setGlobal(active);
            render(active);
            return;
          }
        });
      }

      const stateForToast = win as Record<string, unknown>;
      const lastReadyToastAt = Number(stateForToast.__pinokioReadyToastAt || 0);
      if (!Number.isFinite(lastReadyToastAt) || Date.now() - lastReadyToastAt > 10000) {
        stateForToast.__pinokioReadyToastAt = Date.now();
        showToast({
          title: 'Automation Checkpoint',
          message: 'After login and navigation to the target page, click READY.',
          timeout_ms: 9000,
          buttons: [
            { id: 'ready', label: 'READY', variant: 'success', prompt: 'READY' }
          ]
        });
      }
      const trainingComplete =
        Boolean(trainingState.junk_done) &&
        Boolean(trainingState.keep_done) &&
        Boolean(trainingState.mutate_done);
      if (walkthroughPlan) {
        const current = getCurrentWalkthroughStep().step;
        if (current) {
          const lastWalkToastAt = Number(stateForToast.__pinokioWalkToastAt || 0);
          if (!Number.isFinite(lastWalkToastAt) || Date.now() - lastWalkToastAt > 12000) {
            stateForToast.__pinokioWalkToastAt = Date.now();
            showToast({
              title: `Walkthrough: ${current.title}`,
              message: current.instruction,
              timeout_ms: 11000
            });
          }
        }
      } else if (shouldTraining && !trainingComplete) {
        const lastTrainingToastAt = Number(stateForToast.__pinokioTrainingToastAt || 0);
        if (!Number.isFinite(lastTrainingToastAt) || Date.now() - lastTrainingToastAt > 12000) {
          stateForToast.__pinokioTrainingToastAt = Date.now();
          showToast({
            title: 'Training Mode',
            message:
              'Demonstrate one JUNK, one KEEP, and one DELETE/ARCHIVE example, mark each in the panel, then click READY.',
            timeout_ms: 11000
          });
        }
      }
    },
    {
      autoActivate,
      reset,
      trainingMode,
      walkthroughPlan
    }
  );
}

function normalizePathSegment(segment: string): string {
  const raw = String(segment || '').trim();
  if (!raw) {
    return raw;
  }
  if (/^\d+$/.test(raw)) {
    return ':id';
  }
  if (/^[0-9a-f]{24,}$/i.test(raw)) {
    return ':id';
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return ':id';
  }
  if (/^[A-Za-z0-9_-]{18,}$/.test(raw) && /\d/.test(raw)) {
    return ':token';
  }
  return raw;
}

function normalizePathTemplate(pathname: string): string {
  const parts = String(pathname || '/')
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => normalizePathSegment(part));
  return `/${parts.join('/')}`;
}

function buildNetworkSummary(events: NetworkEvent[], pageUrl: string): Record<string, unknown> {
  const baseUrl = parseUrl(pageUrl);
  const rows: Array<{
    origin: string;
    host: string;
    path_template: string;
    method: string;
    status: number | null;
    resource_type: string;
    query_keys: string[];
    same_origin: boolean;
    api_like: boolean;
  }> = [];

  for (const event of events) {
    const method = String(event.method || 'GET').toUpperCase();
    let parsed: URL | null = null;
    try {
      parsed = new URL(event.url);
    } catch {
      try {
        parsed = baseUrl ? new URL(event.url, baseUrl) : null;
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      continue;
    }
    const queryKeys = Array.from(parsed.searchParams.keys()).slice(0, 12);
    const pathTemplate = normalizePathTemplate(parsed.pathname || '/');
    const sameOrigin = Boolean(baseUrl && parsed.origin === baseUrl.origin);
    const resourceType = String(event.resource_type || '').toLowerCase();
    const apiLike =
      resourceType === 'xhr' ||
      resourceType === 'fetch' ||
      pathTemplate.includes('/api/') ||
      pathTemplate.startsWith('/api') ||
      pathTemplate.includes('/graphql') ||
      pathTemplate.includes('/rest/');
    rows.push({
      origin: parsed.origin,
      host: parsed.hostname,
      path_template: pathTemplate,
      method,
      status: event.status,
      resource_type: resourceType,
      query_keys: queryKeys,
      same_origin: sameOrigin,
      api_like: apiLike
    });
  }

  const grouped = new Map<string, {
    host: string;
    origin: string;
    path_template: string;
    count: number;
    methods: Set<string>;
    statuses: Set<string>;
    resource_types: Set<string>;
    query_keys: Set<string>;
    same_origin: boolean;
    api_like: boolean;
  }>();

  for (const row of rows) {
    const key = `${row.origin}|${row.path_template}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        host: row.host,
        origin: row.origin,
        path_template: row.path_template,
        count: 1,
        methods: new Set([row.method]),
        statuses: new Set([row.status === null ? 'null' : String(row.status)]),
        resource_types: new Set([row.resource_type || 'unknown']),
        query_keys: new Set(row.query_keys),
        same_origin: row.same_origin,
        api_like: row.api_like
      });
      continue;
    }
    existing.count += 1;
    existing.methods.add(row.method);
    existing.statuses.add(row.status === null ? 'null' : String(row.status));
    existing.resource_types.add(row.resource_type || 'unknown');
    row.query_keys.forEach((keyPart) => existing.query_keys.add(keyPart));
    existing.same_origin = existing.same_origin || row.same_origin;
    existing.api_like = existing.api_like || row.api_like;
  }

  const candidates = Array.from(grouped.values())
    .sort((a, b) => {
      const scoreA = (a.api_like ? 1000 : 0) + a.count + (a.same_origin ? 10 : 0);
      const scoreB = (b.api_like ? 1000 : 0) + b.count + (b.same_origin ? 10 : 0);
      return scoreB - scoreA;
    })
    .slice(0, 40)
    .map((entry) => ({
      host: entry.host,
      origin: entry.origin,
      path_template: entry.path_template,
      count: entry.count,
      same_origin: entry.same_origin,
      api_like: entry.api_like,
      methods: Array.from(entry.methods).sort(),
      statuses: Array.from(entry.statuses).sort(),
      resource_types: Array.from(entry.resource_types).sort(),
      query_keys: Array.from(entry.query_keys).sort().slice(0, 12)
    }));

  const topHosts = new Map<string, number>();
  for (const row of rows) {
    topHosts.set(row.host, (topHosts.get(row.host) || 0) + 1);
  }
  const domains = Array.from(topHosts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([host, count]) => ({ host, count }));

  return {
    total_events: rows.length,
    api_like_events: rows.filter((row) => row.api_like).length,
    unique_candidates: candidates.length,
    domains,
    candidates
  };
}

async function waitForUserCheckpoint(page: Page, payload: ServicePayload): Promise<UserCheckpointResult> {
  const awaitCheckpoint = toBool(payload.await_user_checkpoint, false);
  if (!awaitCheckpoint) {
    return {
      awaited: false,
      satisfied: true,
      expected_host: resolveExpectedHost(payload),
      final_url: safePageUrl(page),
      waited_ms: 0,
      reason: null
    };
  }

  const expectedHost = resolveExpectedHost(payload);
  const timeoutMs = toInt(payload.user_checkpoint_timeout_ms, 180000, 5000, 900000);
  const pollMs = Math.min(1500, Math.max(800, Math.floor(timeoutMs / 120)));
  const startedAt = Date.now();
  const stableSatisfiedMs = 5000;
  const reminderIntervalMs = 15000;
  const hostMismatchToastIntervalMs = 8000;
  let satisfiedSinceMs: number | null = null;
  let lastReminderAtMs = 0;
  let lastHostMismatchToastAtMs = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const nowMs = Date.now();
    if (page.isClosed()) {
      return {
        awaited: true,
        satisfied: false,
        expected_host: expectedHost,
        final_url: null,
        waited_ms: Date.now() - startedAt,
        reason: 'page_closed'
      };
    }
    const currentUrl = safePageUrl(page);
    const readySignal = await readOverlayReadySignal(page);
    if (readySignal.ready) {
      const signalHost =
        asOptionalString(readySignal.host) ||
        parseUrl(asOptionalString(readySignal.url))?.hostname ||
        parseUrl(currentUrl)?.hostname ||
        null;
      if (!expectedHost || (signalHost && hostMatchesExpected(signalHost, expectedHost))) {
        await clearOverlayReadySignal(page);
        return {
          awaited: true,
          satisfied: true,
          expected_host: expectedHost,
          final_url: asOptionalString(readySignal.url) || currentUrl,
          waited_ms: Date.now() - startedAt,
          reason: 'ready_button'
        };
      }
      await clearOverlayReadySignal(page);
      if (nowMs - lastHostMismatchToastAtMs >= hostMismatchToastIntervalMs) {
        const expectedHostLabel = expectedHost || 'target host';
        const observedHost = signalHost || parseUrl(currentUrl)?.hostname || 'unknown host';
        await pushOverlayToast(page, {
          title: 'Wrong Page For READY',
          message: `Expected ${expectedHostLabel} but READY was clicked on ${observedHost}. Navigate to the target page and click READY again.`,
          timeout_ms: 9000,
          buttons: [{ id: 'ready', label: 'READY', variant: 'success', prompt: 'READY' }]
        });
        lastHostMismatchToastAtMs = nowMs;
      }
    } else if (nowMs - startedAt >= 2500 && nowMs - lastReminderAtMs >= reminderIntervalMs) {
      await pushOverlayToast(page, {
        title: 'Waiting For READY',
        message: `After login and navigation to ${expectedHost || 'the target site'}, click READY in the panel.`,
        timeout_ms: 7000,
        buttons: [{ id: 'ready', label: 'READY', variant: 'success', prompt: 'READY' }]
      });
      lastReminderAtMs = nowMs;
    }
    if (checkpointSatisfiedByUrl(currentUrl, expectedHost)) {
      if (satisfiedSinceMs === null) {
        satisfiedSinceMs = nowMs;
      }
      if (nowMs - satisfiedSinceMs >= stableSatisfiedMs) {
        return {
          awaited: true,
          satisfied: true,
          expected_host: expectedHost,
          final_url: currentUrl,
          waited_ms: nowMs - startedAt,
          reason: null
        };
      }
    } else {
      satisfiedSinceMs = null;
    }
    await page.waitForTimeout(pollMs);
  }

  return {
    awaited: true,
    satisfied: false,
    expected_host: expectedHost,
    final_url: safePageUrl(page),
    waited_ms: Date.now() - startedAt,
    reason: 'timeout'
  };
}

function challengeSignals(title: string, bodySample: string, htmlSample: string): {
  detected: boolean;
  summary: string | null;
  signals: string[];
} {
  const corpus = `${title}\n${bodySample}\n${htmlSample}`.toLowerCase();
  const signals: string[] = [];
  const tests: Array<[RegExp, string]> = [
    [/\bcaptcha\b/, 'captcha'],
    [/\bcloudflare\b/, 'cloudflare'],
    [/\bverify you are human\b/, 'human-verification'],
    [/\bchecking your browser\b/, 'browser-check'],
    [/\bcf-challenge\b/, 'cf-challenge'],
    [/\baccess denied\b/, 'access-denied'],
    [/\bplease enable javascript\b/, 'enable-javascript']
  ];
  for (const [re, label] of tests) {
    if (re.test(corpus)) {
      signals.push(label);
    }
  }
  return {
    detected: signals.length > 0,
    summary: signals.length > 0 ? `detected ${signals.join(', ')}` : null,
    signals
  };
}

function normalizeActionStep(raw: unknown): BrowserActionStep | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const type = asOptionalString(row.type || row.op || row.action)?.toLowerCase();
  if (!type) {
    return null;
  }
  return {
    ...row,
    type
  } as BrowserActionStep;
}

async function performApiAttempt(
  page: Page,
  rawAttempt: ApiAttempt,
  timeoutMs: number,
  payload?: ServicePayload
): Promise<Record<string, unknown>> {
  const method = asOptionalString(rawAttempt.method)?.toUpperCase() || 'GET';
  const pageOrigin = (() => {
    const currentUrl = safePageUrl(page);
    if (!currentUrl) {
      return null;
    }
    try {
      return new URL(currentUrl).origin;
    } catch {
      return null;
    }
  })();
  const resolvedAttempt = resolveApiAttemptFromCandidates({
    attempt: rawAttempt as unknown as Record<string, unknown>,
    siteProfile:
      payload && payload.site_profile && typeof payload.site_profile === 'object'
        ? (payload.site_profile as SiteProfile)
        : null,
    fallbackOrigin: pageOrigin
  });
  const url = asOptionalString(rawAttempt.url) || resolvedAttempt.url;
  if (!url) {
    throw new Error('api attempt url is required (no candidate path could be resolved)');
  }
  const headers = rawAttempt.headers && typeof rawAttempt.headers === 'object' && !Array.isArray(rawAttempt.headers)
    ? Object.fromEntries(
      Object.entries(rawAttempt.headers).map(([k, v]) => [String(k), String(v)])
    )
    : {};

  const response = await page.evaluate(
    async (request) => {
      const body = request.body === undefined || request.body === null
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
      const res = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body
      });
      const text = await res.text();
      return {
        ok: true,
        status: res.status,
        status_text: res.statusText,
        body_text: text.slice(0, 120000),
        headers: Array.from(res.headers.entries())
      };
    },
    {
      url,
      method,
      headers,
      body: rawAttempt.body
    }
  );

  return {
    type: 'api_request',
    ok: true,
    request: { url, method },
    response,
    resolve_source: resolvedAttempt.source,
    resolve_confidence: resolvedAttempt.confidence,
    matched_candidate: resolvedAttempt.matched_candidate || null,
    timeout_ms: timeoutMs
  };
}

async function executeWithSelectorFallback<T>(params: {
  page: Page;
  step: BrowserActionStep;
  payload: ServicePayload;
  timeoutMs: number;
  execute: (selector: string) => Promise<T>;
}): Promise<{
  selectorUsed: string;
  result: T;
  attempts: Array<{
    selector: string;
    source: string;
    confidence: number;
    ok: boolean;
    error?: string;
  }>;
}> {
  const stack = buildSelectorFallbackStack({
    step: params.step as unknown as Record<string, unknown>,
    labelMap:
      params.payload.label_map && typeof params.payload.label_map === 'object'
        ? (params.payload.label_map as Record<string, string>)
        : null,
    siteProfile:
      params.payload.site_profile && typeof params.payload.site_profile === 'object'
        ? (params.payload.site_profile as SiteProfile)
        : null
  });
  const retryLimit = toInt(params.payload.selector_retry_limit, 4, 1, 16);
  const candidates = stack.length > 0
    ? stack.slice(0, retryLimit)
    : [{ selector: asOptionalString(params.step.selector) || '', source: 'explicit', confidence: 0.3 }];
  const attempts: Array<{
    selector: string;
    source: string;
    confidence: number;
    ok: boolean;
    error?: string;
  }> = [];
  let lastError: string | null = null;

  for (const candidate of candidates) {
    const selector = asOptionalString(candidate.selector);
    if (!selector) {
      continue;
    }
    try {
      const result = await params.execute(selector);
      attempts.push({
        selector,
        source: String(candidate.source || 'fallback'),
        confidence: Number.isFinite(Number(candidate.confidence))
          ? Number(candidate.confidence)
          : 0.1,
        ok: true
      });
      return {
        selectorUsed: selector,
        result,
        attempts
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lastError = detail;
      attempts.push({
        selector,
        source: String(candidate.source || 'fallback'),
        confidence: Number.isFinite(Number(candidate.confidence))
          ? Number(candidate.confidence)
          : 0.1,
        ok: false,
        error: detail
      });
    }
  }

  throw new Error(
    `selector fallback stack exhausted (${attempts.length} attempt(s)): ${lastError || 'unknown selector failure'}`
  );
}

async function runStep(
  page: Page,
  step: BrowserActionStep,
  allowUnsafe: boolean,
  defaultTimeoutMs: number,
  payload: ServicePayload
): Promise<Record<string, unknown>> {
  const type = String(step.type || '').trim().toLowerCase();
  const timeoutMs = toInt(step.timeout_ms, defaultTimeoutMs, 100, 300000);
  if (!type) {
    throw new Error('action step missing type');
  }

  if (type === 'goto' || type === 'navigate') {
    const url = asOptionalString(step.url);
    if (!url) {
      throw new Error('goto requires url');
    }
    const response = await page.goto(url, {
      waitUntil: normalizeWaitUntil(step.wait_until),
      timeout: timeoutMs
    });
    return {
      type: 'goto',
      ok: true,
      url: page.url(),
      status: response ? response.status() : null
    };
  }

  if (type === 'click') {
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        await page.locator(selector).first().click({ timeout: timeoutMs });
        return null;
      }
    });
    return {
      type: 'click',
      ok: true,
      selector: executed.selectorUsed,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'fill') {
    const value = asOptionalString(step.value) || asOptionalString(step.text) || '';
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        await page.locator(selector).first().fill(value, { timeout: timeoutMs });
        return null;
      }
    });
    return {
      type: 'fill',
      ok: true,
      selector: executed.selectorUsed,
      value_length: value.length,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'type') {
    const value = asOptionalString(step.value) || asOptionalString(step.text) || '';
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        await page.locator(selector).first().type(value, { timeout: timeoutMs });
        return null;
      }
    });
    return {
      type: 'type',
      ok: true,
      selector: executed.selectorUsed,
      value_length: value.length,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'press') {
    const key = asOptionalString(step.key) || 'Enter';
    const selector = asOptionalString(step.selector);
    if (selector) {
      await page.locator(selector).first().press(key, { timeout: timeoutMs });
    } else {
      await page.keyboard.press(key);
    }
    return { type: 'press', ok: true, selector: selector || null, key };
  }

  if (type === 'wait_for_selector' || type === 'wait') {
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        await page.waitForSelector(selector, { timeout: timeoutMs });
        return null;
      }
    });
    return {
      type: 'wait_for_selector',
      ok: true,
      selector: executed.selectorUsed,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'select_option') {
    const value = asOptionalString(step.value) || '';
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        await page.locator(selector).first().selectOption(value, { timeout: timeoutMs });
        return null;
      }
    });
    return {
      type: 'select_option',
      ok: true,
      selector: executed.selectorUsed,
      value,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'check' || type === 'uncheck') {
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        if (type === 'check') {
          await page.locator(selector).first().check({ timeout: timeoutMs });
        } else {
          await page.locator(selector).first().uncheck({ timeout: timeoutMs });
        }
        return null;
      }
    });
    return {
      type,
      ok: true,
      selector: executed.selectorUsed,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'hover') {
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) => {
        await page.locator(selector).first().hover({ timeout: timeoutMs });
        return null;
      }
    });
    return {
      type: 'hover',
      ok: true,
      selector: executed.selectorUsed,
      selector_attempts: executed.attempts
    };
  }

  if (type === 'extract_text') {
    const executed = await executeWithSelectorFallback({
      page,
      step,
      payload,
      timeoutMs,
      execute: async (selector) =>
        page.locator(selector).first().innerText({ timeout: timeoutMs })
    });
    return {
      type: 'extract_text',
      ok: true,
      selector: executed.selectorUsed,
      text: String(executed.result || '').slice(0, 120000),
      selector_attempts: executed.attempts
    };
  }

  if (type === 'screenshot') {
    const fullPage = toBool(step.full_page, false);
    const shot = await page.screenshot({ fullPage });
    return {
      type: 'screenshot',
      ok: true,
      full_page: fullPage,
      screenshot_base64: shot.toString('base64')
    };
  }

  if (type === 'api_request') {
    const attempt: ApiAttempt = {
      url: asOptionalString(step.url) || undefined,
      path_template: asOptionalString(step.path_template) || undefined,
      path: asOptionalString(step.path) || undefined,
      endpoint_key: asOptionalString(step.endpoint_key) || undefined,
      candidate_key: asOptionalString(step.candidate_key) || undefined,
      method: asOptionalString(step.method) || 'GET',
      headers:
        step.headers && typeof step.headers === 'object' && !Array.isArray(step.headers)
          ? step.headers
          : undefined,
      body: step.body
    };
    return performApiAttempt(page, attempt, timeoutMs, payload);
  }

  if (type === 'evaluate') {
    if (!allowUnsafe) {
      throw new Error('evaluate is only available in unsafe mode');
    }
    const expression = asOptionalString(step.expression);
    if (!expression) {
      throw new Error('evaluate requires expression');
    }
    const evalResult = await page.evaluate(
      ({ source, arg }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function('arg', source);
        return fn(arg);
      },
      {
        source: expression,
        arg: step.arg
      }
    );
    return { type: 'evaluate', ok: true, result: evalResult };
  }

  throw new Error(`unsupported step type '${type}'`);
}

async function collectDiscovery(
  page: Page,
  payload: ServicePayload,
  networkEvents: NetworkEvent[]
): Promise<Record<string, unknown>> {
  const withTransientContextRetry = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
      const isTransientContext =
        message.includes('execution context was destroyed') ||
        message.includes('most likely because of a navigation');
      if (!isTransientContext) {
        return fallback;
      }
      await page.waitForTimeout(250);
      try {
        return await fn();
      } catch {
        return fallback;
      }
    }
  };

  const timeoutMs = toInt(payload.timeout_ms, 45000, 1000, 300000);
  await page.waitForTimeout(Math.min(1200, Math.floor(timeoutMs / 10)));
  await page
    .waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 10000) })
    .catch(() => undefined);
  const title = await withTransientContextRetry(() => page.title(), '(unavailable)');
  const url = page.url();
  const html = await withTransientContextRetry(() => page.content(), '');
  const bodyText = await withTransientContextRetry(() => page.evaluate(() => {
    const browserGlobal = globalThis as unknown as Record<string, unknown>;
    const documentLike = browserGlobal.document as { body?: { innerText?: string } } | undefined;
    return String(documentLike?.body?.innerText || '').slice(0, 4000);
  }), '');
  const interactive = await withTransientContextRetry(() => page.evaluate(() => {
    const browserGlobal = globalThis as unknown as Record<string, unknown>;
    const documentLike = browserGlobal.document as
      | {
          querySelectorAll?: (selector: string) => unknown[];
        }
      | undefined;
    if (!documentLike || typeof documentLike.querySelectorAll !== 'function') {
      return {
        total: 0,
        buttons: 0,
        inputs: 0,
        links: 0,
        forms: 0,
        samples: {
          buttons: [],
          inputs: [],
          links: [],
          forms: []
        }
      };
    }
    const buttons = Array.from(
      documentLike.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')
    )
      .slice(0, 50)
      .map((el: unknown) => {
        const element = el as { textContent?: string; id?: string };
        return {
          text: String(element.textContent || '').trim().slice(0, 120),
          selector_hint: element.id ? `#${element.id}` : null
        };
      });
    const inputs = Array.from(documentLike.querySelectorAll('input,textarea,select'))
      .slice(0, 50)
      .map((el: unknown) => {
        const element = el as {
          getAttribute?: (name: string) => string | null;
          tagName?: string;
          id?: string;
        };
        return {
          name: String(element.getAttribute?.('name') || '').slice(0, 120),
          type: String(element.getAttribute?.('type') || element.tagName || '').toLowerCase(),
          selector_hint: element.id ? `#${element.id}` : null
        };
      });
    const links = Array.from(documentLike.querySelectorAll('a[href]'))
      .slice(0, 50)
      .map((el: unknown) => {
        const element = el as {
          textContent?: string;
          getAttribute?: (name: string) => string | null;
        };
        return {
          text: String(element.textContent || '').trim().slice(0, 120),
          href: String(element.getAttribute?.('href') || '').slice(0, 400)
        };
      });
    const forms = Array.from(documentLike.querySelectorAll('form'))
      .slice(0, 30)
      .map((el: unknown) => {
        const element = el as {
          getAttribute?: (name: string) => string | null;
        };
        return {
          action: String(element.getAttribute?.('action') || '').slice(0, 300),
          method: String(element.getAttribute?.('method') || 'get').toLowerCase()
        };
      });
    return {
      total: buttons.length + inputs.length + links.length + forms.length,
      buttons: buttons.length,
      inputs: inputs.length,
      links: links.length,
      forms: forms.length,
      samples: {
        buttons,
        inputs,
        links,
        forms
      }
    };
  }), {
    total: 0,
    buttons: 0,
    inputs: 0,
    links: 0,
    forms: 0,
    samples: {
      buttons: [],
      inputs: [],
      links: [],
      forms: []
    }
  });
  const probeLabels = await withTransientContextRetry(
    () =>
      page.evaluate(() => {
        const win = globalThis as unknown as Record<string, unknown>;
        const storageKey = 'pinokio_probe_labels_v1';
        const readyKey = 'pinokio_probe_ready_v1';
        const actionQueueKey = 'pinokio_probe_actions_v1';
        const trainingStateKey = 'pinokio_probe_training_v1';
        const walkthroughStateKey = 'pinokio_probe_walkthrough_v1';
        let labels: unknown[] = [];
        let readyAck: Record<string, unknown> | null = null;
        let actionEvents: unknown[] = [];
        let trainingState: Record<string, unknown> | null = null;
        let walkthroughState: Record<string, unknown> | null = null;
        try {
          const storage = (win as { localStorage?: { getItem?: (key: string) => string | null } }).localStorage;
          const raw = typeof storage?.getItem === 'function' ? (storage.getItem(storageKey) || '[]') : '[]';
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            labels = parsed;
          }
          const readyRaw = typeof storage?.getItem === 'function' ? storage.getItem(readyKey) : null;
          if (readyRaw) {
            const parsedReady = JSON.parse(readyRaw);
            if (parsedReady && typeof parsedReady === 'object' && !Array.isArray(parsedReady)) {
              readyAck = parsedReady as Record<string, unknown>;
            }
          }
          const actionRaw = typeof storage?.getItem === 'function' ? storage.getItem(actionQueueKey) : null;
          if (actionRaw) {
            const parsedActions = JSON.parse(actionRaw);
            if (Array.isArray(parsedActions)) {
              actionEvents = parsedActions;
            }
          }
          const trainingRaw = typeof storage?.getItem === 'function' ? storage.getItem(trainingStateKey) : null;
          if (trainingRaw) {
            const parsedTraining = JSON.parse(trainingRaw);
            if (parsedTraining && typeof parsedTraining === 'object' && !Array.isArray(parsedTraining)) {
              trainingState = parsedTraining as Record<string, unknown>;
            }
          }
          const walkthroughRaw = typeof storage?.getItem === 'function' ? storage.getItem(walkthroughStateKey) : null;
          if (walkthroughRaw) {
            const parsedWalkthrough = JSON.parse(walkthroughRaw);
            if (parsedWalkthrough && typeof parsedWalkthrough === 'object' && !Array.isArray(parsedWalkthrough)) {
              walkthroughState = parsedWalkthrough as Record<string, unknown>;
            }
          }
        } catch {
          labels = [];
          readyAck = null;
          actionEvents = [];
          trainingState = null;
          walkthroughState = null;
        }
        const overlay = win.__pinokioProbeOverlay as Record<string, unknown> | undefined;
        return {
          labels: Array.isArray(labels) ? labels.slice(0, 200) : [],
          overlay_active:
            overlay && typeof overlay === 'object'
              ? Boolean((overlay as { active?: unknown }).active)
              : false,
          ready_ack: readyAck,
          action_events: Array.isArray(actionEvents) ? actionEvents.slice(-40) : [],
          training_state: trainingState,
          walkthrough_state:
            walkthroughState && typeof walkthroughState === 'object'
              ? walkthroughState
              : (
                  overlay && typeof overlay === 'object' && (overlay as { walkthrough_state?: unknown }).walkthrough_state &&
                  typeof (overlay as { walkthrough_state?: unknown }).walkthrough_state === 'object' &&
                  !Array.isArray((overlay as { walkthrough_state?: unknown }).walkthrough_state)
                    ? (overlay as { walkthrough_state?: Record<string, unknown> }).walkthrough_state || null
                    : null
                )
        };
      }),
    { labels: [], overlay_active: false, ready_ack: null, action_events: [], training_state: null, walkthrough_state: null }
  );
  const networkSummary = buildNetworkSummary(networkEvents, page.url());
  const challenge = challengeSignals(title, bodyText, html.slice(0, 6000));
  const captureScreenshot = toBool(payload.capture_screenshot, true);
  const screenshotBase64 = captureScreenshot
    ? (await page.screenshot({ fullPage: false })).toString('base64')
    : null;
  return {
    ok: true,
    title,
    url,
    body_text_sample: bodyText,
    html_sample: html.slice(0, 4000),
    interactive,
    challenge,
    network_events: networkEvents,
    network_summary: networkSummary,
    probe_labels: probeLabels.labels,
    probe_overlay_active: Boolean(probeLabels.overlay_active),
    probe_ready_ack:
      probeLabels.ready_ack && typeof probeLabels.ready_ack === 'object'
        ? probeLabels.ready_ack
        : null,
    probe_action_events: Array.isArray(probeLabels.action_events)
      ? probeLabels.action_events
      : [],
    probe_training_state:
      probeLabels.training_state && typeof probeLabels.training_state === 'object'
        ? probeLabels.training_state
        : null,
    probe_walkthrough_state:
      probeLabels.walkthrough_state && typeof probeLabels.walkthrough_state === 'object'
        ? probeLabels.walkthrough_state
        : null,
    screenshot_base64: screenshotBase64
  };
}

async function runDiscover(payload: ServicePayload): Promise<Record<string, unknown>> {
  const session = await createSession(payload);
  const maxNetworkEvents = toInt(payload.max_network_events, 40, 1, 300);
  const keepOpenAfterDiscoveryMs = toInt(payload.keep_open_after_discovery_ms, 0, 0, 300000);
  const networkEvents: NetworkEvent[] = [];
  const onResponse = (response: Awaited<ReturnType<Page['waitForResponse']>>) => {
    if (networkEvents.length >= maxNetworkEvents) {
      return;
    }
    const req = response.request();
    networkEvents.push({
      url: response.url(),
      method: req.method(),
      status: response.status(),
      resource_type: req.resourceType(),
      timestamp: new Date().toISOString()
    });
  };

  session.page.on('response', onResponse);
  try {
    await ensureNavigation(session.page, payload);
    await installProbeOverlay(session.page, payload).catch(() => undefined);
    const checkpoint = await waitForUserCheckpoint(session.page, payload);
    if (checkpoint.reason === 'page_closed') {
      const networkSummary = buildNetworkSummary(networkEvents, checkpoint.final_url || '');
      const pageClosedResult = {
        ok: true,
        title: '(browser closed)',
        url: checkpoint.final_url || '',
        body_text_sample: '',
        html_sample: '',
        interactive: {
          total: 0,
          buttons: 0,
          inputs: 0,
          links: 0,
          forms: 0,
          samples: {
            buttons: [],
            inputs: [],
            links: [],
            forms: []
          }
        },
        challenge: {
          detected: false,
          summary: null,
          signals: []
        },
        workflow_state: 'human_required',
        mode_hint: 'human_required',
        pending_step: 'Browser window was closed before probe/checkpoint finished. Re-open and click READY.',
        network_events: networkEvents,
        network_summary: networkSummary,
        probe_labels: [],
        probe_overlay_active: false,
        probe_ready_ack: null,
        probe_action_events: [],
        probe_training_state: null,
        probe_walkthrough_state: null,
        screenshot_base64: null,
        user_checkpoint: checkpoint,
        used_headful: !session.headless,
        use_user_context: session.userContext,
        stealth: {
          plugin: session.usedStealthPlugin,
          hardening: session.usedStealthHardening
        }
      };
      writeBackgroundResultIfNeeded(payload, pageClosedResult);
      return pageClosedResult;
    }
    await installProbeOverlay(session.page, payload).catch(() => undefined);
    const discovery = await collectDiscovery(session.page, payload, networkEvents);
    const result = {
      ...discovery,
      workflow_state: toBool((discovery.challenge as Record<string, unknown> | undefined)?.detected, false)
        ? 'challenge_detected'
        : checkpoint.awaited && !checkpoint.satisfied
          ? 'human_required'
          : 'probing',
      mode_hint: toBool((discovery.challenge as Record<string, unknown> | undefined)?.detected, false)
        ? 'challenge_detected'
        : 'discover',
      pending_step:
        checkpoint.awaited && !checkpoint.satisfied
          ? 'Complete required browser checkpoint and click READY.'
          : null,
      user_checkpoint: checkpoint,
      used_headful: !session.headless,
      use_user_context: session.userContext,
      stealth: {
        plugin: session.usedStealthPlugin,
        hardening: session.usedStealthHardening
      }
    };
    writeBackgroundResultIfNeeded(payload, result);
    if (!session.headless && session.userContext && checkpoint.awaited && checkpoint.satisfied) {
      if (keepOpenAfterDiscoveryMs > 0) {
        const seconds = Math.max(1, Math.round(keepOpenAfterDiscoveryMs / 1000));
        await pushOverlayToast(session.page, {
          title: 'Discovery Captured',
          message: `Probe data was captured. This browser stays open for about ${seconds}s, then closes automatically.`,
          timeout_ms: Math.min(12000, Math.max(4000, keepOpenAfterDiscoveryMs))
        });
      } else {
        await pushOverlayToast(session.page, {
          title: 'Discovery Captured',
          message: 'Probe data was captured. This browser session will now close.',
          timeout_ms: 2200
        });
        await sleep(1100);
      }
    }
    if (
      keepOpenAfterDiscoveryMs > 0 &&
      !session.headless &&
      session.userContext &&
      checkpoint.awaited &&
      checkpoint.satisfied
    ) {
      await sleep(keepOpenAfterDiscoveryMs);
    }
    return result;
  } finally {
    session.page.off('response', onResponse);
    await session.close();
  }
}

async function runTitle(payload: ServicePayload): Promise<Record<string, unknown>> {
  const url = asOptionalString(payload.url);
  if (!url) {
    throw new Error('payload.url must be a non-empty string');
  }
  const session = await createSession({
    ...payload,
    action: 'read_title',
    capture_screenshot: false
  });
  try {
    await ensureNavigation(session.page, payload);
    const title = await session.page.title();
    return {
      ok: true,
      title,
      url: session.page.url(),
      used_headful: !session.headless
    };
  } finally {
    await session.close();
  }
}

async function runActions(payload: ServicePayload): Promise<Record<string, unknown>> {
  const session = await createSession(payload);
  const timeoutMs = toInt(payload.timeout_ms, 60000, 1000, 300000);
  const maxNetworkEvents = toInt(payload.max_network_events, 60, 1, 500);
  const allowUnsafe = toBool(payload.allow_unsafe, false);
  const networkEvents: NetworkEvent[] = [];

  const onResponse = (response: Awaited<ReturnType<Page['waitForResponse']>>) => {
    if (networkEvents.length >= maxNetworkEvents) {
      return;
    }
    const req = response.request();
    networkEvents.push({
      url: response.url(),
      method: req.method(),
      status: response.status(),
      resource_type: req.resourceType(),
      timestamp: new Date().toISOString()
    });
  };
  session.page.on('response', onResponse);

  const actionResults: Record<string, unknown>[] = [];
  const apiResults: Record<string, unknown>[] = [];
  try {
    await ensureNavigation(session.page, payload);

    const apiAttempts = Array.isArray(payload.api_attempts) ? payload.api_attempts : [];
    for (let i = 0; i < apiAttempts.length; i += 1) {
      const rawAttempt = apiAttempts[i];
      try {
        const result = await performApiAttempt(session.page, rawAttempt, timeoutMs, payload);
        apiResults.push({ index: i, ...result });
      } catch (error) {
        apiResults.push({
          index: i,
          type: 'api_request',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const rawSteps = Array.isArray(payload.actions) ? payload.actions : [];
    for (let i = 0; i < rawSteps.length; i += 1) {
      const normalized = normalizeActionStep(rawSteps[i]);
      if (!normalized) {
        actionResults.push({
          index: i,
          ok: false,
          error: 'invalid action step'
        });
        continue;
      }
      try {
        const result = await runStep(session.page, normalized, allowUnsafe, timeoutMs, payload);
        actionResults.push({
          index: i,
          ...result
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actionResults.push({
          index: i,
          type: normalized.type,
          ok: false,
          error: message
        });
        if (!toBool(normalized.continue_on_error, false)) {
          throw new Error(`action step ${i} failed: ${message}`);
        }
      }
    }

    const title = await session.page.title();
    const finalUrl = session.page.url();
    const html = await session.page.content();
    const bodyText = await session.page.evaluate(() => {
      const browserGlobal = globalThis as unknown as Record<string, unknown>;
      const documentLike = browserGlobal.document as { body?: { innerText?: string } } | undefined;
      return String(documentLike?.body?.innerText || '').slice(0, 4000);
    });
    const challenge = challengeSignals(title, bodyText, html.slice(0, 6000));
    const networkSummary = buildNetworkSummary(networkEvents, finalUrl);
    const captureScreenshot = toBool(payload.capture_screenshot, true);
    const screenshotBase64 = captureScreenshot
      ? (await session.page.screenshot({ fullPage: false })).toString('base64')
      : null;

    return {
      ok: true,
      url: finalUrl,
      title,
      workflow_state: challenge.detected ? 'challenge_detected' : 'executing',
      mode_hint: challenge.detected ? 'challenge_detected' : 'execute',
      pending_step: challenge.detected
        ? 'Anti-bot challenge detected during execution. Complete verification and retry a pilot action.'
        : null,
      action_results: actionResults,
      api_results: apiResults,
      challenge,
      network_events: networkEvents,
      network_summary: networkSummary,
      screenshot_base64: screenshotBase64,
      used_headful: !session.headless,
      use_user_context: session.userContext,
      stealth: {
        plugin: session.usedStealthPlugin,
        hardening: session.usedStealthHardening
      }
    };
  } finally {
    session.page.off('response', onResponse);
    await session.close();
  }
}

async function main(): Promise<void> {
  const payload = await readInput();
  if (payload.action === 'read_title') {
    const result = await withChromiumInstallRetry(payload, () => runTitle(payload));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (payload.action === 'discover') {
    const shouldUseBackgroundKeepOpen =
      !toBool(payload._background_worker, false) &&
      toBool(payload.non_blocking_keep_open, false) &&
      toInt(payload.keep_open_after_discovery_ms, 0, 0, 300000) > 0;
    const result = shouldUseBackgroundKeepOpen
      ? await runDiscoverNonBlocking(payload)
      : await withChromiumInstallRetry(payload, () => runDiscover(payload));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  if (payload.action === 'run_actions') {
    const result = await withChromiumInstallRetry(payload, () => runActions(payload));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  throw new Error(`unsupported action ${String(payload.action)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  const backgroundErrorPath = asOptionalString(process.env.PINOKIO_PLAYWRIGHT_BACKGROUND_ERROR_PATH);
  if (backgroundErrorPath) {
    try {
      fs.mkdirSync(path.dirname(backgroundErrorPath), { recursive: true });
      fs.writeFileSync(
        backgroundErrorPath,
        JSON.stringify({ error: message, at: new Date().toISOString() }),
        'utf8'
      );
    } catch {
      // Best-effort handoff for background mode errors.
    }
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
