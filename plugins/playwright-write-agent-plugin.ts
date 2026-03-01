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
import {
  mapPluginModeToWorkflowTelemetry
} from './playwright-runtime-utils.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'update', 'delete', 'read']);

function normalizeAction(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function buildUiBlocks(result: Record<string, unknown>, action: string): Record<string, unknown>[] {
  const title = asOptionalString(result.title) || '(untitled)';
  const url = asOptionalString(result.url) || '(unknown)';
  const challenge = result.challenge && typeof result.challenge === 'object' && !Array.isArray(result.challenge)
    ? result.challenge as Record<string, unknown>
    : null;
  const challengeDetected = challenge ? toBool(challenge.detected, false) : false;
  const actionResults = Array.isArray(result.action_results) ? result.action_results : [];
  const apiResults = Array.isArray(result.api_results) ? result.api_results : [];
  return [
    {
      type: 'playwright_execution',
      title: title,
      subtitle: `Browser ${action} execution`,
      items: [
        { label: 'URL', value: url },
        { label: 'Executed Actions', value: String(actionResults.length) },
        { label: 'API Attempts', value: String(apiResults.length) },
        { label: 'Bot Protection', value: challengeDetected ? 'Detected' : 'Not detected' }
      ],
      status: challengeDetected ? 'warning' : 'ok'
    }
  ];
}

function summarizeExecution(result: Record<string, unknown>, requestedAction: string): string {
  const url = asOptionalString(result.url) || '(unknown)';
  const actionResults = Array.isArray(result.action_results) ? result.action_results : [];
  const apiResults = Array.isArray(result.api_results) ? result.api_results : [];
  const challenge = result.challenge && typeof result.challenge === 'object' && !Array.isArray(result.challenge)
    ? result.challenge as Record<string, unknown>
    : null;
  const challengeSummary = challenge ? asOptionalString(challenge.summary) : null;
  const mode = toBool(result.used_headful, false) ? 'headful' : 'headless';
  const base = `Playwright ${requestedAction} executed on ${url} (${actionResults.length} UI step(s), ${apiResults.length} API attempt(s), ${mode}).`;
  return challengeSummary ? `${base} Bot-check note: ${challengeSummary}` : base;
}

function normalizeLabelMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    const selector = asOptionalString(raw);
    if (!normalizedKey || !selector) {
      continue;
    }
    out[normalizedKey] = selector;
  }
  return out;
}

function requiredLabelKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => item.length > 0)
    .slice(0, 32);
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  const requestAction = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(requestAction)) {
    fail(`playwright_write_agent does not support action '${requestAction}'`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const desiredAction = normalizeAction(targetMeta.desired_action || requestAction || 'update');
  const url = asOptionalString(targetMeta.url);
  const timeoutMs = toInt(targetMeta.timeout_ms, 60000, 1000, 300000);
  const actionSteps = parseActionSteps(targetMeta.actions);
  const apiAttempts = parseApiAttempts(targetMeta.api_attempts);
  const requiredLabels = requiredLabelKeys(targetMeta.required_label_keys);
  const labelMap = normalizeLabelMap(targetMeta.label_map);
  const siteProfile =
    targetMeta.site_profile && typeof targetMeta.site_profile === 'object' && !Array.isArray(targetMeta.site_profile)
      ? (targetMeta.site_profile as Record<string, unknown>)
      : null;
  const siteCandidates = siteProfile && Array.isArray(siteProfile.network_candidates)
    ? siteProfile.network_candidates
    : [];
  const preferNetworkFirst = toBool(targetMeta.prefer_network_first, true);
  const requirePilotFirst = toBool(targetMeta.require_pilot_first, true);
  const cleanupIntent = toBool(targetMeta.cleanup_intent, false);
  const pilotApproved =
    toBool(targetMeta.pilot_approved, false) ||
    toBool(targetMeta.cleanup_execution_approved, false) ||
    toBool(targetMeta.allow_bulk_cleanup, false);
  const useStealth = toBool(targetMeta.use_stealth, true);
  const policy = resolvePlaywrightExecutionPolicy({
    targetMeta,
    url,
    message: asOptionalString(request.summary) || asOptionalString(targetMeta.task_summary)
  });
  const useUserContext = policy.useUserContext;
  const channel = asOptionalString(targetMeta.channel) || 'default';
  const responseFormat = asOptionalString(targetMeta.response_format) || 'text';
  const headless = policy.headless;
  const allowUnsafe = toBool(targetMeta.allow_unsafe, false);
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

  if (actionSteps.length === 0 && apiAttempts.length === 0) {
    fail('playwright write requires at least one action or api_attempt');
  }
  if (
    requirePilotFirst &&
    (desiredAction === 'delete' || cleanupIntent) &&
    !pilotApproved
  ) {
    fail('pilot-first guardrail: explicit pilot approval is required before delete/cleanup writes');
  }
  if (
    preferNetworkFirst &&
    actionSteps.length > 0 &&
    apiAttempts.length === 0 &&
    siteCandidates.length === 0
  ) {
    fail('network-first guardrail: no API candidates available; run discovery/SHOW CANDIDATES first');
  }
  const missingLabels = requiredLabels.filter((key) => !labelMap[key]);
  if (missingLabels.length > 0) {
    fail(`label guardrail: missing required labels (${missingLabels.join(', ')})`);
  }

  let result = runPlaywrightService(
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
      allow_unsafe: allowUnsafe,
      auto_install_chromium: autoInstallChromium,
      auto_install_deps: autoInstallDeps,
      install_command: installCommand || undefined,
      install_deps_command: installDepsCommand || undefined,
      site_profile: siteProfile || undefined,
      label_map: labelMap,
      selector_retry_limit: toInt(targetMeta.selector_retry_limit, 4, 1, 16)
    },
    serviceTimeoutMs
  );

  const challenge =
    result.challenge && typeof result.challenge === 'object' && !Array.isArray(result.challenge)
      ? (result.challenge as Record<string, unknown>)
      : null;
  const retryHeadful = toBool(targetMeta.auto_retry_headful, true);
  if (
    retryHeadful &&
    challenge &&
    toBool(challenge.detected, false) &&
    !toBool(result.used_headful, false)
  ) {
    result = runPlaywrightService(
      {
        action: 'run_actions',
        url: url || undefined,
        timeout_ms: timeoutMs,
        headless: false,
        use_stealth: useStealth,
        use_user_context: true,
        user_data_dir: userDataDir || undefined,
        storage_state_path: asOptionalString(targetMeta.storage_state_path) || undefined,
        capture_screenshot: true,
        actions: actionSteps,
        api_attempts: apiAttempts,
        allow_unsafe: allowUnsafe,
        auto_install_chromium: autoInstallChromium,
        auto_install_deps: autoInstallDeps,
        install_command: installCommand || undefined,
        install_deps_command: installDepsCommand || undefined,
        site_profile: siteProfile || undefined,
        label_map: labelMap,
        selector_retry_limit: toInt(targetMeta.selector_retry_limit, 4, 1, 16)
      },
      serviceTimeoutMs
    );
  }

  const mode = toBool((result.challenge as Record<string, unknown> | undefined)?.detected, false)
    ? 'challenge_detected'
    : 'execute';
  const telemetry = mapPluginModeToWorkflowTelemetry({
    mode,
    challengeDetected: toBool((result.challenge as Record<string, unknown> | undefined)?.detected, false),
    needsUserStep:
      toBool((result.challenge as Record<string, unknown> | undefined)?.detected, false)
        ? 'Complete challenge/captcha in automation browser, then retry pilot action.'
        : null,
    lastError: null
  });

  const uiBlocks = responseFormat === 'ui_blocks' || channel.includes('ui')
    ? buildUiBlocks(result, desiredAction || requestAction)
    : [];
  respond({
    ok: true,
    plugin: 'playwright_write_agent',
    mode,
    desired_action: desiredAction || requestAction,
    chat_response: summarizeExecution(result, desiredAction || requestAction),
    result,
    workflow_telemetry: telemetry,
    policy: {
      use_user_context: useUserContext,
      inferred_authenticated_task: policy.inferredAuthenticatedTask,
      container_fallback_non_auth: policy.containerFallbackNonAuth,
      allowlisted_domain: policy.allowlistedDomain,
      permission_granted: policy.permissionGranted,
      reason: policy.reason
    },
    ui_blocks: uiBlocks,
    action_count: actionSteps.length,
    api_attempt_count: apiAttempts.length
  });
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
