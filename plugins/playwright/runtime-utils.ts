export type BrowserWorkflowState =
  | 'idle'
  | 'needs_ready'
  | 'probing'
  | 'needs_policy'
  | 'needs_pilot_approval'
  | 'needs_user_step'
  | 'executing'
  | 'challenge_detected'
  | 'human_required';

export interface WorkflowTelemetry {
  state: BrowserWorkflowState;
  pending_step: string | null;
  last_transition: string;
  last_error: string | null;
}

export interface SiteProfileLabel {
  label: string;
  selector_hint: string;
  role?: string | null;
  type?: string | null;
  name?: string | null;
  aria_label?: string | null;
  placeholder?: string | null;
  text_sample?: string | null;
  updated_at: string;
}

export interface SiteProfileNetworkCandidate {
  origin: string;
  path_template: string;
  methods: string[];
  api_like: boolean;
  same_origin: boolean;
  count: number;
  updated_at: string;
}

export interface SiteProfile {
  host: string;
  updated_at: string;
  last_success_at?: string | null;
  labels: SiteProfileLabel[];
  label_map: Record<string, string>;
  network_candidates: SiteProfileNetworkCandidate[];
}

export interface SelectorCandidate {
  selector: string;
  source: 'explicit' | 'label_key' | 'role_text' | 'attribute';
  confidence: number;
  label_key?: string;
}

export interface GuardrailInput {
  mutate: boolean;
  desiredAction: string;
  preferNetworkFirst: boolean;
  cleanupIntent: boolean;
  pilotApproved: boolean;
  labels: Array<Record<string, unknown>>;
  requiredLabelKeys: string[];
  networkCandidates: Array<Record<string, unknown>>;
  actionsCount: number;
  apiAttemptsCount: number;
}

