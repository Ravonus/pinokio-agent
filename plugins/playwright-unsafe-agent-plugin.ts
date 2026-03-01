import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  parseActionSteps,
  parseApiAttempts,
  parseTargetMeta,
  resolvePlaywrightExecutionPolicy,
  runPlaywrightService,
  toBool,
  toInt
} from './playwright-common.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

function unsafeEnabled(): boolean {
  return toBool(process.env.PINOKIO_PLAYWRIGHT_UNSAFE_ENABLED, false);
}

function normalizeAction(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  const action = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`playwright_unsafe_agent does not support action '${action}'`);
  }
  if (!unsafeEnabled()) {
    fail(
      'unsafe browser mode is disabled. set PINOKIO_PLAYWRIGHT_UNSAFE_ENABLED=1 and enable unsafe plugin permissions before using plugin:playwright_unsafe_agent'
    );
  }

  const targetMeta = parseTargetMeta(request.target);
  const desiredAction = normalizeAction(targetMeta.desired_action || action || 'read');
  const timeoutMs = toInt(targetMeta.timeout_ms, 120000, 1000, 600000);
  const url = asOptionalString(targetMeta.url);
  const useStealth = toBool(targetMeta.use_stealth, true);
  const policy = resolvePlaywrightExecutionPolicy({
    targetMeta,
    url,
    message: asOptionalString(request.summary) || asOptionalString(targetMeta.task_summary)
  });
  const useUserContext = policy.useUserContext;
  const headless = policy.headless;
  const autoInstallChromium = toBool(targetMeta.auto_install_chromium, true);
  const autoInstallDeps = toBool(targetMeta.auto_install_deps, true);
  const installCommand = asOptionalString(targetMeta.install_command);
  const installDepsCommand = asOptionalString(targetMeta.install_deps_command);
  const serviceTimeoutMs = timeoutMs + (autoInstallChromium || autoInstallDeps ? 900000 : 20000);
  const explicitUserDataDir = asOptionalString(targetMeta.user_data_dir);
  const userDataDir =
    useUserContext
      ? explicitUserDataDir || policy.userDataDir
      : null;
  const actionSteps = parseActionSteps(targetMeta.actions);
  const apiAttempts = parseApiAttempts(targetMeta.api_attempts);
  const mode = normalizeAction(targetMeta.mode || '');

  if ((mode === 'discover' || desiredAction === 'read') && actionSteps.length === 0 && apiAttempts.length === 0) {
    const discovery = runPlaywrightService(
      {
        action: 'discover',
        url: url || undefined,
        prompt: asOptionalString(request.summary) || undefined,
        timeout_ms: timeoutMs,
        headless,
        use_stealth: useStealth,
        use_user_context: useUserContext,
        user_data_dir: userDataDir || undefined,
        storage_state_path: asOptionalString(targetMeta.storage_state_path) || undefined,
        capture_screenshot: toBool(targetMeta.capture_screenshot, true),
        max_network_events: toInt(targetMeta.max_network_events, 80, 1, 400),
        allow_unsafe: true,
        auto_install_chromium: autoInstallChromium,
        auto_install_deps: autoInstallDeps,
        install_command: installCommand || undefined,
        install_deps_command: installDepsCommand || undefined
      },
      serviceTimeoutMs
    );
    respond({
      ok: true,
      plugin: 'playwright_unsafe_agent',
      mode: 'unsafe_discover',
      desired_action: desiredAction,
      discovery,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      chat_response: 'Unsafe browser discovery completed.'
    });
    process.exit(0);
  }

  const result = runPlaywrightService(
    {
      action: 'run_actions',
      url: url || undefined,
      timeout_ms: timeoutMs,
      headless,
      use_stealth: useStealth,
      use_user_context: useUserContext,
      user_data_dir: userDataDir || undefined,
      storage_state_path: asOptionalString(targetMeta.storage_state_path) || undefined,
      capture_screenshot: toBool(targetMeta.capture_screenshot, true),
      actions: actionSteps,
      api_attempts: apiAttempts,
      allow_unsafe: true,
      auto_install_chromium: autoInstallChromium,
      auto_install_deps: autoInstallDeps,
      install_command: installCommand || undefined,
      install_deps_command: installDepsCommand || undefined
    },
    serviceTimeoutMs
  );

  respond({
    ok: true,
    plugin: 'playwright_unsafe_agent',
    mode: 'unsafe_execute',
    desired_action: desiredAction,
    result,
    policy: {
      use_user_context: useUserContext,
      inferred_authenticated_task: policy.inferredAuthenticatedTask,
      container_fallback_non_auth: policy.containerFallbackNonAuth,
      allowlisted_domain: policy.allowlistedDomain,
      permission_granted: policy.permissionGranted,
      reason: policy.reason
    },
    chat_response: 'Unsafe browser execution completed.'
  });
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