export interface GuardrailResult {
  ok: boolean;
  issues: string[];
  missingLabelKeys: string[];
  missingNetworkCandidates: boolean;
  pilotRequired: boolean;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cssEscapeValue(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}

export function mapPluginModeToWorkflowTelemetry(input: {
  mode: string | null;
  challengeDetected?: boolean;
  needsUserStep?: string | null;
  lastError?: string | null;
}): WorkflowTelemetry {
  const mode = String(input.mode || '').trim().toLowerCase();
  const challengeDetected = Boolean(input.challengeDetected);
  const needsUserStep = asOptionalString(input.needsUserStep);
  const lastError = asOptionalString(input.lastError);

  if (mode === 'read_then_write') {
    return {
      state: 'executing',
      pending_step: null,
      last_transition: 'mode:read_then_write',
      last_error: lastError
    };
  }
  if (mode === 'discover') {
    return {
      state: challengeDetected ? 'challenge_detected' : 'probing',
      pending_step: challengeDetected
        ? 'Complete the anti-bot/captcha checkpoint in automation browser, then click READY.'
        : null,
      last_transition: challengeDetected ? 'mode:discover->challenge_detected' : 'mode:discover',
      last_error: lastError
    };
  }
  if (mode === 'discovery_needs_user') {
    if (challengeDetected) {
      return {
        state: 'challenge_detected',
        pending_step:
          needsUserStep ||
          'Challenge detected. Complete the human verification in the automation browser and click READY.',
        last_transition: 'mode:discovery_needs_user->challenge_detected',
        last_error: lastError
      };
    }
    return {
      state: 'human_required',
      pending_step:
        needsUserStep ||
        'User action is required in the automation browser before continuing.',
      last_transition: 'mode:discovery_needs_user->human_required',
      last_error: lastError
    };
  }
  if (mode === 'execute') {
    return {
      state: challengeDetected ? 'challenge_detected' : 'executing',
      pending_step: challengeDetected
        ? 'Action run hit anti-bot controls. Complete verification and retry pilot.'
        : null,
      last_transition: challengeDetected ? 'mode:execute->challenge_detected' : 'mode:execute',
      last_error: lastError
    };
  }
  if (mode === 'plan_only') {
    return {
      state: 'probing',
      pending_step: needsUserStep,
      last_transition: 'mode:plan_only',
      last_error: lastError
    };
  }
  if (mode === 'challenge_detected') {
    return {
      state: 'challenge_detected',
      pending_step:
        needsUserStep ||
        'Challenge detected. Complete the human verification in browser, then click READY.',
      last_transition: 'mode:challenge_detected',
      last_error: lastError
    };
  }
  if (mode === 'human_required') {
    return {
      state: 'human_required',
      pending_step: needsUserStep || 'User interaction required.',
      last_transition: 'mode:human_required',
      last_error: lastError
    };
  }
  return {
    state: 'idle',
    pending_step: null,
    last_transition: mode ? `mode:${mode}` : 'mode:unknown',
    last_error: lastError
  };
}

export function extractSiteProfileLabels(labels: Array<Record<string, unknown>>): SiteProfileLabel[] {
  const now = new Date().toISOString();
  const out: SiteProfileLabel[] = [];
  const dedupe = new Set<string>();
  for (const row of labels) {
    const label = normalizeToken(asOptionalString(row.label) || '');
    const selectorHint = asOptionalString(row.selector_hint);
    if (!label || !selectorHint) {
      continue;
    }
    const key = `${label}::${selectorHint}`;
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    out.push({
      label,
      selector_hint: selectorHint,
      role: asOptionalString(row.role),
      type: asOptionalString(row.type),
      name: asOptionalString(row.name),
      aria_label: asOptionalString(row.aria_label),
      placeholder: asOptionalString(row.placeholder),
      text_sample: asOptionalString(row.text_sample),
      updated_at: now
    });
  }
  return out.slice(0, 400);
}

export function extractSiteProfileNetworkCandidates(
  candidates: Array<Record<string, unknown>>
): SiteProfileNetworkCandidate[] {
  const now = new Date().toISOString();
  const out: SiteProfileNetworkCandidate[] = [];
  const dedupe = new Set<string>();
  for (const row of candidates) {
    const origin = asOptionalString(row.origin);
    const pathTemplate = asOptionalString(row.path_template);
    if (!origin || !pathTemplate) {
      continue;
    }
    const methods = Array.isArray(row.methods)
      ? row.methods.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean).slice(0, 8)
      : [];
    const dedupeKey = `${origin}|${pathTemplate}`;
    if (dedupe.has(dedupeKey)) {
      continue;
    }
    dedupe.add(dedupeKey);
    out.push({
      origin,
      path_template: pathTemplate,
      methods,
      api_like: Boolean(row.api_like),
      same_origin: Boolean(row.same_origin),
      count: Number.isFinite(Number(row.count)) ? Math.max(0, Math.trunc(Number(row.count))) : 0,
      updated_at: now
    });
  }
  return out.slice(0, 200);
}

export function mergeSiteProfile(
  host: string,
  existing: SiteProfile | null,
  patch: {
    labels?: SiteProfileLabel[];
    network_candidates?: SiteProfileNetworkCandidate[];
    mark_success?: boolean;
  }
): SiteProfile {
  const normalizedHost = normalizeToken(host);
  const now = new Date().toISOString();
  const base: SiteProfile = existing || {
    host: normalizedHost,
    updated_at: now,
    last_success_at: null,
    labels: [],
    label_map: {},
    network_candidates: []
  };
  const nextLabels = (patch.labels && patch.labels.length > 0 ? patch.labels : base.labels).slice(0, 400);
  const nextLabelMap: Record<string, string> = {};
  for (const label of nextLabels) {
    if (!label.label || !label.selector_hint) {
      continue;
    }
    nextLabelMap[normalizeToken(label.label)] = label.selector_hint;
  }

  const incomingCandidates = patch.network_candidates && patch.network_candidates.length > 0
    ? patch.network_candidates
    : base.network_candidates;
  const mergedCandidates: SiteProfileNetworkCandidate[] = [];
  const dedupe = new Set<string>();
  for (const candidate of incomingCandidates) {
    const key = `${candidate.origin}|${candidate.path_template}`;
    if (!candidate.origin || !candidate.path_template || dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    mergedCandidates.push(candidate);
    if (mergedCandidates.length >= 200) {
      break;
    }
  }

  return {
    host: normalizedHost || base.host,
    updated_at: now,
    last_success_at: patch.mark_success ? now : base.last_success_at || null,
    labels: nextLabels,
    label_map: nextLabelMap,
    network_candidates: mergedCandidates
  };
}

function pushSelectorCandidate(
  out: SelectorCandidate[],
  dedupe: Set<string>,
  selector: string | null,
  source: SelectorCandidate['source'],
  confidence: number,
  labelKey?: string
): void {
  const normalized = asOptionalString(selector);
  if (!normalized) {
    return;
  }
  const key = normalized.trim();
  if (dedupe.has(key)) {
    return;
  }
  dedupe.add(key);
  out.push({
    selector: key,
    source,
    confidence,
    label_key: labelKey ? normalizeToken(labelKey) : undefined
  });
}

export function buildSelectorFallbackStack(params: {
  step: Record<string, unknown>;
  labelMap?: Record<string, string> | null;
  siteProfile?: SiteProfile | null;
}): SelectorCandidate[] {
  const step = params.step;
  const out: SelectorCandidate[] = [];
  const dedupe = new Set<string>();
  const explicitSelector = asOptionalString(step.selector);
  pushSelectorCandidate(out, dedupe, explicitSelector, 'explicit', 1.0);

  const labelMap: Record<string, string> = {
    ...(params.siteProfile?.label_map || {}),
    ...(params.labelMap || {})
  };
  const labelKeyRaw =
    asOptionalString(step.label_key) ||
    asOptionalString(step.selector_key) ||
    asOptionalString(step.target_key) ||
    asOptionalString(step.target);
  const labelKey = normalizeToken(labelKeyRaw || '');
  if (labelKey && labelMap[labelKey]) {
    pushSelectorCandidate(out, dedupe, labelMap[labelKey], 'label_key', 0.97, labelKey);
  }

  const text = asOptionalString(step.text) || asOptionalString(step.text_match);
  const role = asOptionalString(step.role);
  if (role && text) {
    const escapedText = cssEscapeValue(text);
    pushSelectorCandidate(out, dedupe, `[role="${cssEscapeValue(role)}"]:has-text("${escapedText}")`, 'role_text', 0.82);
  }
  if (text) {
    const escapedText = cssEscapeValue(text);
    pushSelectorCandidate(out, dedupe, `button:has-text("${escapedText}")`, 'role_text', 0.78);
    pushSelectorCandidate(out, dedupe, `a:has-text("${escapedText}")`, 'role_text', 0.72);
    pushSelectorCandidate(out, dedupe, `text=${text}`, 'role_text', 0.65);
  }

  const attrPairs: Array<[string, string | null]> = [
    ['data-testid', asOptionalString(step.data_testid) || asOptionalString(step.test_id)],
    ['name', asOptionalString(step.name)],
    ['aria-label', asOptionalString(step.aria_label)],
    ['placeholder', asOptionalString(step.placeholder)],
    ['type', asOptionalString(step.type)]
  ];
  for (const [attr, value] of attrPairs) {
    if (!value) {
      continue;
    }
    pushSelectorCandidate(
      out,
      dedupe,
      `[${attr}="${cssEscapeValue(value)}"]`,
      'attribute',
      0.58
    );
  }

  return out.slice(0, 16);
}

export function resolveApiAttemptFromCandidates(params: {
  attempt: Record<string, unknown>;
  siteProfile?: SiteProfile | null;
  fallbackOrigin?: string | null;
}): {
  url: string | null;
  source: 'explicit' | 'candidate_path' | 'candidate_key' | 'none';
  confidence: number;
  matched_candidate?: SiteProfileNetworkCandidate | null;
} {
  const attempt = params.attempt;
  const explicit = asOptionalString(attempt.url);
  if (explicit) {
    return { url: explicit, source: 'explicit', confidence: 1.0, matched_candidate: null };
  }
  const pathToken =
    asOptionalString(attempt.path_template) ||
    asOptionalString(attempt.path) ||
    asOptionalString(attempt.endpoint_path);
  const candidateKey = normalizeToken(
    asOptionalString(attempt.candidate_key) ||
    asOptionalString(attempt.endpoint_key) ||
    ''
  );
  const method = asOptionalString(attempt.method)?.toUpperCase() || null;
  const candidates = params.siteProfile?.network_candidates || [];
  if (pathToken) {
    const normalizedPathToken = String(pathToken).trim().toLowerCase();
    const matched = candidates.find((candidate) => {
      if (method && candidate.methods.length > 0 && !candidate.methods.includes(method)) {
        return false;
      }
      return candidate.path_template.toLowerCase().includes(normalizedPathToken);
    });
    if (matched) {
      return {
        url: `${matched.origin}${matched.path_template}`,
        source: 'candidate_path',
        confidence: 0.9,
        matched_candidate: matched
      };
    }
    if (params.fallbackOrigin) {
      return {
        url: `${params.fallbackOrigin}${pathToken.startsWith('/') ? pathToken : `/${pathToken}`}`,
        source: 'candidate_path',
        confidence: 0.66,
        matched_candidate: null
      };
    }
  }
  if (candidateKey) {
    const matched = candidates.find((candidate) => {
      const token = normalizeToken(candidate.path_template);
      return token.includes(candidateKey);
    });
    if (matched) {
      return {
        url: `${matched.origin}${matched.path_template}`,
        source: 'candidate_key',
        confidence: 0.76,
        matched_candidate: matched
      };
    }
  }
  return { url: null, source: 'none', confidence: 0, matched_candidate: null };
}

export function inferRequiredLabelKeys(params: {
  desiredAction: string;
  userTask: string;
  actions: Array<Record<string, unknown>>;
}): string[] {
  const out = new Set<string>();
  for (const step of params.actions) {
    const key =
      asOptionalString(step.label_key) ||
      asOptionalString(step.selector_key) ||
      asOptionalString(step.target_key);
    if (key) {
      out.add(normalizeToken(key));
    }
  }
  const lowerTask = params.userTask.toLowerCase();
  const desired = params.desiredAction.toLowerCase();
  if (desired !== 'read') {
    if (/\b(delete|remove|trash|spam|junk)\b/.test(lowerTask) || desired === 'delete') {
      out.add('delete_button');
      out.add('select_row');
    }
    if (/\b(archive|move)\b/.test(lowerTask)) {
      out.add('archive_button');
      out.add('select_row');
    }
    if (/\b(create|new|compose|add)\b/.test(lowerTask) || desired === 'create') {
      out.add('submit_button');
    }
  }
  return Array.from(out).filter(Boolean).slice(0, 12);
}

export function enforceExecutionGuardrails(input: GuardrailInput): GuardrailResult {
  if (!input.mutate) {
    return {
      ok: true,
      issues: [],
      missingLabelKeys: [],
      missingNetworkCandidates: false,
      pilotRequired: false
    };
  }
  const labelMap = new Map<string, string>();
  for (const row of input.labels) {
    const label = normalizeToken(asOptionalString(row.label) || '');
    const selector = asOptionalString(row.selector_hint) || asOptionalString(row.selector);
    if (!label || !selector) {
      continue;
    }
    labelMap.set(label, selector);
  }
  const missingLabelKeys = input.requiredLabelKeys
    .map((item) => normalizeToken(item))
    .filter((item) => item.length > 0 && !labelMap.has(item));
  const hasNetworkCandidates = input.networkCandidates.length > 0;
  const missingNetworkCandidates =
    input.preferNetworkFirst &&
    input.actionsCount > 0 &&
    input.apiAttemptsCount === 0 &&
    !hasNetworkCandidates;
  const pilotRequired =
    (input.desiredAction === 'delete' || input.cleanupIntent) &&
    !input.pilotApproved;
  const issues: string[] = [];
  if (missingLabelKeys.length > 0) {
    issues.push(`Required labels missing: ${missingLabelKeys.join(', ')}`);
  }
  if (missingNetworkCandidates) {
    issues.push('No network/API candidates detected for network-first execution.');
  }
  if (pilotRequired) {
    issues.push('Pilot-first policy requires explicit pilot approval before writes.');
  }
  return {
    ok: issues.length === 0,
    issues,
    missingLabelKeys,
    missingNetworkCandidates,
    pilotRequired
  };
}
