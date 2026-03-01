import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pluginContext, respond, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';
import {
  asOptionalString,
  extractUrlHost,
  inferUrlFromMessage,
  parseActionSteps,
  parseApiAttempts,
  parseJsonOutput,
  parseTargetMeta,
  resolveAgentBinary,
  resolvePlaywrightExecutionPolicy,
  runChatLlm,
  runPlaywrightService,
  toBool,
  toInt
} from './playwright-common.ts';
import {
  buildSelectorFallbackStack,
  enforceExecutionGuardrails,
  extractSiteProfileLabels,
  extractSiteProfileNetworkCandidates,
  inferRequiredLabelKeys,
  mapPluginModeToWorkflowTelemetry,
  mergeSiteProfile,
  resolveApiAttemptFromCandidates,
  type SiteProfile,
  type WorkflowTelemetry
} from './playwright-runtime-utils.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['read']);

interface PlannerResult {
  actions: ReturnType<typeof parseActionSteps>;
  apiAttempts: ReturnType<typeof parseApiAttempts>;
  needsUserStep: string | null;
  notes: string | null;
}

type ProbeWalkthroughStepKind = 'label' | 'action';

interface ProbeWalkthroughStep {
  id: string;
  kind: ProbeWalkthroughStepKind;
  title: string;
  instruction: string;
  suggested_label?: string | null;
  required: boolean;
}

interface ProbeWalkthroughPlan {
  goal: string;
  context: string;
  steps: ProbeWalkthroughStep[];
  source: 'llm' | 'fallback' | 'state';
  generated_at: string;
}

interface ProbeState {
  channel: string;
  updated_at: string;
  task_summary?: string;
  desired_action?: string;
  url?: string | null;
  checkpoint_satisfied?: boolean;
  checkpoint_awaited?: boolean;
  checkpoint_reason?: string | null;
  checkpoint_waited_ms?: number;
  discovery?: Record<string, unknown>;
  planner_actions?: ReturnType<typeof parseActionSteps>;
  planner_api_attempts?: ReturnType<typeof parseApiAttempts>;
  planner_notes?: string | null;
  needs_user_step?: string | null;
  walkthrough_plan?: ProbeWalkthroughPlan | null;
  workflow_state?: string | null;
  workflow_pending_step?: string | null;
  workflow_last_transition?: string | null;
  workflow_last_error?: string | null;
  site_profile_host?: string | null;
}

interface ProbeSkillBuildInput {
  skillName: string;
  description: string;
  url: string | null;
  state: ProbeState;
}

interface SkillRegistrationResult {
  ok: boolean;
  command: string;
  detail: string;
}

const CLEANUP_TRAINING_SENTINEL = '[pinokio_cleanup_training_pending]';

const plannerPayloadSchema = z.object({
  mode: z.string().optional(),
  question: z.string().optional(),
  notes: z.string().optional(),
  api_attempts: z.array(z.record(z.string(), z.unknown())).optional(),
  actions: z.array(z.record(z.string(), z.unknown())).optional()
}).passthrough();

const walkthroughStepSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['label', 'action']),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(1200),
  suggested_label: z.string().min(1).max(120).optional(),
  required: z.boolean().optional()
}).passthrough();

const walkthroughPlanSchema = z.object({
  goal: z.string().min(1).max(300).optional(),
  context: z.string().max(300).optional(),
  steps: z.array(walkthroughStepSchema).min(1).max(20)
}).passthrough();

function normalizeAction(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function resolveDesiredAction(request: PluginRequest, targetMeta: Record<string, unknown>): string {
  if (toBool(targetMeta.show_network_candidates, false)) {
    return 'read';
  }
  const desired = normalizeAction(targetMeta.desired_action || request.action || 'read');
  if (!desired) {
    return 'read';
  }
  if (desired === 'write' || desired === 'act' || desired === 'post' || desired === 'reply') {
    return 'update';
  }
  if (desired === 'discover' || desired === 'inspect' || desired === 'info') {
    return 'read';
  }
  if (!['create', 'read', 'update', 'delete'].includes(desired)) {
    return 'read';
  }
  return desired;
}

function resolveTargetUrl(request: PluginRequest, targetMeta: Record<string, unknown>): string | null {
  const explicit = asOptionalString(targetMeta.url);
  if (explicit) {
    return explicit;
  }
  const fromSummary = inferUrlFromMessage(asOptionalString(request.summary) || '');
  if (fromSummary) {
    return fromSummary;
  }
  const message = asOptionalString(targetMeta.message) || '';
  return inferUrlFromMessage(message);
}

function normalizeWalkthroughToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
}

function normalizeWalkthroughStep(raw: ProbeWalkthroughStep): ProbeWalkthroughStep {
  const idSeed = raw.id || raw.suggested_label || raw.title;
  const id = normalizeWalkthroughToken(idSeed) || `step_${Date.now().toString(36)}`;
  const kind: ProbeWalkthroughStepKind = raw.kind === 'action' ? 'action' : 'label';
  const title = String(raw.title || 'Walkthrough step').trim().slice(0, 200) || 'Walkthrough step';
  const instruction =
    String(raw.instruction || '').trim().slice(0, 1200) ||
    (kind === 'label'
      ? 'Label the requested UI control in the overlay.'
      : 'Perform the requested action in the browser and mark it done.');
  const suggestedLabelRaw = asOptionalString(raw.suggested_label);
  const suggested_label = suggestedLabelRaw
    ? normalizeWalkthroughToken(suggestedLabelRaw).slice(0, 90) || suggestedLabelRaw.slice(0, 90)
    : kind === 'label'
      ? id
      : null;
  return {
    id,
    kind,
    title,
    instruction,
    suggested_label,
    required: raw.required !== false
  };
}

function parseWalkthroughPlanValue(value: unknown, source: ProbeWalkthroughPlan['source']): ProbeWalkthroughPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const parsed = walkthroughPlanSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const row = parsed.data;
  const steps = row.steps
    .map((item) =>
      normalizeWalkthroughStep({
        id: item.id,
        kind: item.kind,
        title: item.title,
        instruction: item.instruction,
        suggested_label: item.suggested_label || null,
        required: item.required !== false
      })
    )
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 16);
  if (steps.length === 0) {
    return null;
  }
  const goal = asOptionalString(row.goal) || 'Guided browser walkthrough';
  const context = asOptionalString(row.context) || 'general';
  return {
    goal: goal.slice(0, 300),
    context: context.slice(0, 300),
    steps,
    source,
    generated_at: new Date().toISOString()
  };
}

function extractNetworkSummary(discovery: Record<string, unknown>): Record<string, unknown> {
  return discovery.network_summary &&
    typeof discovery.network_summary === 'object' &&
    !Array.isArray(discovery.network_summary)
    ? (discovery.network_summary as Record<string, unknown>)
    : {};
}

function extractProbeLabels(discovery: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(discovery.probe_labels)) {
    return [];
  }
  return discovery.probe_labels
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, 200) as Array<Record<string, unknown>>;
}

function extractProbeActionEvents(discovery: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(discovery.probe_action_events)) {
    return [];
  }
  return discovery.probe_action_events
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .slice(-80) as Array<Record<string, unknown>>;
}

function extractProbeTrainingState(discovery: Record<string, unknown>): Record<string, unknown> | null {
  const raw = discovery.probe_training_state;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function hasCleanupTrainingExamples(discovery: Record<string, unknown>): boolean {
  const trainingState = extractProbeTrainingState(discovery);
  if (
    trainingState &&
    toBool(trainingState.junk_done, false) &&
    toBool(trainingState.keep_done, false) &&
    toBool(trainingState.mutate_done, false)
  ) {
    return true;
  }
  const marks = new Set<string>();
  const actionEvents = extractProbeActionEvents(discovery);
  for (const event of actionEvents) {
    const type = asOptionalString(event.type);
    if (type !== 'training_mark') {
      continue;
    }
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
    const kind = asOptionalString(payload?.kind);
    if (kind) {
      marks.add(kind.toLowerCase());
    }
  }
  return marks.has('junk') && marks.has('keep') && marks.has('mutate');
}

function extractProbeWalkthroughState(discovery: Record<string, unknown>): Record<string, unknown> | null {
  const raw = discovery.probe_walkthrough_state;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function extractDiscoveryNetworkCandidates(discovery: Record<string, unknown>): Array<Record<string, unknown>> {
  const network = extractNetworkSummary(discovery);
  if (!Array.isArray(network.candidates)) {
    return [];
  }
  return network.candidates
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>)
    .slice(0, 120);
}

function mapSiteProfileLabelsToProbeLabels(
  profile: SiteProfile | null,
  fallbackUrl: string | null
): Array<Record<string, unknown>> {
  if (!profile || !Array.isArray(profile.labels)) {
    return [];
  }
  return profile.labels.map((item) => ({
    label: item.label,
    selector_hint: item.selector_hint,
    role: item.role || null,
    type: item.type || null,
    name: item.name || null,
    aria_label: item.aria_label || null,
    placeholder: item.placeholder || null,
    text_sample: item.text_sample || null,
    url: fallbackUrl || null,
    source: 'site_profile',
    updated_at: item.updated_at
  }));
}

function mapSiteProfileNetworkCandidatesToDiscovery(
  profile: SiteProfile | null
): Array<Record<string, unknown>> {
  if (!profile || !Array.isArray(profile.network_candidates)) {
    return [];
  }
  return profile.network_candidates.map((item) => ({
    origin: item.origin,
    path_template: item.path_template,
    methods: item.methods,
    api_like: item.api_like,
    same_origin: item.same_origin,
    count: item.count,
    source: 'site_profile',
    updated_at: item.updated_at
  }));
}

function dedupeProbeLabels(
  labels: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of labels) {
    const label = asOptionalString(item.label) || '';
    const selector = asOptionalString(item.selector_hint) || '';
    const key = `${label}::${selector}`;
    if (!label || !selector || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 200);
}

function dedupeNetworkCandidates(
  candidates: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const origin = asOptionalString(item.origin) || '';
    const pathTemplate = asOptionalString(item.path_template) || '';
    const key = `${origin}|${pathTemplate}`;
    if (!origin || !pathTemplate || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 160);
}

function applySiteProfileToActions(
  actions: ReturnType<typeof parseActionSteps>,
  siteProfile: SiteProfile | null
): ReturnType<typeof parseActionSteps> {
  if (!siteProfile || actions.length === 0) {
    return actions;
  }
  return parseActionSteps(actions.map((step) => {
    const row: Record<string, unknown> = { ...step };
    const stack = buildSelectorFallbackStack({
      step: row,
      siteProfile
    });
    if (!asOptionalString(row.selector) && stack.length > 0) {
      row.selector = stack[0].selector;
    }
    row.selector_fallback_stack = stack.map((candidate) => ({
      selector: candidate.selector,
      source: candidate.source,
      confidence: candidate.confidence,
      label_key: candidate.label_key || null
    }));
    return row;
  }));
}

function applySiteProfileToApiAttempts(
  attempts: ReturnType<typeof parseApiAttempts>,
  siteProfile: SiteProfile | null,
  fallbackOrigin: string | null
): ReturnType<typeof parseApiAttempts> {
  if (attempts.length === 0) {
    return attempts;
  }
  return parseApiAttempts(attempts.map((attempt) => {
    const row: Record<string, unknown> = { ...attempt };
    const resolved = resolveApiAttemptFromCandidates({
      attempt: row,
      siteProfile,
      fallbackOrigin
    });
    if (!asOptionalString(row.url) && resolved.url) {
      row.url = resolved.url;
    }
    row.resolve_source = resolved.source;
    row.resolve_confidence = resolved.confidence;
    if (resolved.matched_candidate) {
      row.matched_candidate = resolved.matched_candidate;
    }
    return row;
  }));
}

function isLikelyMailWorkflow(params: { userTask: string; url: string | null }): boolean {
  const lower = String(params.userTask || '').toLowerCase();
  const host = extractUrlHost(params.url || '') || '';
  if (
    host.includes('outlook') ||
    host.includes('hotmail') ||
    host.includes('mail.google') ||
    host.includes('gmail')
  ) {
    return true;
  }
  return /\b(email|emails|inbox|mailbox|gmail|hotmail|outlook|spam|junk)\b/.test(lower);
}

function buildFallbackWalkthroughPlan(params: {
  userTask: string;
  url: string | null;
}): ProbeWalkthroughPlan {
  const isMail = isLikelyMailWorkflow(params);
  const stepsRaw: ProbeWalkthroughStep[] = isMail
    ? [
        {
          id: 'select_row',
          kind: 'label',
          title: 'Label message row selector',
          instruction: 'Click and label the checkbox/row control used to select one message.',
          suggested_label: 'select_row',
          required: true
        },
        {
          id: 'select_all',
          kind: 'label',
          title: 'Label select-all control',
          instruction: 'Label the control that selects all messages in the current view.',
          suggested_label: 'select_all',
          required: true
        },
        {
          id: 'delete_action',
          kind: 'label',
          title: 'Label delete control',
          instruction: 'Label the delete/trash action button.',
          suggested_label: 'delete_action',
          required: true
        },
        {
          id: 'move_action',
          kind: 'label',
          title: 'Label move/folder control',
          instruction: 'Label the move-to-folder action used for archive/organize.',
          suggested_label: 'move_action',
          required: true
        },
        {
          id: 'spam_action',
          kind: 'label',
          title: 'Label spam/junk control',
          instruction: 'Label the action used to report or move a message to spam/junk.',
          suggested_label: 'spam_action',
          required: true
        },
        {
          id: 'example_junk',
          kind: 'action',
          title: 'Demonstrate junk example',
          instruction: 'Perform one junk/spam action on a clearly promotional email, then mark this step done.',
          required: true
        },
        {
          id: 'example_keep',
          kind: 'action',
          title: 'Demonstrate keep example',
          instruction: 'Open/keep one important message you never want auto-removed, then mark this step done.',
          required: true
        },
        {
          id: 'example_mutation',
          kind: 'action',
          title: 'Demonstrate mutate example',
          instruction: 'Perform one delete or archive action exactly as desired for automation, then mark this step done.',
          required: true
        }
      ]
    : [
        {
          id: 'primary_target',
          kind: 'label',
          title: 'Label primary target item',
          instruction: 'Label the main row/card/item the automation should operate on.',
          suggested_label: 'primary_target',
          required: true
        },
        {
          id: 'primary_mutation',
          kind: 'label',
          title: 'Label primary mutation action',
          instruction: 'Label the main action button that mutates data (delete/move/archive/update).',
          suggested_label: 'primary_mutation',
          required: true
        },
        {
          id: 'example_keep',
          kind: 'action',
          title: 'Demonstrate keep/safe case',
          instruction: 'Show one item that should be kept or skipped, then mark this step done.',
          required: true
        },
        {
          id: 'example_mutation',
          kind: 'action',
          title: 'Demonstrate mutation case',
          instruction: 'Perform one mutation exactly as desired, then mark this step done.',
          required: true
        }
      ];

  return {
    goal: isMail ? 'Email cleanup walkthrough' : 'Browser task walkthrough',
    context: isMail ? 'mail_cleanup' : 'generic',
    steps: stepsRaw.map((step) => normalizeWalkthroughStep(step)),
    source: 'fallback',
    generated_at: new Date().toISOString()
  };
}

function buildWalkthroughPlanPrompt(params: {
  userTask: string;
  desiredAction: string;
  url: string | null;
  discovery: Record<string, unknown> | null;
  existingLabels: Array<Record<string, unknown>>;
}): string {
  const discoveryText = params.discovery ? JSON.stringify(params.discovery).slice(0, 9000) : '{}';
  const labelsText = params.existingLabels
    .slice(0, 40)
    .map((item) => {
      const label = asOptionalString(item.label) || 'label';
      const hint = asOptionalString(item.selector_hint) || asOptionalString(item.tag) || 'unknown';
      return `- ${label}: ${hint}`;
    })
    .join('\n') || '- none';
  return [
    'You are building a guided browser walkthrough plan for Pinokio.',
    'Return strict JSON only using this schema:',
    '{"goal":"...","context":"...","steps":[{"id":"...", "kind":"label|action", "title":"...", "instruction":"...", "suggested_label":"...", "required":true}]}',
    'Rules:',
    '- Steps must be generic and reusable for this workflow type, not brittle to one page render.',
    '- Start with required label steps for critical controls, then action demonstration steps.',
    '- For label steps, suggested_label should be machine-friendly snake_case.',
    '- Keep steps concise and operational (max 10 steps).',
    '- For action steps, ask the user to perform real examples so network/DOM traces are captured.',
    `Desired action: ${params.desiredAction}`,
    `Target URL: ${params.url || 'unknown'}`,
    `Existing labels:\n${labelsText}`,
    `User task:\n${params.userTask}`,
    `Discovery snapshot:\n${discoveryText}`
  ].join('\n\n');
}

function getWalkthroughPendingStep(plan: ProbeWalkthroughPlan, discovery: Record<string, unknown>): ProbeWalkthroughStep | null {
  const state = extractProbeWalkthroughState(discovery);
  const completedSet = new Set<string>();
  if (state && Array.isArray(state.completed_ids)) {
    for (const item of state.completed_ids) {
      const id = normalizeWalkthroughToken(String(item || ''));
      if (id) {
        completedSet.add(id);
      }
    }
  }
  for (const step of plan.steps) {
    const stepId = normalizeWalkthroughToken(step.id);
    if (!stepId) {
      continue;
    }
    if (!completedSet.has(stepId)) {
      return step;
    }
  }
  return null;
}

function hasWalkthroughCompletion(plan: ProbeWalkthroughPlan, discovery: Record<string, unknown>): boolean {
  const state = extractProbeWalkthroughState(discovery);
  if (!state) {
    return false;
  }
  const completedSet = new Set<string>();
  if (Array.isArray(state.completed_ids)) {
    for (const item of state.completed_ids) {
      const id = normalizeWalkthroughToken(String(item || ''));
      if (id) {
        completedSet.add(id);
      }
    }
  }
  const requiredSteps = plan.steps.filter((step) => step.required !== false);
  if (requiredSteps.length === 0) {
    return false;
  }
  return requiredSteps.every((step) => completedSet.has(normalizeWalkthroughToken(step.id)));
}

function buildWalkthroughGuidanceMessage(params: {
  url: string | null;
  plan: ProbeWalkthroughPlan;
  discovery: Record<string, unknown>;
}): string {
  const pending = getWalkthroughPendingStep(params.plan, params.discovery);
  const totalRequired = params.plan.steps.filter((step) => step.required !== false).length;
  const state = extractProbeWalkthroughState(params.discovery);
  const completedCount = state && Array.isArray(state.completed_ids)
    ? state.completed_ids.length
    : 0;
  if (!pending) {
    return `Guided walkthrough is complete on ${params.url || 'the target site'} (${completedCount}/${totalRequired} required steps done).`;
  }
  const kindText = pending.kind === 'label' ? 'labeling' : 'action demonstration';
  const labelHint = pending.kind === 'label' && pending.suggested_label
    ? ` Use label key "${pending.suggested_label}".`
    : '';
  const nextHint = pending.kind === 'label'
    ? 'Click the target element and save the label in the overlay modal.'
    : 'Perform the action in the browser, then click "Mark Step Done" in the overlay.';
  return [
    `Guided walkthrough progress: ${Math.min(completedCount, totalRequired)}/${totalRequired} required steps complete.`,
    `Next ${kindText} step: ${pending.title}.`,
    pending.instruction,
    `${nextHint}${labelHint}`,
    'When the step is done, the overlay will advance to the next step automatically (or click READY if prompted).'
  ].join(' ');
}

function buildWalkthroughCapturedMessage(params: {
  url: string | null;
  plan: ProbeWalkthroughPlan;
  discovery: Record<string, unknown>;
}): string {
  const state = extractProbeWalkthroughState(params.discovery);
  const completedCount =
    state && Array.isArray(state.completed_ids) ? state.completed_ids.length : 0;
  const totalRequired = params.plan.steps.filter((step) => step.required !== false).length;
  return [
    `Guided walkthrough complete on ${params.url || 'the target site'} (${Math.min(completedCount, totalRequired)}/${totalRequired} required steps).`,
    'I captured your labels and example actions. Next step: review candidates or run a safe pilot.',
    'Reply "SHOW CANDIDATES", "PILOT ARCHIVE 1", or "PILOT DELETE 1".'
  ].join(' ');
}

function summarizeNetworkCandidate(candidate: Record<string, unknown>): string {
  const methods = Array.isArray(candidate.methods)
    ? candidate.methods.map((item) => String(item || '').toUpperCase()).filter(Boolean).slice(0, 4).join('/')
    : '';
  const pathTemplate = asOptionalString(candidate.path_template) || '/';
  const host = asOptionalString(candidate.host) || asOptionalString(candidate.origin) || 'unknown-host';
  return `${methods || 'GET'} ${pathTemplate} (${host})`;
}

function formatSecondsFromMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(ms / 1000));
}

function buildBrowserLifecycleLine(params: {
  discovery: Record<string, unknown>;
  keepOpenAfterDiscoveryMs: number;
  awaitUserCheckpointRequested: boolean;
  useUserContext: boolean;
  headless: boolean;
  nonBlockingKeepOpen: boolean;
}): string | null {
  const {
    discovery,
    keepOpenAfterDiscoveryMs,
    awaitUserCheckpointRequested,
    useUserContext,
    headless,
    nonBlockingKeepOpen
  } = params;

  const checkpoint =
    discovery.user_checkpoint && typeof discovery.user_checkpoint === 'object' && !Array.isArray(discovery.user_checkpoint)
      ? (discovery.user_checkpoint as Record<string, unknown>)
      : null;
  const checkpointReason = asOptionalString(checkpoint?.reason);
  const checkpointAwaited = checkpoint ? toBool(checkpoint.awaited, false) : false;
  const checkpointSatisfied = checkpoint ? toBool(checkpoint.satisfied, false) : false;

  if (checkpointReason === 'page_closed') {
    return 'Browser status: automation window was closed before the checkpoint/discovery flow finished.';
  }

  if (headless || !useUserContext) {
    return null;
  }

  if (!(awaitUserCheckpointRequested || checkpointAwaited)) {
    return 'Browser status: automation ran in a managed browser session for this step.';
  }

  if (!checkpointSatisfied) {
    return 'Browser status: checkpoint is still incomplete. Keep the automation window open and click READY in the injected panel (or reply "READY") after sign-in.';
  }

  if (keepOpenAfterDiscoveryMs > 0) {
    const seconds = formatSecondsFromMs(keepOpenAfterDiscoveryMs);
    if (nonBlockingKeepOpen) {
      return `Browser status: checkpoint completed, discovery captured. The automation window stays open for ~${seconds}s, then auto-closes.`;
    }
    return `Browser status: checkpoint completed, discovery captured, window stayed open ~${seconds}s, then auto-closed.`;
  }

  return 'Browser status: checkpoint completed, discovery captured, then window auto-closed.';
}

function buildChatResponseFromDiscovery(
  discovery: Record<string, unknown>,
  url: string | null,
  options?: {
    keepOpenAfterDiscoveryMs?: number;
    awaitUserCheckpointRequested?: boolean;
    useUserContext?: boolean;
    headless?: boolean;
    nonBlockingKeepOpen?: boolean;
  }
): string {
  const title = asOptionalString(discovery.title) || '(untitled)';
  const currentUrl = asOptionalString(discovery.url) || url || 'about:blank';
  const challenge = asOptionalString((discovery.challenge as Record<string, unknown> | undefined)?.summary);
  const interactiveCount = Number((discovery.interactive as Record<string, unknown> | undefined)?.total || 0);
  const networkSummary = extractNetworkSummary(discovery);
  const apiLikeCount = Number(networkSummary.api_like_events || 0);
  const candidates = Array.isArray(networkSummary.candidates) ? networkSummary.candidates : [];
  const labelCount = extractProbeLabels(discovery).length;
  const topCandidate = candidates.length > 0 && typeof candidates[0] === 'object' && candidates[0] !== null
    ? summarizeNetworkCandidate(candidates[0] as Record<string, unknown>)
    : null;
  const base = challenge
    ? `Discovery complete for ${currentUrl} (${title}). Bot protection detected: ${challenge}`
    : `Discovery complete for ${currentUrl} (${title}). Found ${Number.isFinite(interactiveCount) ? interactiveCount : 0} interactive elements.`;
  const networkLine = Number.isFinite(apiLikeCount) ? ` API-like events: ${apiLikeCount}.` : '';
  const labelLine = labelCount > 0 ? ` Saved labels: ${labelCount}.` : '';
  const candidateLine = topCandidate ? ` Top candidate: ${topCandidate}.` : '';
  const lifecycleLine = buildBrowserLifecycleLine({
    discovery,
    keepOpenAfterDiscoveryMs: toInt(options?.keepOpenAfterDiscoveryMs, 0, 0, 300000),
    awaitUserCheckpointRequested: toBool(options?.awaitUserCheckpointRequested, false),
    useUserContext: toBool(options?.useUserContext, false),
    headless: toBool(options?.headless, false),
    nonBlockingKeepOpen: toBool(options?.nonBlockingKeepOpen, false)
  });
  return `${base}${networkLine}${labelLine}${candidateLine}${lifecycleLine ? ` ${lifecycleLine}` : ''}`.trim();
}

const WORKFLOW_TIMEOUT_POLICY_MS: Record<string, number> = {
  needs_ready: 10 * 60 * 1000,
  needs_policy: 15 * 60 * 1000,
  needs_user_step: 20 * 60 * 1000,
  needs_pilot_approval: 10 * 60 * 1000,
  challenge_detected: 8 * 60 * 1000,
  human_required: 20 * 60 * 1000,
  probing: 12 * 60 * 1000,
  executing: 10 * 60 * 1000
};

function timeoutPolicyLabel(state: string): string {
  const ms = WORKFLOW_TIMEOUT_POLICY_MS[state];
  if (!Number.isFinite(ms) || ms <= 0) {
    return 'n/a';
  }
  const minutes = Math.round(ms / 60000);
  return `${minutes}m`;
}

function buildWorkflowTelemetry(params: {
  mode: string;
  discovery?: Record<string, unknown> | null;
  needsUserStep?: string | null;
  lastError?: string | null;
}): WorkflowTelemetry {
  const challengeDetected = params.discovery
    ? toBool(
        ((params.discovery.challenge as Record<string, unknown> | undefined)?.detected),
        false
      )
    : false;
  return mapPluginModeToWorkflowTelemetry({
    mode: params.mode,
    challengeDetected,
    needsUserStep: params.needsUserStep || null,
    lastError: params.lastError || null
  });
}

function buildWorkflowTelemetryBlock(telemetry: WorkflowTelemetry): Record<string, unknown> {
  return {
    type: 'playwright_workflow_telemetry',
    title: 'Workflow Telemetry',
    subtitle: 'Current state and recovery policy',
    items: [
      {
        name: `State: ${telemetry.state}`,
        kind: 'entry',
        relative_path: `Pending: ${telemetry.pending_step || 'none'}`
      },
      {
        name: `Last transition: ${telemetry.last_transition}`,
        kind: 'entry',
        relative_path: telemetry.last_error ? `Last error: ${telemetry.last_error}` : 'Last error: none'
      },
      {
        name: `Timeout policy: ${timeoutPolicyLabel(telemetry.state)}`,
        kind: 'entry',
        relative_path:
          telemetry.state === 'challenge_detected'
            ? 'Recovery: complete challenge in browser and click READY.'
            : telemetry.state === 'human_required'
              ? 'Recovery: complete required browser step then click READY.'
              : telemetry.state === 'needs_policy'
                ? 'Recovery: provide policy or pick 1/2/3.'
                : telemetry.state === 'needs_pilot_approval'
                  ? 'Recovery: approve PILOT ARCHIVE 1 or PILOT DELETE 1.'
                  : telemetry.state === 'needs_ready'
                    ? 'Recovery: open target workflow page and click READY.'
                    : 'Recovery: ask browser status or continue workflow.'
      }
    ],
    total_count: 3
  };
}

function workflowPatchFromTelemetry(
  telemetry: WorkflowTelemetry,
  host: string | null
): Partial<ProbeState> {
  return {
    workflow_state: telemetry.state,
    workflow_pending_step: telemetry.pending_step,
    workflow_last_transition: telemetry.last_transition,
    workflow_last_error: telemetry.last_error,
    site_profile_host: host
  };
}

function withWorkflowTelemetryBlocks(
  blocks: Record<string, unknown>[],
  telemetry: WorkflowTelemetry
): Record<string, unknown>[] {
  const out = blocks.slice(0, 10);
  out.push(buildWorkflowTelemetryBlock(telemetry));
  return out;
}

function buildUiBlocks(discovery: Record<string, unknown>, desiredAction: string): Record<string, unknown>[] {
  const url = asOptionalString(discovery.url) || '';
  const title = asOptionalString(discovery.title) || '(untitled)';
  const challengeObj = discovery.challenge && typeof discovery.challenge === 'object' && !Array.isArray(discovery.challenge)
    ? discovery.challenge as Record<string, unknown>
    : null;
  const challengeDetected = challengeObj ? toBool(challengeObj.detected, false) : false;
  const challengeSummary = challengeObj ? asOptionalString(challengeObj.summary) : null;
  const interactive = discovery.interactive && typeof discovery.interactive === 'object' && !Array.isArray(discovery.interactive)
    ? discovery.interactive as Record<string, unknown>
    : {};
  const total = Number(interactive.total || 0);
  const buttons = Number(interactive.buttons || 0);
  const inputs = Number(interactive.inputs || 0);
  const links = Number(interactive.links || 0);
  const networkSummary = extractNetworkSummary(discovery);
  const apiLikeEvents = Number(networkSummary.api_like_events || 0);
  const candidateRows = Array.isArray(networkSummary.candidates)
    ? networkSummary.candidates
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 8) as Array<Record<string, unknown>>
    : [];
  const probeLabels = extractProbeLabels(discovery).slice(0, 10);
  const blocks: Record<string, unknown>[] = [];

  blocks.push({
    type: 'playwright_discovery',
    title: `Automation Map · ${title}`,
    subtitle: desiredAction === 'read' ? 'Read Discovery Snapshot' : 'Read Plan For Mutations',
    items: [
      {
        name: 'URL',
        kind: 'entry',
        relative_path: url || '(unknown)',
        path: url || undefined
      },
      {
        name: `Interactive Elements: ${String(Number.isFinite(total) ? total : 0)}`,
        kind: 'entry',
        relative_path: `Buttons ${String(Number.isFinite(buttons) ? buttons : 0)} · Inputs ${String(Number.isFinite(inputs) ? inputs : 0)} · Links ${String(Number.isFinite(links) ? links : 0)}`
      },
      {
        name: `API-like Network Events: ${String(Number.isFinite(apiLikeEvents) ? apiLikeEvents : 0)}`,
        kind: 'entry',
        relative_path: `Candidates ${String(candidateRows.length)} · Labels ${String(probeLabels.length)}`
      },
      {
        name: `Bot Protection: ${challengeDetected ? (challengeSummary || 'Detected') : 'Not detected'}`,
        kind: 'entry',
        relative_path: challengeDetected ? 'Manual checkpoint may be required.' : 'No challenge signal detected.'
      }
    ],
    status: challengeDetected ? 'warning' : 'ok'
  });

  blocks.push({
    type: 'playwright_network_candidates',
    title: 'Network Map Candidates',
    subtitle: 'API-first paths detected during discovery',
    items:
      candidateRows.length > 0
        ? candidateRows.map((candidate) => ({
            name: summarizeNetworkCandidate(candidate),
            kind: 'entry',
            relative_path: Array.isArray(candidate.query_keys)
              ? `query: ${(candidate.query_keys as unknown[]).map((item) => String(item || '')).filter(Boolean).slice(0, 8).join(', ') || 'none'}`
              : 'query: none',
            path: asOptionalString(candidate.origin) || undefined
          }))
        : [
            {
              name: 'No API/network candidates detected yet',
              kind: 'entry',
              relative_path: 'Try READY on the exact workflow screen, then run SHOW CANDIDATES again.'
            }
          ],
    total_count: candidateRows.length
  });

  if (probeLabels.length > 0) {
    blocks.push({
      type: 'playwright_probe_labels',
      title: 'Saved Labels',
      subtitle: 'Reusable selector hints from overlay labeling',
      items: probeLabels.map((item) => ({
        name: asOptionalString(item.label) || 'labeled element',
        kind: 'entry',
        relative_path: asOptionalString(item.selector_hint) || asOptionalString(item.tag) || 'selector unavailable',
        path: asOptionalString(item.url) || undefined
      })),
      total_count: probeLabels.length
    });
  }

  return blocks;
}

function buildDiscoveryNotification(params: {
  discovery: Record<string, unknown>;
  fallbackUrl: string | null;
  lifecycleText: string;
}): Record<string, unknown> {
  const url = asOptionalString(params.discovery.url) || params.fallbackUrl || 'the target site';
  const interactive =
    params.discovery.interactive && typeof params.discovery.interactive === 'object' && !Array.isArray(params.discovery.interactive)
      ? (params.discovery.interactive as Record<string, unknown>)
      : {};
  const totalInteractive = Number(interactive.total || 0);
  const networkSummary = extractNetworkSummary(params.discovery);
  const apiLike = Number(networkSummary.api_like_events || 0);
  const body = notificationText(
    `Map ready for ${url}: ${Number.isFinite(totalInteractive) ? totalInteractive : 0} interactive elements, ${Number.isFinite(apiLike) ? apiLike : 0} API-like events. ${params.lifecycleText}`,
    220
  );
  return {
    title: 'Pinokio: Browser Map Ready',
    body,
    tag: 'pinokio-playwright-map-ready',
    url: '/ui/chat',
    prompt: 'SHOW CANDIDATES',
    actions: [
      buildNotifyAction('show_candidates', 'Show candidates', 'SHOW CANDIDATES', '/ui/chat?run_prompt=SHOW%20CANDIDATES&auto_run=1'),
      buildNotifyAction('enable_label_mode', 'Enable label mode', `Enable label mode on ${url} and let me tag fields`, '/ui/chat')
    ]
  };
}

function buildPlannerPrompt(params: {
  userTask: string;
  desiredAction: string;
  url: string | null;
  discovery: Record<string, unknown>;
  skillHints: string[];
  siteProfile?: SiteProfile | null;
}): string {
  const { userTask, desiredAction, url, discovery, skillHints, siteProfile } = params;
  const discoveryText = JSON.stringify(discovery).slice(0, 12000);
  const networkSummary = extractNetworkSummary(discovery);
  const networkCandidates = Array.isArray(networkSummary.candidates)
    ? networkSummary.candidates
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 24) as Array<Record<string, unknown>>
    : [];
  const networkCandidateLines =
    networkCandidates.length > 0
      ? networkCandidates.map((candidate) => `- ${summarizeNetworkCandidate(candidate)}`).join('\n')
      : '- none';
  const probeLabels = extractProbeLabels(discovery).slice(0, 40);
  const probeLabelLines =
    probeLabels.length > 0
      ? probeLabels
          .map((item) => {
            const label = asOptionalString(item.label) || 'label';
            const selectorHint = asOptionalString(item.selector_hint) || asOptionalString(item.tag) || 'unknown';
            return `- ${label}: ${selectorHint}`;
          })
          .join('\n')
      : '- none';
  const siteLabelLines =
    siteProfile && Array.isArray(siteProfile.labels) && siteProfile.labels.length > 0
      ? siteProfile.labels
          .slice(0, 24)
          .map((item) => `- ${item.label}: ${item.selector_hint}`)
          .join('\n')
      : '- none';
  const siteCandidateLines =
    siteProfile && Array.isArray(siteProfile.network_candidates) && siteProfile.network_candidates.length > 0
      ? siteProfile.network_candidates
          .slice(0, 18)
          .map((item) => `- ${item.methods.join('|') || 'ANY'} ${item.origin}${item.path_template} (count=${item.count})`)
          .join('\n')
      : '- none';
  return [
    'You are the Playwright READ planner for Pinokio.',
    'Your output must be strict JSON only.',
    'Goal: plan safe browser automation where READ agent discovers and WRITE agent executes.',
    'Prioritize network/API attempts first when feasible, then UI automation actions.',
    'If bot protection/challenge appears, ask user for required interaction and recommend non-headless + user context.',
    'Schema:',
    '{"mode":"run_actions|needs_user_step","question":"...", "notes":"...", "api_attempts":[{"url":"...","method":"GET|POST","headers":{},"body":...}], "actions":[{"type":"goto|click|fill|press|wait_for_selector|extract_text|api_request","...": "..."}]}',
    'Rules:',
    '- Keep actions concise and deterministic.',
    '- Never execute actions here. Only plan.',
    '- For create/update/delete browser tasks, use mode=run_actions when enough info exists.',
    '- If user credentials/2FA/manual checkpoint needed, use mode=needs_user_step with exact user instruction.',
    '- For authenticated sites, tell user to reply "READY" so automation opens its own browser context; do not tell user to use a separate normal browser profile.',
    '- For cleanup/organization tasks on messages/inbox/mailbox, ask clarifying policy questions before destructive actions (what is junk, delete vs archive, scope/time window, protected senders/folders).',
    '- For cleanup tasks with policy confirmed, request 2-3 manual examples (junk, keep, delete/archive) and wait for READY before bulk mutations.',
    '- When uncertain selectors exist, include wait_for_selector + extract_text validation step before mutation step.',
    '- Use probe labels when available. Map user intent to label names first, then selector_hint.',
    '- Always include `label_key` for click/fill/wait steps when possible.',
    '- Selector fallback stack order: label_key -> role/text -> attribute selectors.',
    '- For API attempts without explicit URL, include `path_template` or `candidate_key` to resolve via site profile.',
    '- Avoid fragile selectors like nth-child or positional card indices.',
    '- If network candidates exist, generate api_attempts before UI actions whenever possible.',
    '- Honor pilot-first safety for delete/cleanup intents: prepare one pilot action path before bulk writes.',
    `Desired action: ${desiredAction}`,
    `Target URL: ${url || 'unknown'}`,
    `Probe labels:\n${probeLabelLines}`,
    `Site profile labels:\n${siteLabelLines}`,
    `Site profile API candidates:\n${siteCandidateLines}`,
    `Network candidates:\n${networkCandidateLines}`,
    skillHints.length > 0 ? `Skill hints:\n${skillHints.map((item) => `- ${item}`).join('\n')}` : '',
    `User task:\n${userTask}`,
    `Discovery snapshot:\n${discoveryText}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

function resolveWalkthroughPlan(params: {
  existingPlan: ProbeWalkthroughPlan | null;
  userTask: string;
  desiredAction: string;
  url: string | null;
  discovery: Record<string, unknown> | null;
  existingLabels: Array<Record<string, unknown>>;
  profile: string;
  timeoutMs: number;
}): ProbeWalkthroughPlan {
  if (params.existingPlan && Array.isArray(params.existingPlan.steps) && params.existingPlan.steps.length > 0) {
    return {
      ...params.existingPlan,
      source: 'state',
      generated_at: asOptionalString(params.existingPlan.generated_at) || new Date().toISOString()
    };
  }

  const fallback = buildFallbackWalkthroughPlan({
    userTask: params.userTask,
    url: params.url
  });

  const prompt = buildWalkthroughPlanPrompt({
    userTask: params.userTask,
    desiredAction: params.desiredAction,
    url: params.url,
    discovery: params.discovery,
    existingLabels: params.existingLabels
  });
  try {
    const llm = runChatLlm({
      profile: params.profile,
      prompt,
      timeoutMs: params.timeoutMs
    });
    const parsed = parseJsonOutput(llm.text);
    const candidate = parseWalkthroughPlanValue(parsed, 'llm');
    if (candidate) {
      return candidate;
    }
  } catch {
    // fallback
  }
  return fallback;
}

function parsePlannerResult(raw: string): PlannerResult {
  const parsed = parseJsonOutput(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { actions: [], apiAttempts: [], needsUserStep: null, notes: null };
  }
  const validated = plannerPayloadSchema.safeParse(parsed);
  if (!validated.success) {
    return { actions: [], apiAttempts: [], needsUserStep: null, notes: null };
  }
  const row = validated.data as Record<string, unknown>;
  const mode = normalizeAction(row.mode || 'run_actions');
  const actions = parseActionSteps(row.actions);
  const apiAttempts = parseApiAttempts(row.api_attempts);
  const notes = asOptionalString(row.notes);
  const needsUserStep = mode === 'needs_user_step'
    ? asOptionalString(row.question) || 'Manual browser interaction is needed before automation can continue.'
    : null;
  return { actions, apiAttempts, needsUserStep, notes };
}

function resolveSkillHints(targetMeta: Record<string, unknown>): string[] {
  const hints: string[] = [];
  if (Array.isArray(targetMeta.skill_hints)) {
    for (const item of targetMeta.skill_hints) {
      const value = asOptionalString(item);
      if (value) {
        hints.push(value);
      }
    }
  }
  const single = asOptionalString(targetMeta.skill_hint);
  if (single) {
    hints.push(single);
  }
  const skillId = asOptionalString(targetMeta.skill);
  if (skillId) {
    hints.push(`Use installed skill '${skillId}' if available.`);
  }
  return Array.from(new Set(hints)).slice(0, 16);
}

function resolvePlannerTimeoutMs(targetMeta: Record<string, unknown>): number {
  const envDefault = toInt(
    process.env.PINOKIO_PLAYWRIGHT_PLAN_TIMEOUT_MS,
    15000,
    5000,
    120000
  );
  return toInt(targetMeta.plan_timeout_ms, envDefault, 5000, 120000);
}

function resolveKeepOpenAfterDiscoveryMs(params: {
  targetMeta: Record<string, unknown>;
  awaitUserCheckpointRequested: boolean;
  useUserContext: boolean;
  headless: boolean;
}): number {
  const explicit = params.targetMeta.keep_open_after_discovery_ms;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return toInt(explicit, 0, 0, 300000);
  }
  if (!params.awaitUserCheckpointRequested || !params.useUserContext || params.headless) {
    return 0;
  }
  return toInt(
    process.env.PINOKIO_PLAYWRIGHT_KEEP_OPEN_AFTER_DISCOVERY_MS,
    120000,
    0,
    300000
  );
}

function fallbackPlannerResult(params: {
  desiredAction: string;
  url: string | null;
  inferredAuthenticatedTask: boolean;
  authenticatedReady?: boolean;
}): PlannerResult {
  const { desiredAction, url, inferredAuthenticatedTask, authenticatedReady } = params;
  if (inferredAuthenticatedTask) {
    if (toBool(authenticatedReady, false)) {
      return {
        actions: parseActionSteps([
          { type: 'wait_for_selector', selector: 'body', timeout_ms: 8000 },
          { type: 'extract_text', selector: 'main' }
        ]),
        apiAttempts: [],
        notes:
          'Checkpoint is already satisfied. Running a read-only probe inventory first, then we can apply one pilot change.',
        needsUserStep: null
      };
    }
    return {
      actions: [],
      apiAttempts: [],
      notes:
        'Prepared a staged browser plan using timeout-safe fallback. We will inventory rules/folders first, then apply one pilot rule before any bulk changes.',
      needsUserStep: buildReadyCheckpointPrompt(url)
    };
  }
  return {
    actions: [],
    apiAttempts: [],
    notes:
      `Prepared a timeout-safe plan for ${url || 'the target site'}. Next step is discovery/read-only validation, then controlled actions.`,
    needsUserStep: null
  };
}

function looksLikeAuthenticatedDiscovery(params: {
  targetMeta: Record<string, unknown>;
  url: string | null;
  discovery: Record<string, unknown>;
  useUserContext: boolean;
  inferredAuthenticatedTask: boolean;
}): boolean {
  if (!params.useUserContext) {
    return true;
  }
  const expectedAuthTask =
    params.inferredAuthenticatedTask || toBool(params.targetMeta.authenticated_task, false);
  if (!expectedAuthTask) {
    return true;
  }

  const actualUrl = asOptionalString(params.discovery.url) || '';
  const actualHost = extractUrlHost(actualUrl);
  const expectedHost =
    asOptionalString(params.targetMeta.auth_expected_host) || extractUrlHost(params.url);
  const interactive = params.discovery.interactive && typeof params.discovery.interactive === 'object'
    ? (params.discovery.interactive as Record<string, unknown>)
    : null;
  const interactiveTotal = Number(interactive?.total || 0);

  if (!actualHost) {
    return false;
  }

  const hostMatchesExpected = expectedHost
    ? actualHost === expectedHost || actualHost.endsWith(`.${expectedHost}`)
    : true;
  const onMailPath = /\/mail(\/|$|\?)/i.test(actualUrl);

  if (hostMatchesExpected && onMailPath) {
    return true;
  }

  if (expectedHost?.includes('outlook.live.com') || expectedHost?.includes('outlook.com')) {
    if (actualHost.includes('outlook.live.com') && onMailPath) {
      return true;
    }
    if (actualHost.includes('microsoft.com')) {
      return false;
    }
  }

  if (hostMatchesExpected && interactiveTotal >= 25) {
    return true;
  }

  return false;
}

function buildAuthCheckpointMessage(params: {
  expectedUrl: string | null;
  discovery: Record<string, unknown>;
}): string {
  const { expectedUrl, discovery } = params;
  const actualUrl = asOptionalString(discovery.url);
  const actualHost = extractUrlHost(actualUrl);
  const checkpoint =
    discovery.user_checkpoint && typeof discovery.user_checkpoint === 'object' && !Array.isArray(discovery.user_checkpoint)
      ? (discovery.user_checkpoint as Record<string, unknown>)
      : null;
  const checkpointReason = asOptionalString(checkpoint?.reason);
  const waitedMs = Number(checkpoint?.waited_ms || 0);
  const waitedSeconds = Number.isFinite(waitedMs) && waitedMs > 0
    ? Math.max(1, Math.round(waitedMs / 1000))
    : null;
  const wrongPageHint =
    actualHost && actualHost.includes('microsoft.com')
      ? 'The automation browser is still on a Microsoft landing page, not your target workflow page.'
      : null;
  const timeoutHint =
    checkpointReason === 'timeout' && waitedSeconds
      ? `The last checkpoint timed out after ${waitedSeconds}s.`
      : null;
  const pageClosedHint =
    checkpointReason === 'page_closed'
      ? 'The automation browser window was closed before sign-in/checkpoint completed.'
      : null;
  const currentUrlHint = actualUrl ? `Current automation URL: ${actualUrl}.` : null;
  return [
    'Still waiting for sign-in in the automation browser context.',
    pageClosedHint,
    timeoutHint,
    wrongPageHint,
    `Keep the automation browser window open, sign in until the target workflow page is visible at ${expectedUrl || 'the target site'}, then click READY in the injected panel (or reply "READY") again.`,
    currentUrlHint
  ]
    .filter(Boolean)
    .join(' ');
}

function inferCleanupIntent(params: {
  userTask: string;
  desiredAction: string;
  targetMeta: Record<string, unknown>;
}): boolean {
  if (toBool(params.targetMeta.cleanup_intent, false)) {
    return true;
  }
  const lower = String(params.userTask || '').toLowerCase();
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
  return params.desiredAction === 'delete' && messagingContext;
}

function hasCleanupPolicyDetails(params: {
  userTask: string;
  targetMeta: Record<string, unknown>;
}): boolean {
  if (toBool(params.targetMeta.cleanup_policy_provided, false)) {
    return true;
  }
  const policyText = asOptionalString(params.targetMeta.cleanup_policy_text);
  if (policyText && policyText.length >= 10) {
    return true;
  }
  const lower = String(params.userTask || '').toLowerCase();
  if (!lower.trim()) {
    return false;
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
  return policySignals.some((re) => re.test(lower));
}

function buildCleanupClarificationMessage(url: string | null): string {
  return [
    'Before I run cleanup actions, confirm your policy so I do not remove important messages.',
    'Reply with: 1) what counts as junk, 2) delete vs archive behavior, 3) time/scope (for example older than X days), 4) protected senders/folders.',
    `After you reply, I will run a read-only preview first on ${url || 'the target site'} before any mutation.`
  ].join(' ');
}

function buildCleanupTrainingPrompt(url: string | null): string {
  return [
    `Now teach me your cleanup behavior directly on ${url || 'the target site'} before bulk automation.`,
    'In the automation browser, do 3 quick examples: 1) mark one obvious junk/sales email, 2) keep one important email, 3) delete or archive one message exactly how you want it handled.',
    'Use the injected panel buttons to mark each example (JUNK DONE, KEEP DONE, MUTATION DONE).',
    'When done, click READY in the injected panel (or reply "READY"). I will learn from that probe and generate safe candidates.'
  ].join(' ');
}

function encodeCleanupTrainingNeed(message: string): string {
  return `${CLEANUP_TRAINING_SENTINEL} ${message}`;
}

function decodeCleanupTrainingNeed(value: string | null): string | null {
  const raw = asOptionalString(value);
  if (!raw) {
    return null;
  }
  if (!raw.startsWith(CLEANUP_TRAINING_SENTINEL)) {
    return raw;
  }
  return raw.slice(CLEANUP_TRAINING_SENTINEL.length).trim();
}

function hasPendingCleanupTraining(value: string | null): boolean {
  const raw = asOptionalString(value);
  return Boolean(raw && raw.startsWith(CLEANUP_TRAINING_SENTINEL));
}

function buildCleanupTrainingCapturedMessage(url: string | null, discovery: Record<string, unknown>): string {
  const actionEvents = extractProbeActionEvents(discovery);
  const totalActionEvents = actionEvents.length;
  const trainingState = extractProbeTrainingState(discovery);
  const networkSummary = extractNetworkSummary(discovery);
  const candidateCount = Array.isArray(networkSummary.candidates) ? networkSummary.candidates.length : 0;
  const apiLikeEvents = Number(networkSummary.api_like_events || 0);
  const trainingSummary = trainingState
    ? `Training checklist: junk=${toBool(trainingState.junk_done, false) ? 'done' : 'pending'}, keep=${toBool(trainingState.keep_done, false) ? 'done' : 'pending'}, mutation=${toBool(trainingState.mutate_done, false) ? 'done' : 'pending'}.`
    : null;
  const recentTypes = actionEvents
    .slice(-4)
    .map((event) => asOptionalString(event.type) || 'event')
    .filter(Boolean);
  const typeSummary =
    recentTypes.length > 0
      ? `Recent probe events: ${Array.from(new Set(recentTypes)).join(', ')}.`
      : 'No explicit overlay events were captured, but network/DOM probe data is available.';
  return [
    `Training probe captured on ${url || 'the target site'}.`,
    `Captured ${totalActionEvents} probe events, ${Number.isFinite(apiLikeEvents) ? apiLikeEvents : 0} API-like requests, and ${candidateCount} candidate endpoints.`,
    trainingSummary,
    typeSummary,
    'Reply "SHOW CANDIDATES" to inspect mappings, or "PILOT ARCHIVE 1"/"PILOT DELETE 1" to run one safe pilot action.'
  ].join(' ');
}

function buildProbeFollowupMessage(url: string | null): string {
  return [
    'Probe mode is active.',
    'Tell me the exact outcome you want, what to keep/protect, and any risky actions to avoid.',
    `I will keep discovery first on ${url || 'the target site'} and only plan safe next steps before writes.`
  ].join(' ');
}

function buildSuggestedPrompts(params: {
  url: string | null;
  discovery?: Record<string, unknown> | null;
}): Array<Record<string, unknown>> {
  const prompts: Array<Record<string, unknown>> = [];
  const labels = params.discovery ? extractProbeLabels(params.discovery) : [];
  const overlayActive = params.discovery ? toBool(params.discovery.probe_overlay_active, false) : false;

  prompts.push({
    id: 'show_candidates',
    label: 'Show API Candidates',
    prompt: 'SHOW CANDIDATES',
    description: 'Preview network/API candidates before any writes.'
  });

  if (!overlayActive) {
    prompts.push({
      id: 'enable_label_mode',
      label: 'Enable Label Mode',
      prompt: `Enable label mode on ${params.url || 'this site'} and let me tag fields`,
      description: 'Inject click-to-label overlay for reusable selectors.'
    });
  }

  if (labels.length > 0) {
    prompts.push({
      id: 'use_saved_labels',
      label: 'Use Saved Labels',
      prompt: 'Use my saved labels and continue with the plan',
      description: 'Prioritize labeled selectors in this workflow.'
    });
  }

  if (params.discovery) {
    prompts.push({
      id: 'save_probe_skill',
      label: 'Save Probe as Skill',
      prompt: 'convert this probe to a skill',
      description: 'Create a reusable skill from this probe flow.'
    });
    prompts.push({
      id: 'resume_workflow',
      label: 'Resume Workflow',
      prompt: 'continue browser automation workflow',
      description: 'Continue the current browser workflow in this chat channel.'
    });
    prompts.push({
      id: 'cancel_workflow',
      label: 'Cancel Workflow',
      prompt: 'cancel browser automation workflow',
      description: 'Stop and reset the active browser workflow.'
    });
  }

  return prompts.slice(0, 6);
}

function buildNotifyActionFromPrompt(
  prompt: Record<string, unknown>,
  fallbackUrl: string | null,
  index: number
): Record<string, unknown> | null {
  const label = asOptionalString(prompt.label) || asOptionalString(prompt.title);
  const actionPrompt = asOptionalString(prompt.prompt) || asOptionalString(prompt.command);
  if (!label || !actionPrompt) {
    return null;
  }
  const rawId = asOptionalString(prompt.id) || `${label}_${index + 1}`;
  const id = String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || `action_${index + 1}`;
  return {
    id,
    label: notificationText(label, 56),
    prompt: notificationText(actionPrompt, 400),
    url: asOptionalString(prompt.url) || fallbackUrl || '/ui/chat'
  };
}

function buildNotifyAction(
  id: string,
  label: string,
  prompt: string,
  url: string | null
): Record<string, unknown> {
  const normalizedId = String(id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'action';
  return {
    id: normalizedId,
    label: notificationText(label, 56),
    prompt: notificationText(prompt, 400),
    url: url || '/ui/chat'
  };
}

function buildDefaultNotifyActions(title: string, url: string | null): Array<Record<string, unknown>> {
  const lower = String(title || '').toLowerCase();
  const actions: Array<Record<string, unknown>> = [];
  if (lower.includes('checkpoint') || lower.includes('browser action') || lower.includes('user input')) {
    actions.push(buildNotifyAction('ready', 'Send READY', 'READY', url));
  }
  if (lower.includes('cleanup') || lower.includes('pilot')) {
    actions.push(buildNotifyAction('show_candidates', 'Show Candidates', 'SHOW CANDIDATES', url));
  }
  actions.push(
    buildNotifyAction(
      'cancel_browser_workflow',
      'Cancel Workflow',
      'cancel browser automation workflow',
      url
    )
  );
  return actions;
}

function buildNotifyPayload(
  title: string,
  message: string,
  options: {
    url?: string | null;
    suggestedPrompts?: Array<Record<string, unknown>>;
    prompt?: string | null;
  } = {}
): Record<string, unknown> {
  const suggestedPrompts = Array.isArray(options.suggestedPrompts) ? options.suggestedPrompts : [];
  const actions = suggestedPrompts
    .slice(0, 2)
    .map((item, index) => buildNotifyActionFromPrompt(item, options.url || null, index))
    .filter((item): item is Record<string, unknown> => item !== null);
  const defaultActions = buildDefaultNotifyActions(title, options.url || null);
  const seenActionIds = new Set(
    actions.map((action) => String(action.id || '').trim().toLowerCase()).filter(Boolean)
  );
  for (const item of defaultActions) {
    if (actions.length >= 2) {
      break;
    }
    const key = String(item.id || '').trim().toLowerCase();
    if (key && seenActionIds.has(key)) {
      continue;
    }
    if (key) {
      seenActionIds.add(key);
    }
    actions.push(item);
  }
  const directPrompt = asOptionalString(options.prompt) || asOptionalString((actions[0] || {}).prompt);
  return {
    source: 'playwright_read_agent',
    level: 'action_required',
    title: notificationText(title, 96),
    body: notificationText(message, 220),
    tag: 'pinokio-playwright-action',
    url: options.url || '/ui/chat',
    prompt: directPrompt || undefined,
    actions: actions.length > 0 ? actions : undefined
  };
}

function isReadyFollowupMessage(message: string): boolean {
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

function hasCleanupExecutionApproval(params: {
  userTask: string;
  targetMeta: Record<string, unknown>;
}): boolean {
  if (toBool(params.targetMeta.cleanup_execution_approved, false)) {
    return true;
  }
  const lower = String(params.userTask || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  if (/\bpilot\s+(delete|archive)\b/.test(lower)) {
    return true;
  }
  return (
    /\b(approve|approved|go ahead|proceed|run it|execute|do it)\b/.test(lower) &&
    /\b(cleanup|clean up|delete|archive|junk|spam|message|messages|email|emails|inbox)\b/.test(lower)
  );
}

function hasCleanupPreviewRequest(params: {
  userTask: string;
  targetMeta: Record<string, unknown>;
}): boolean {
  if (toBool(params.targetMeta.cleanup_preview_requested, false)) {
    return true;
  }
  const lower = String(params.userTask || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  return (
    /\bshow\s+(?:api|network)\s+candidates\b/.test(lower) ||
    /\bshow\s+candidates\b/.test(lower) ||
    /\bpreview\s+(?:candidates|cleanup)\b/.test(lower)
  );
}

function buildCleanupCandidatePreviewMessage(url: string | null, discovery: Record<string, unknown>): string {
  const networkSummary = extractNetworkSummary(discovery);
  const candidates = Array.isArray(networkSummary.candidates)
    ? networkSummary.candidates
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 5) as Array<Record<string, unknown>>
    : [];
  if (candidates.length === 0) {
    return [
      `No strong API/network candidates were detected on ${url || 'the target site'} yet.`,
      'Click READY in the injected panel (or reply "READY") to re-probe after navigating to the exact mailbox/workflow screen, or continue with a pilot command.'
    ].join(' ');
  }
  const lines = candidates.map((candidate, index) => `${index + 1}. ${summarizeNetworkCandidate(candidate)}`);
  return [
    `Top network/API candidates on ${url || 'the target site'}:`,
    lines.join(' '),
    'Reply with "PILOT ARCHIVE 1" or "PILOT DELETE 1" when you want to execute a single safe pilot action.'
  ].join(' ');
}

function buildCleanupExecutionApprovalMessage(url: string | null, discovery: Record<string, unknown>): string {
  const interactive =
    discovery.interactive && typeof discovery.interactive === 'object' && !Array.isArray(discovery.interactive)
      ? (discovery.interactive as Record<string, unknown>)
      : {};
  const networkEvents = Array.isArray(discovery.network_events) ? discovery.network_events : [];
  const totalInteractive = Number(interactive.total || 0);
  const sampledNetwork = networkEvents.length;
  return [
    `Probe complete on ${url || 'the target site'} (${Number.isFinite(totalInteractive) ? totalInteractive : 0} interactive elements, ${sampledNetwork} network events captured).`,
    'Before broad cleanup, approve one pilot action so we verify behavior safely.',
    'Reply with one of: "PILOT ARCHIVE 1", "PILOT DELETE 1", or "SHOW CANDIDATES".'
  ].join(' ');
}

function shouldSendUserNotification(targetMeta: Record<string, unknown>): boolean {
  if (targetMeta.notify_user !== undefined) {
    return toBool(targetMeta.notify_user, true);
  }
  return toBool(process.env.PINOKIO_OS_NOTIFICATIONS_ENABLED, false);
}

function notificationText(value: string, max: number = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function notifyUser(title: string, message: string): void {
  const safeTitle = notificationText(title, 96);
  const safeMessage = notificationText(message, 220);
  if (!safeTitle || !safeMessage) {
    return;
  }
  try {
    if (process.platform === 'darwin') {
      const esc = (input: string) =>
        input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      spawnSync('osascript', ['-e', `display notification "${esc(safeMessage)}" with title "${esc(safeTitle)}"`], {
        encoding: 'utf8',
        env: process.env,
        timeout: 3000
      });
      return;
    }
    if (process.platform === 'linux') {
      spawnSync('notify-send', [safeTitle, safeMessage], {
        encoding: 'utf8',
        env: process.env,
        timeout: 3000
      });
      return;
    }
    if (process.platform === 'win32') {
      const psTitle = safeTitle.replace(/'/g, "''");
      const psMessage = safeMessage.replace(/'/g, "''");
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$wshell = New-Object -ComObject WScript.Shell; $null = $wshell.Popup('${psMessage}', 8, '${psTitle}', 64);`
        ],
        {
          encoding: 'utf8',
          env: process.env,
          timeout: 5000
        }
      );
    }
  } catch {
    // Best-effort notifications only.
  }
}

function sanitizeStateToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
}

function resolveStateBaseDirs(): string[] {
  const childHome = asOptionalString(process.env.PINOKIO_CHILD_HOME);
  const candidates = [
    asOptionalString(process.env.PINOKIO_CHAT_STATE_DIR),
    asOptionalString(process.env.PINOKIO_SOCKET_BUS_DIR),
    asOptionalString(process.env.PINOKIO_STATE_DIR),
    childHome ? path.join(childHome, 'state') : null,
    '/var/lib/pinokio-agent/state',
    '/app/.pinokio-agent/state',
    '/tmp'
  ].filter(Boolean) as string[];
  return Array.from(new Set(candidates));
}

function resolveProbeStatePaths(channel: string): string[] {
  const stateFile = `playwright_probe_${sanitizeStateToken(channel)}.json`;
  return resolveStateBaseDirs().map((baseDir) => path.join(baseDir, stateFile));
}

function resolveSiteProfilePaths(host: string): string[] {
  const safeHost = sanitizeStateToken(host || 'unknown');
  const fileName = `playwright_site_profile_${safeHost}.json`;
  return resolveStateBaseDirs().map((baseDir) => path.join(baseDir, fileName));
}

function readProbeStateFromPath(statePath: string): ProbeState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const channel = asOptionalString(row.channel) || 'default';
    const updated = asOptionalString(row.updated_at) || new Date().toISOString();
    const state: ProbeState = {
      channel,
      updated_at: updated
    };
    const taskSummary = asOptionalString(row.task_summary);
    const desiredAction = asOptionalString(row.desired_action);
    const url = asOptionalString(row.url);
    if (taskSummary) {
      state.task_summary = taskSummary;
    }
    if (desiredAction) {
      state.desired_action = desiredAction;
    }
    if (url) {
      state.url = url;
    }
    state.checkpoint_satisfied = toBool(row.checkpoint_satisfied, false);
    state.checkpoint_awaited = toBool(row.checkpoint_awaited, false);
    state.checkpoint_reason = asOptionalString(row.checkpoint_reason);
    const checkpointWaitedMs = Number(row.checkpoint_waited_ms);
    if (Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0) {
      state.checkpoint_waited_ms = Math.trunc(checkpointWaitedMs);
    }
    if (row.discovery && typeof row.discovery === 'object' && !Array.isArray(row.discovery)) {
      state.discovery = row.discovery as Record<string, unknown>;
    }
    state.planner_actions = parseActionSteps(row.planner_actions);
    state.planner_api_attempts = parseApiAttempts(row.planner_api_attempts);
    state.planner_notes = asOptionalString(row.planner_notes);
    state.needs_user_step = asOptionalString(row.needs_user_step);
    state.walkthrough_plan = parseWalkthroughPlanValue(row.walkthrough_plan, 'state');
    state.workflow_state = asOptionalString(row.workflow_state);
    state.workflow_pending_step = asOptionalString(row.workflow_pending_step);
    state.workflow_last_transition = asOptionalString(row.workflow_last_transition);
    state.workflow_last_error = asOptionalString(row.workflow_last_error);
    state.site_profile_host = asOptionalString(row.site_profile_host);
    return state;
  } catch {
    return null;
  }
}

function readSiteProfileFromPath(statePath: string): SiteProfile | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const host = sanitizeStateToken(asOptionalString((parsed as Record<string, unknown>).host) || '');
    if (!host) {
      return null;
    }
    const labels = Array.isArray((parsed as Record<string, unknown>).labels)
      ? extractSiteProfileLabels(
          ((parsed as Record<string, unknown>).labels as unknown[])
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
            .map((item) => item as Record<string, unknown>)
        )
      : [];
    const networkCandidates = Array.isArray((parsed as Record<string, unknown>).network_candidates)
      ? extractSiteProfileNetworkCandidates(
          ((parsed as Record<string, unknown>).network_candidates as unknown[])
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
            .map((item) => item as Record<string, unknown>)
        )
      : [];
    return mergeSiteProfile(host, null, {
      labels,
      network_candidates: networkCandidates,
      mark_success: false
    });
  } catch {
    return null;
  }
}

function loadProbeState(channel: string): ProbeState | null {
  for (const statePath of resolveProbeStatePaths(channel)) {
    const parsed = readProbeStateFromPath(statePath);
    if (parsed) {
      return parsed;
    }
  }
  if (channel !== 'default') {
    for (const statePath of resolveProbeStatePaths('default')) {
      const parsed = readProbeStateFromPath(statePath);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function loadSiteProfile(host: string | null): SiteProfile | null {
  const normalizedHost = sanitizeStateToken(host || '');
  if (!normalizedHost) {
    return null;
  }
  for (const statePath of resolveSiteProfilePaths(normalizedHost)) {
    const parsed = readSiteProfileFromPath(statePath);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function writeProbeState(channel: string, state: ProbeState): boolean {
  for (const statePath of resolveProbeStatePaths(channel)) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state), { encoding: 'utf8', flag: 'w' });
      return true;
    } catch {
      // try next path
    }
  }
  return false;
}

function writeSiteProfile(host: string, profile: SiteProfile): boolean {
  const normalizedHost = sanitizeStateToken(host || '');
  if (!normalizedHost) {
    return false;
  }
  for (const statePath of resolveSiteProfilePaths(normalizedHost)) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(profile), { encoding: 'utf8', flag: 'w' });
      return true;
    } catch {
      // try next path
    }
  }
  return false;
}

function persistSiteProfile(host: string, existing: SiteProfile | null, patch: {
  labels?: ReturnType<typeof extractSiteProfileLabels>;
  network_candidates?: ReturnType<typeof extractSiteProfileNetworkCandidates>;
  mark_success?: boolean;
}): SiteProfile {
  const merged = mergeSiteProfile(host, existing, patch);
  writeSiteProfile(host, merged);
  return merged;
}

function persistProbeState(channel: string, existing: ProbeState | null, patch: Partial<ProbeState>): ProbeState {
  const merged: ProbeState = {
    ...(existing || { channel, updated_at: new Date().toISOString() }),
    ...patch,
    channel,
    updated_at: new Date().toISOString()
  };
  writeProbeState(channel, merged);
  if (channel !== 'default') {
    writeProbeState('default', merged);
  }
  return merged;
}

function hostMatchesForCheckpoint(stateUrl: string | null, requestedUrl: string | null): boolean {
  const stateHost = extractUrlHost(stateUrl || '');
  const requestedHost = extractUrlHost(requestedUrl || '');
  if (!stateHost || !requestedHost) {
    return true;
  }
  return (
    stateHost === requestedHost ||
    stateHost.endsWith(`.${requestedHost}`) ||
    requestedHost.endsWith(`.${stateHost}`)
  );
}

function checkpointReadyForUrl(state: ProbeState | null, requestedUrl: string | null): boolean {
  if (!state || !toBool(state.checkpoint_satisfied, false)) {
    return false;
  }
  return hostMatchesForCheckpoint(state.url || null, requestedUrl);
}

function buildReadyCheckpointPrompt(url: string | null): string {
  return `Reply "READY" and I will open an automation browser for ${url || 'the target site'}. Complete login/MFA/CAPTCHA in that automation window, wait until the target workflow page is open, then click READY in the injected panel (or reply "READY") again.`;
}

function looksLikeProbeSkillExportMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase();
  if (!lower.trim() || !lower.includes('skill')) {
    return false;
  }
  return (
    /\b(convert|save|turn|make|export|create|generate|publish)\b/.test(lower) &&
    /\b(skill|workflow)\b/.test(lower)
  );
}

function normalizeSkillName(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80);
}

function inferSkillNameFromTask(url: string | null, task: string): string {
  const host = extractUrlHost(url || '') || 'browser';
  const hostSlug = host
    .replace(/[^a-z0-9]+/gi, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
  const words = String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/g)
    .filter((word) => word.length >= 3 && word.length <= 12)
    .slice(0, 3);
  const suffix = words.length > 0 ? words.join('.') : 'workflow';
  return normalizeSkillName(`playwright.${hostSlug}.${suffix}`) || 'playwright.generated.workflow';
}

function summarizeProbeDiscovery(discovery: Record<string, unknown> | undefined): string[] {
  if (!discovery) {
    return ['No discovery snapshot was available.'];
  }
  const title = asOptionalString(discovery.title);
  const currentUrl = asOptionalString(discovery.url);
  const interactive = discovery.interactive && typeof discovery.interactive === 'object' && !Array.isArray(discovery.interactive)
    ? (discovery.interactive as Record<string, unknown>)
    : null;
  const network = extractNetworkSummary(discovery);
  const candidates = Array.isArray(network.candidates)
    ? network.candidates
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, 3) as Array<Record<string, unknown>>
    : [];
  const probeLabels = extractProbeLabels(discovery);
  const total = interactive ? Number(interactive.total || 0) : 0;
  const requests = Number(network.total_events || 0);
  const apiLike = Number(network.api_like_events || 0);
  const lines: string[] = [];
  if (title) {
    lines.push(`- Page title: ${title}`);
  }
  if (currentUrl) {
    lines.push(`- Observed URL: ${currentUrl}`);
  }
  lines.push(`- Interactive elements discovered: ${Number.isFinite(total) ? total : 0}`);
  lines.push(`- Network events captured: ${Number.isFinite(requests) ? requests : 0}`);
  lines.push(`- API-like network events: ${Number.isFinite(apiLike) ? apiLike : 0}`);
  lines.push(`- Saved probe labels: ${probeLabels.length}`);
  if (candidates.length > 0) {
    lines.push(`- Top network candidate: ${summarizeNetworkCandidate(candidates[0])}`);
  }
  return lines;
}

function buildProbeSkillMarkdown(input: ProbeSkillBuildInput): string {
  const discoveryLines = summarizeProbeDiscovery(input.state.discovery);
  const apiAttempts = Array.isArray(input.state.planner_api_attempts)
    ? input.state.planner_api_attempts.slice(0, 20)
    : [];
  const actionSteps = Array.isArray(input.state.planner_actions)
    ? input.state.planner_actions.slice(0, 48)
    : [];
  const apiJson = apiAttempts.length > 0 ? JSON.stringify(apiAttempts, null, 2) : '[]';
  const actionsJson = actionSteps.length > 0 ? JSON.stringify(actionSteps, null, 2) : '[]';
  const note = asOptionalString(input.state.planner_notes) || 'Use discovery each run to validate selectors/API before writing.';
  const taskSummary = asOptionalString(input.state.task_summary) || input.description;
  return [
    `# ${input.skillName}`,
    '',
    input.description,
    '',
    '## Intent',
    `- Goal: ${taskSummary}`,
    `- Target URL: ${input.url || input.state.url || 'unknown'}`,
    `- Desired action: ${input.state.desired_action || 'update'}`,
    '',
    '## Probe Snapshot',
    ...discoveryLines,
    '',
    '## Operator Flow',
    '1. Run `plugin:playwright_read_agent` discovery first.',
    '2. Validate API/session path before UI clicks.',
    '3. If auth/CAPTCHA appears, request user checkpoint and continue.',
    '4. Execute mutations only via `plugin:playwright_write_agent`.',
    '',
    '## Candidate API Attempts',
    '```json',
    apiJson,
    '```',
    '',
    '## Candidate UI Actions',
    '```json',
    actionsJson,
    '```',
    '',
    '## Notes',
    `- ${note}`,
    '- Keep this skill scoped to browser automation only.',
    '- Re-probe selectors whenever the target UI changes.',
    '',
    '## Safety',
    '- Never bypass the read->write split.',
    '- Require explicit confirmation for destructive operations.',
    '- Avoid arbitrary evaluate code unless unsafe mode is explicitly enabled.'
  ].join('\n');
}

function resolveGeneratedSkillDir(): string {
  return (
    asOptionalString(process.env.PINOKIO_PLAYWRIGHT_SKILL_DIR) ||
    path.join(process.cwd(), 'plugins', 'skills', 'playwright', 'generated')
  );
}

function writeProbeSkillFile(skillName: string, content: string): string {
  const outDir = resolveGeneratedSkillDir();
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `${skillName.replace(/[^a-z0-9_.-]+/gi, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '')}.md`;
  const fullPath = path.join(outDir, fileName || 'playwright.generated.workflow.md');
  fs.writeFileSync(fullPath, content, { encoding: 'utf8', flag: 'w' });
  return fullPath;
}

function runSkillRegistration(params: {
  name: string;
  description: string;
  skillPath: string;
}): SkillRegistrationResult {
  const agentBin = resolveAgentBinary();
  const args = [
    'configure',
    'skill-add',
    '--name',
    params.name,
    '--description',
    params.description,
    '--path',
    params.skillPath,
    '--plugin',
    'pinokio.playwright',
    '--resource',
    'plugin:playwright_agent',
    '--resource',
    'plugin:playwright_read_agent',
    '--resource',
    'plugin:playwright_write_agent',
    '--agent',
    'plugin:playwright_read_agent',
    '--agent',
    'plugin:playwright_write_agent',
    '--action',
    'read',
    '--action',
    'update',
    '--action',
    'create',
    '--action',
    'delete',
    '--tag',
    'playwright',
    '--tag',
    'probe'
  ];
  const command = `${agentBin} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`;
  const out = spawnSync(agentBin, args, {
    encoding: 'utf8',
    env: process.env,
    timeout: 30000,
    maxBuffer: 1024 * 1024 * 4
  });
  if (out.error) {
    return {
      ok: false,
      command,
      detail: out.error.message
    };
  }
  if (out.status !== 0) {
    return {
      ok: false,
      command,
      detail: String(out.stderr || out.stdout || `exit ${out.status}`).trim()
    };
  }
  return {
    ok: true,
    command,
    detail: String(out.stdout || 'registered').trim()
  };
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  const action = normalizeAction(request.action);
  if (!SUPPORTED_ACTIONS.has(action)) {
    fail(`playwright_read_agent only supports action 'read' (got '${action}')`);
  }

  const targetMeta = parseTargetMeta(request.target);
  const userTask = asOptionalString(request.summary) || asOptionalString(targetMeta.task_summary) || '';
  const desiredAction = resolveDesiredAction(request, targetMeta);
  const mutate = toBool(targetMeta.mutate, false) || desiredAction !== 'read';
  const url = resolveTargetUrl(request, targetMeta);
  const timeoutMs = toInt(targetMeta.timeout_ms, 45000, 1000, 300000);
  const channel = asOptionalString(targetMeta.channel) || 'default';
  const responseFormat = asOptionalString(targetMeta.response_format) || 'text';
  const useStealth = toBool(targetMeta.use_stealth, true);
  const targetHost = extractUrlHost(url || '') || null;
  let siteProfile = loadSiteProfile(targetHost);
  let probeState = loadProbeState(channel);
  const stateHostMismatch =
    Boolean(probeState) &&
    Boolean(url) &&
    !hostMatchesForCheckpoint(probeState?.url || null, url || null);
  if (stateHostMismatch) {
    probeState = persistProbeState(channel, probeState, {
      url: url || null,
      checkpoint_satisfied: false,
      checkpoint_awaited: false,
      checkpoint_reason: null,
      checkpoint_waited_ms: 0,
      discovery: undefined,
      planner_actions: [],
      planner_api_attempts: [],
      planner_notes: null,
      needs_user_step: null,
      walkthrough_plan: null,
      workflow_state: null,
      workflow_pending_step: null,
      workflow_last_transition: null,
      workflow_last_error: null
    });
  }
  const priorNeedsUserStepRaw = asOptionalString(probeState?.needs_user_step);
  const cleanupTrainingPending = hasPendingCleanupTraining(priorNeedsUserStepRaw);
  const readyFollowup = isReadyFollowupMessage(userTask);
  const effectiveUserTask =
    readyFollowup && asOptionalString(probeState?.task_summary)
      ? (asOptionalString(probeState?.task_summary) || userTask)
      : userTask;
  const policy = resolvePlaywrightExecutionPolicy({
    targetMeta,
    url,
    message: effectiveUserTask
  });
  const useUserContext = policy.useUserContext;
  const headless = policy.headless;
  const captureScreenshot = toBool(targetMeta.capture_screenshot, true);
  const autoInstallChromium = toBool(targetMeta.auto_install_chromium, true);
  const autoInstallDeps = toBool(targetMeta.auto_install_deps, true);
  const installCommand = asOptionalString(targetMeta.install_command);
  const installDepsCommand = asOptionalString(targetMeta.install_deps_command);
  const explicitUserDataDir = asOptionalString(targetMeta.user_data_dir);
  const userDataDir =
    useUserContext
      ? explicitUserDataDir || policy.userDataDir
      : null;
  const planOnly = toBool(targetMeta.plan_only, false);
  const plannerTimeoutMs = resolvePlannerTimeoutMs(targetMeta);
  const requestedProfile =
    (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
    (asOptionalString(targetMeta.profile) || 'codex');
  const probeMode = toBool(targetMeta.probe_mode, true);
  const probeOverlayEnabled = toBool(targetMeta.probe_overlay_enabled, true);
  const probeOverlayAutoActivateRequested = toBool(targetMeta.probe_overlay_auto_activate, false);
  const probeOverlayReset = toBool(targetMeta.probe_overlay_reset, false);
  const probeConvertToSkill =
    toBool(targetMeta.probe_convert_to_skill, false) ||
    looksLikeProbeSkillExportMessage(userTask);
  const probeAutoRegisterSkill = toBool(targetMeta.probe_auto_register_skill, true);
  const requestedProbeSkillName = normalizeSkillName(asOptionalString(targetMeta.probe_skill_name) || '');
  const awaitUserCheckpointRequested = toBool(targetMeta.await_user_checkpoint, false);
  const keepOpenAfterDiscoveryMs = resolveKeepOpenAfterDiscoveryMs({
    targetMeta,
    awaitUserCheckpointRequested,
    useUserContext,
    headless
  });
  const nonBlockingKeepOpen =
    keepOpenAfterDiscoveryMs > 0 &&
    awaitUserCheckpointRequested &&
    useUserContext &&
    !headless;
  const serviceTimeoutMs =
    timeoutMs +
    (nonBlockingKeepOpen ? 0 : keepOpenAfterDiscoveryMs) +
    (autoInstallChromium || autoInstallDeps ? 900000 : 10000);
  const probeOverlayAutoActivate = probeOverlayAutoActivateRequested && !awaitUserCheckpointRequested;
  const checkpointReady = checkpointReadyForUrl(probeState, url);
  const cleanupIntentEarly = inferCleanupIntent({
    userTask: effectiveUserTask,
    desiredAction,
    targetMeta
  });
  const cleanupPolicyProvidedEarly = hasCleanupPolicyDetails({
    userTask: effectiveUserTask,
    targetMeta
  });
  const cleanupExecutionApprovedEarly = hasCleanupExecutionApproval({
    userTask: effectiveUserTask,
    targetMeta
  });
  const hasExplicitPlanHints =
    parseActionSteps(targetMeta.actions).length > 0 ||
    parseApiAttempts(targetMeta.api_attempts).length > 0;
  const genericWalkthroughNeededEarly =
    mutate &&
    !cleanupIntentEarly &&
    !hasExplicitPlanHints &&
    policy.inferredAuthenticatedTask;
  const walkthroughRequestedEarly =
    !planOnly &&
    probeMode &&
    (
      toBool(targetMeta.walkthrough_mode, false) ||
      genericWalkthroughNeededEarly ||
      (
        mutate &&
        cleanupIntentEarly &&
        cleanupPolicyProvidedEarly &&
        !cleanupExecutionApprovedEarly
      )
    );
  const probeTrainingModeRequested =
    mutate &&
    (
      cleanupTrainingPending ||
      (
        cleanupIntentEarly &&
        cleanupPolicyProvidedEarly &&
        !cleanupExecutionApprovedEarly
      )
    );
  let activeWalkthroughPlan: ProbeWalkthroughPlan | null = parseWalkthroughPlanValue(
    probeState?.walkthrough_plan || null,
    'state'
  );
  if (walkthroughRequestedEarly) {
    activeWalkthroughPlan = resolveWalkthroughPlan({
      existingPlan: activeWalkthroughPlan,
      userTask: effectiveUserTask,
      desiredAction,
      url,
      discovery:
        probeState?.discovery && typeof probeState.discovery === 'object'
          ? probeState.discovery
          : null,
      existingLabels:
        probeState?.discovery && typeof probeState.discovery === 'object'
          ? extractProbeLabels(probeState.discovery)
          : [],
      profile: requestedProfile,
      timeoutMs: plannerTimeoutMs
    });
    probeState = persistProbeState(channel, probeState, {
      walkthrough_plan: activeWalkthroughPlan
    });
  }

  const telemetryFor = (params: {
    mode: string;
    discovery?: Record<string, unknown> | null;
    needsUserStep?: string | null;
    lastError?: string | null;
  }): WorkflowTelemetry =>
    buildWorkflowTelemetry({
      mode: params.mode,
      discovery: params.discovery || null,
      needsUserStep: params.needsUserStep || null,
      lastError: params.lastError || null
    });

  const showNetworkCandidatesRequested = toBool(targetMeta.show_network_candidates, false);
  const useSavedLabelsRequested = toBool(targetMeta.use_saved_labels, false);
  if (showNetworkCandidatesRequested || useSavedLabelsRequested) {
    const cachedDiscovery =
      probeState?.discovery && typeof probeState.discovery === 'object' && !Array.isArray(probeState.discovery)
        ? (probeState.discovery as Record<string, unknown>)
        : {};
    const cachedUrl =
      asOptionalString(cachedDiscovery.url) ||
      url ||
      asOptionalString(probeState?.url) ||
      null;
    const mergedLabels = dedupeProbeLabels([
      ...extractProbeLabels(cachedDiscovery),
      ...mapSiteProfileLabelsToProbeLabels(siteProfile, cachedUrl)
    ]);
    const mergedCandidates = dedupeNetworkCandidates([
      ...extractDiscoveryNetworkCandidates(cachedDiscovery),
      ...mapSiteProfileNetworkCandidatesToDiscovery(siteProfile)
    ]);
    const existingNetworkSummary = extractNetworkSummary(cachedDiscovery);
    const cachedApiLikeEvents = Number(existingNetworkSummary.api_like_events || 0);
    const syntheticDiscovery: Record<string, unknown> = {
      ...cachedDiscovery,
      url: cachedUrl,
      title: asOptionalString(cachedDiscovery.title) || 'Cached Discovery',
      probe_labels: mergedLabels,
      network_summary: {
        ...existingNetworkSummary,
        api_like_events: Math.max(cachedApiLikeEvents, mergedCandidates.length),
        candidates: mergedCandidates
      }
    };
    const needsReadyStep =
      mergedLabels.length === 0 && mergedCandidates.length === 0
        ? 'No saved candidates yet for this site. Open the exact workflow page, complete login if needed, then reply "READY".'
        : null;
    const telemetry = telemetryFor({
      mode: needsReadyStep ? 'discovery_needs_user' : 'discover',
      discovery: syntheticDiscovery,
      needsUserStep: needsReadyStep
    });
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: cachedUrl,
        discovery: syntheticDiscovery,
        needs_user_step: needsReadyStep,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    const uiBlocksBase =
      responseFormat === 'ui_blocks' || channel.includes('ui')
        ? buildUiBlocks(syntheticDiscovery, desiredAction)
        : [];
    const uiBlocks = withWorkflowTelemetryBlocks(uiBlocksBase, telemetry);
    const suggestedPrompts = buildSuggestedPrompts({
      url: cachedUrl,
      discovery: syntheticDiscovery
    });
    const chatResponse = needsReadyStep
      ? needsReadyStep
      : showNetworkCandidatesRequested
        ? `Loaded saved map${targetHost ? ` for ${targetHost}` : ''}: ${mergedCandidates.length} API candidate(s), ${mergedLabels.length} label(s).`
        : `Using saved labels${targetHost ? ` for ${targetHost}` : ''}. Ready to continue with ${mergedLabels.length} label(s) and ${mergedCandidates.length} API candidate(s).`;
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: needsReadyStep ? 'discovery_needs_user' : 'discover',
      desired_action: desiredAction,
      url: cachedUrl,
      chat_response: chatResponse,
      discovery: syntheticDiscovery,
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }

  if (
    !planOnly &&
    mutate &&
    cleanupIntentEarly &&
    !cleanupPolicyProvidedEarly &&
    !awaitUserCheckpointRequested &&
    !checkpointReady
  ) {
    const clarification = buildCleanupClarificationMessage(url);
    const suggestedPrompts = buildSuggestedPrompts({
      url: url || null,
      discovery: probeState?.discovery || null
    });
    const telemetry = telemetryFor({
      mode: 'discovery_needs_user',
      discovery: probeState?.discovery || null,
      needsUserStep: clarification
    });
    if (shouldSendUserNotification(targetMeta)) {
      notifyUser('Pinokio: Cleanup Policy Needed', clarification);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: url || null,
        checkpoint_satisfied: false,
        checkpoint_awaited: false,
        checkpoint_reason: 'needs_policy',
        checkpoint_waited_ms: 0,
        needs_user_step: clarification,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: clarification,
      notify: buildNotifyPayload('Pinokio: Cleanup Policy Needed', clarification, {
        url: url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
    });
    process.exit(0);
  }

  if (probeConvertToSkill) {
    const telemetry = telemetryFor({
      mode: 'probe_skill_created',
      discovery: probeState?.discovery || null,
      needsUserStep: null
    });
    if (!probeState || !probeState.discovery) {
      respond({
        ok: true,
        plugin: 'playwright_read_agent',
        mode: 'probe_skill_missing',
        desired_action: desiredAction,
        url: url || probeState?.url || null,
        chat_response:
          'No browser probe session is available in this chat yet. Run a browser discovery task first, then ask me to convert it to a skill.',
        workflow_telemetry: telemetry,
        ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
      });
      process.exit(0);
    }
    const inferredName = inferSkillNameFromTask(
      probeState.url || url || null,
      probeState.task_summary || effectiveUserTask
    );
    const skillName = requestedProbeSkillName || inferredName;
    const skillDescription =
      asOptionalString(targetMeta.probe_skill_description) ||
      `Generated Playwright probe skill for ${extractUrlHost(probeState.url || url || '') || 'browser workflow'}.`;
    const markdown = buildProbeSkillMarkdown({
      skillName,
      description: skillDescription,
      url: url || probeState.url || null,
      state: probeState
    });
    const skillPath = writeProbeSkillFile(skillName, markdown);
    const registration = probeAutoRegisterSkill
      ? runSkillRegistration({
          name: skillName,
          description: skillDescription,
          skillPath
        })
      : null;
    const installHint = registration
      ? registration.ok
        ? 'Skill was also registered in config.'
        : `Auto-register failed. Run manually: ${registration.command}`
      : 'Auto-register is disabled for this request.';
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'probe_skill_created',
      desired_action: desiredAction,
      url: url || probeState.url || null,
      chat_response: `Created probe skill '${skillName}' at ${skillPath}. ${installHint}`,
      workflow_telemetry: telemetry,
      probe_skill: {
        name: skillName,
        description: skillDescription,
        path: skillPath,
        registration
      },
      ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
    });
    process.exit(0);
  }

  if (
    !planOnly &&
    mutate &&
    policy.inferredAuthenticatedTask &&
    !awaitUserCheckpointRequested &&
    !checkpointReady
  ) {
    const readyPrompt = buildReadyCheckpointPrompt(url);
    const suggestedPrompts = buildSuggestedPrompts({
      url: url || null,
      discovery: probeState?.discovery || null
    });
    const chatResponse = probeMode
      ? `${readyPrompt} ${buildProbeFollowupMessage(url)}`
      : readyPrompt;
    const telemetry = telemetryFor({
      mode: 'human_required',
      discovery: probeState?.discovery || null,
      needsUserStep: readyPrompt
    });
    if (shouldSendUserNotification(targetMeta)) {
      notifyUser('Pinokio: Browser Checkpoint Needed', readyPrompt);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: url || null,
        checkpoint_satisfied: false,
        checkpoint_awaited: false,
        checkpoint_reason: 'needs_ready',
        checkpoint_waited_ms: 0,
        needs_user_step: readyPrompt,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: chatResponse.trim(),
      notify: buildNotifyPayload('Pinokio: Browser Checkpoint Needed', readyPrompt, {
        url: url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
    });
    process.exit(0);
  }

  if (planOnly) {
    const plannerPrompt = buildPlannerPrompt({
      userTask: effectiveUserTask,
      desiredAction,
      url,
      discovery: {
        mode: 'plan_only',
        note: 'No live browser discovery requested.'
      },
      skillHints: resolveSkillHints(targetMeta),
      siteProfile
    });
    let planner: PlannerResult;
    try {
      const llm = runChatLlm({
        profile: requestedProfile,
        prompt: plannerPrompt,
        timeoutMs: plannerTimeoutMs
      });
      planner = parsePlannerResult(llm.text);
    } catch {
      planner = fallbackPlannerResult({
        desiredAction,
        url,
        inferredAuthenticatedTask: policy.inferredAuthenticatedTask
      });
    }
    if (probeMode) {
      const telemetry = telemetryFor({
        mode: planner.needsUserStep ? 'discovery_needs_user' : 'plan_only',
        discovery: null,
        needsUserStep: planner.needsUserStep
      });
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: url || null,
        planner_actions: planner.actions,
        planner_api_attempts: planner.apiAttempts,
        planner_notes: planner.notes,
        needs_user_step: planner.needsUserStep,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
      respond({
        ok: true,
        plugin: 'playwright_read_agent',
        mode: 'plan_only',
        desired_action: desiredAction,
        url: url || null,
        chat_response:
          planner.needsUserStep ||
          planner.notes ||
          `Prepared a Playwright plan for ${url || 'the target site'} without launching a browser.`,
        policy: {
          use_user_context: useUserContext,
          inferred_authenticated_task: policy.inferredAuthenticatedTask,
          container_fallback_non_auth: policy.containerFallbackNonAuth,
          allowlisted_domain: policy.allowlistedDomain,
          permission_granted: policy.permissionGranted,
          reason: policy.reason
        },
        planner: {
          actions: planner.actions,
          api_attempts: planner.apiAttempts,
          needs_user_step: planner.needsUserStep,
          notes: planner.notes
        },
        suggested_prompts: buildSuggestedPrompts({
          url: url || null,
          discovery: null
        }),
        workflow_telemetry: telemetry,
        ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
      });
      process.exit(0);
    }
    const telemetry = telemetryFor({
      mode: planner.needsUserStep ? 'discovery_needs_user' : 'plan_only',
      discovery: null,
      needsUserStep: planner.needsUserStep
    });
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'plan_only',
      desired_action: desiredAction,
      url: url || null,
      chat_response:
        planner.needsUserStep ||
        planner.notes ||
        `Prepared a Playwright plan for ${url || 'the target site'} without launching a browser.`,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      planner: {
        actions: planner.actions,
        api_attempts: planner.apiAttempts,
        needs_user_step: planner.needsUserStep,
        notes: planner.notes
      },
      suggested_prompts: buildSuggestedPrompts({
        url: url || null,
        discovery: null
      }),
      workflow_telemetry: telemetry,
      ui_blocks: withWorkflowTelemetryBlocks([], telemetry)
    });
    process.exit(0);
  }

  const canUseCachedDiscovery =
    mutate &&
    policy.inferredAuthenticatedTask &&
    !awaitUserCheckpointRequested &&
    !probeOverlayAutoActivate &&
    !probeOverlayReset &&
    !activeWalkthroughPlan &&
    checkpointReady &&
    probeMode &&
    Boolean(probeState?.discovery);
  let discovery: Record<string, unknown>;
  if (canUseCachedDiscovery) {
    const cached = (probeState?.discovery && typeof probeState.discovery === 'object' && !Array.isArray(probeState.discovery))
      ? (probeState.discovery as Record<string, unknown>)
      : {};
    discovery = {
      ...cached,
      user_checkpoint: {
        awaited: false,
        satisfied: true,
        expected_host: extractUrlHost(url || ''),
        final_url: asOptionalString(cached.url) || probeState?.url || url || null,
        waited_ms: 0,
        reason: 'cached'
      }
    };
  } else {
    discovery = runPlaywrightService({
      action: 'discover',
      url: url || undefined,
      prompt: effectiveUserTask || undefined,
      timeout_ms: timeoutMs,
      headless,
      use_stealth: useStealth,
      use_user_context: useUserContext,
      user_data_dir: userDataDir || undefined,
      storage_state_path: asOptionalString(targetMeta.storage_state_path) || undefined,
      capture_screenshot: captureScreenshot,
      max_network_events: toInt(targetMeta.max_network_events, 40, 1, 200),
      probe_overlay_enabled: probeOverlayEnabled,
      probe_overlay_auto_activate: probeOverlayAutoActivate,
      probe_overlay_reset: probeOverlayReset,
      probe_training_mode: probeTrainingModeRequested,
      probe_walkthrough_plan: activeWalkthroughPlan
        ? (activeWalkthroughPlan as unknown as Record<string, unknown>)
        : undefined,
      await_user_checkpoint: awaitUserCheckpointRequested,
      user_checkpoint_timeout_ms: toInt(targetMeta.user_checkpoint_timeout_ms, 180000, 5000, 600000),
      keep_open_after_discovery_ms: keepOpenAfterDiscoveryMs,
      non_blocking_keep_open: nonBlockingKeepOpen,
      auth_expected_host: asOptionalString(targetMeta.auth_expected_host) || extractUrlHost(url || ''),
      auto_install_chromium: autoInstallChromium,
      auto_install_deps: autoInstallDeps,
      install_command: installCommand || undefined,
      install_deps_command: installDepsCommand || undefined
    }, serviceTimeoutMs);
  }

  const chatResponse = buildChatResponseFromDiscovery(discovery, url, {
    keepOpenAfterDiscoveryMs,
    awaitUserCheckpointRequested,
    useUserContext,
    headless,
    nonBlockingKeepOpen
  });
  const discoveryLabels = extractProbeLabels(discovery);
  const discoveryCandidates = extractDiscoveryNetworkCandidates(discovery);
  if (targetHost) {
    siteProfile = persistSiteProfile(targetHost, siteProfile, {
      labels: extractSiteProfileLabels(discoveryLabels),
      network_candidates: extractSiteProfileNetworkCandidates(discoveryCandidates),
      mark_success: false
    });
  }
  const uiBlocksBase = responseFormat === 'ui_blocks' || channel.includes('ui')
    ? buildUiBlocks(discovery, desiredAction)
    : [];
  const discoveryTelemetry = telemetryFor({
    mode: 'discover',
    discovery,
    needsUserStep: null,
    lastError: null
  });
  const uiBlocks = withWorkflowTelemetryBlocks(uiBlocksBase, discoveryTelemetry);
  const suggestedPrompts = buildSuggestedPrompts({
    url: asOptionalString(discovery.url) || url || null,
    discovery
  });
  const checkpointMeta =
    discovery.user_checkpoint && typeof discovery.user_checkpoint === 'object' && !Array.isArray(discovery.user_checkpoint)
      ? (discovery.user_checkpoint as Record<string, unknown>)
      : null;
  const checkpointSatisfied = checkpointMeta ? toBool(checkpointMeta.satisfied, false) : false;
  const checkpointAwaited = checkpointMeta ? toBool(checkpointMeta.awaited, false) : false;
  const checkpointReason = checkpointMeta ? asOptionalString(checkpointMeta.reason) : null;
  const checkpointWaitedMs = checkpointMeta ? Number(checkpointMeta.waited_ms) : NaN;
  if (probeMode) {
    probeState = persistProbeState(channel, probeState, {
      task_summary: effectiveUserTask,
      desired_action: desiredAction,
      url: asOptionalString(discovery.url) || url || null,
      checkpoint_satisfied: checkpointSatisfied,
      checkpoint_awaited: checkpointAwaited,
      checkpoint_reason: checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
          ? Math.trunc(checkpointWaitedMs)
          : 0,
      discovery,
      planner_actions: probeState?.planner_actions || [],
      planner_api_attempts: probeState?.planner_api_attempts || [],
      planner_notes: probeState?.planner_notes || null,
      needs_user_step: null,
      ...workflowPatchFromTelemetry(discoveryTelemetry, targetHost)
    });
  }

  const authenticatedDiscovery = looksLikeAuthenticatedDiscovery({
    targetMeta,
    url,
    discovery,
    useUserContext,
    inferredAuthenticatedTask: policy.inferredAuthenticatedTask
  });
  if (!authenticatedDiscovery) {
    const checkpointMessage = buildAuthCheckpointMessage({ expectedUrl: url, discovery });
    const telemetry = telemetryFor({
      mode: toBool((discovery.challenge as Record<string, unknown> | undefined)?.detected, false)
        ? 'challenge_detected'
        : 'human_required',
      discovery,
      needsUserStep: checkpointMessage
    });
    const blockedMode =
      telemetry.state === 'challenge_detected' ? 'challenge_detected' : 'human_required';
    if (shouldSendUserNotification(targetMeta)) {
      notifyUser('Pinokio: Browser Action Needed', checkpointMessage);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: asOptionalString(discovery.url) || url || null,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        needs_user_step: checkpointMessage,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: blockedMode,
      desired_action: desiredAction,
      url: url || null,
      chat_response: checkpointMessage,
      discovery,
      notify: buildNotifyPayload('Pinokio: Browser Action Needed', checkpointMessage, {
        url: asOptionalString(discovery.url) || url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }

  const cleanupIntent = inferCleanupIntent({
    userTask: effectiveUserTask,
    desiredAction,
    targetMeta
  });
  const cleanupPolicyProvided = hasCleanupPolicyDetails({
    userTask: effectiveUserTask,
    targetMeta
  });
  if (mutate && cleanupIntent && !cleanupPolicyProvided) {
    const clarification = buildCleanupClarificationMessage(url);
    const telemetry = telemetryFor({
      mode: 'discovery_needs_user',
      discovery,
      needsUserStep: clarification
    });
    if (shouldSendUserNotification(targetMeta)) {
      notifyUser('Pinokio: Cleanup Policy Needed', clarification);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: asOptionalString(discovery.url) || url || null,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        needs_user_step: clarification,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: clarification,
      discovery,
      notify: buildNotifyPayload('Pinokio: Cleanup Policy Needed', clarification, {
        url: asOptionalString(discovery.url) || url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }

  const cleanupExecutionApproved = hasCleanupExecutionApproval({
    userTask: effectiveUserTask,
    targetMeta
  });
  const cleanupPreviewRequested = hasCleanupPreviewRequest({
    userTask: effectiveUserTask,
    targetMeta
  });
  if (mutate && cleanupIntent && cleanupPolicyProvided && !cleanupExecutionApproved && !cleanupPreviewRequested) {
    const walkthroughPlan = activeWalkthroughPlan || parseWalkthroughPlanValue(probeState?.walkthrough_plan || null, 'state');
    const guidancePrompt = walkthroughPlan
      ? buildWalkthroughGuidanceMessage({
          url: asOptionalString(discovery.url) || url || null,
          plan: walkthroughPlan,
          discovery
        })
      : buildCleanupTrainingPrompt(url);
    const pendingTrainingMessage = decodeCleanupTrainingNeed(priorNeedsUserStepRaw) || guidancePrompt;
    const trainingObserved = walkthroughPlan
      ? hasWalkthroughCompletion(walkthroughPlan, discovery)
      : hasCleanupTrainingExamples(discovery);
    const readySignalReceived = readyFollowup || (checkpointAwaited && checkpointSatisfied);
    const trainingRetryMessage =
      readySignalReceived && !trainingObserved
        ? `${pendingTrainingMessage} I still need captured walkthrough evidence. Complete the highlighted overlay step(s), then click READY again.`
        : pendingTrainingMessage;
    if (!trainingObserved) {
      const telemetry = telemetryFor({
        mode: 'discovery_needs_user',
        discovery,
        needsUserStep: trainingRetryMessage
      });
      if (probeMode) {
        probeState = persistProbeState(channel, probeState, {
          task_summary: effectiveUserTask,
          desired_action: desiredAction,
          url: asOptionalString(discovery.url) || url || null,
          checkpoint_satisfied: checkpointSatisfied,
          checkpoint_awaited: checkpointAwaited,
          checkpoint_reason: checkpointReason,
          checkpoint_waited_ms:
            Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
              ? Math.trunc(checkpointWaitedMs)
              : 0,
          discovery,
          walkthrough_plan: walkthroughPlan,
          needs_user_step: encodeCleanupTrainingNeed(trainingRetryMessage),
          ...workflowPatchFromTelemetry(telemetry, targetHost)
        });
      }
      respond({
        ok: true,
        plugin: 'playwright_read_agent',
        mode: 'discovery_needs_user',
        desired_action: desiredAction,
        url: url || null,
        chat_response: trainingRetryMessage,
        discovery,
        notify: buildNotifyPayload('Pinokio: Record Cleanup Examples', trainingRetryMessage, {
          url: asOptionalString(discovery.url) || url || null,
          suggestedPrompts
        }),
        suggested_prompts: suggestedPrompts,
        policy: {
          use_user_context: useUserContext,
          inferred_authenticated_task: policy.inferredAuthenticatedTask,
          container_fallback_non_auth: policy.containerFallbackNonAuth,
          allowlisted_domain: policy.allowlistedDomain,
          permission_granted: policy.permissionGranted,
          reason: policy.reason
        },
        workflow_telemetry: telemetry,
        ui_blocks: uiBlocks
      });
      process.exit(0);
    }

    const trainingCapturedMessage = walkthroughPlan
      ? buildWalkthroughCapturedMessage({
          url: asOptionalString(discovery.url) || url || null,
          plan: walkthroughPlan,
          discovery
        })
      : buildCleanupTrainingCapturedMessage(url, discovery);
    const telemetry = telemetryFor({
      mode: 'discovery_needs_user',
      discovery,
      needsUserStep: trainingCapturedMessage
    });
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: asOptionalString(discovery.url) || url || null,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        walkthrough_plan: walkthroughPlan,
        needs_user_step: trainingCapturedMessage,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: trainingCapturedMessage,
      discovery,
      notify: buildNotifyPayload('Pinokio: Cleanup Training Captured', trainingCapturedMessage, {
        url: asOptionalString(discovery.url) || url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }
  if (mutate && cleanupIntent && cleanupPolicyProvided && cleanupPreviewRequested && !cleanupExecutionApproved) {
    const previewMessage = buildCleanupCandidatePreviewMessage(url, discovery);
    const telemetry = telemetryFor({
      mode: 'discovery_needs_user',
      discovery,
      needsUserStep: previewMessage
    });
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: asOptionalString(discovery.url) || url || null,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        needs_user_step: previewMessage,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: previewMessage,
      discovery,
      notify: buildNotifyPayload('Pinokio: Candidate Preview Ready', previewMessage, {
        url: asOptionalString(discovery.url) || url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }
  if (mutate && cleanupIntent && cleanupPolicyProvided && !cleanupExecutionApproved) {
    const approvalMessage = buildCleanupExecutionApprovalMessage(url, discovery);
    const telemetry = telemetryFor({
      mode: 'needs_pilot_approval',
      discovery,
      needsUserStep: approvalMessage
    });
    if (shouldSendUserNotification(targetMeta)) {
      notifyUser('Pinokio: Confirm Pilot Cleanup', approvalMessage);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: asOptionalString(discovery.url) || url || null,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        needs_user_step: approvalMessage,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'needs_pilot_approval',
      desired_action: desiredAction,
      url: url || null,
      chat_response: approvalMessage,
      discovery,
      notify: buildNotifyPayload('Pinokio: Confirm Pilot Cleanup', approvalMessage, {
        url: asOptionalString(discovery.url) || url || null,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }

  if (mutate && activeWalkthroughPlan && !cleanupIntent) {
    const walkthroughObserved = hasWalkthroughCompletion(activeWalkthroughPlan, discovery);
    if (!walkthroughObserved) {
      const guidancePrompt = buildWalkthroughGuidanceMessage({
        url: asOptionalString(discovery.url) || url || null,
        plan: activeWalkthroughPlan,
        discovery
      });
      const pendingWalkthroughMessage = decodeCleanupTrainingNeed(priorNeedsUserStepRaw) || guidancePrompt;
      const readySignalReceived = readyFollowup || (checkpointAwaited && checkpointSatisfied);
      const retryMessage =
        readySignalReceived
          ? `${pendingWalkthroughMessage} I still need the current walkthrough step completed in the overlay before execution.`
          : pendingWalkthroughMessage;
      const telemetry = telemetryFor({
        mode: 'discovery_needs_user',
        discovery,
        needsUserStep: retryMessage
      });
      if (probeMode) {
        probeState = persistProbeState(channel, probeState, {
          task_summary: effectiveUserTask,
          desired_action: desiredAction,
          url: asOptionalString(discovery.url) || url || null,
          checkpoint_satisfied: checkpointSatisfied,
          checkpoint_awaited: checkpointAwaited,
          checkpoint_reason: checkpointReason,
          checkpoint_waited_ms:
            Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
              ? Math.trunc(checkpointWaitedMs)
              : 0,
          discovery,
          walkthrough_plan: activeWalkthroughPlan,
          needs_user_step: encodeCleanupTrainingNeed(retryMessage),
          ...workflowPatchFromTelemetry(telemetry, targetHost)
        });
      }
      respond({
        ok: true,
        plugin: 'playwright_read_agent',
        mode: 'discovery_needs_user',
        desired_action: desiredAction,
        url: url || null,
        chat_response: retryMessage,
        discovery,
        notify: buildNotifyPayload('Pinokio: Guided Walkthrough', retryMessage, {
          url: asOptionalString(discovery.url) || url || null,
          suggestedPrompts
        }),
        suggested_prompts: suggestedPrompts,
        policy: {
          use_user_context: useUserContext,
          inferred_authenticated_task: policy.inferredAuthenticatedTask,
          container_fallback_non_auth: policy.containerFallbackNonAuth,
          allowlisted_domain: policy.allowlistedDomain,
          permission_granted: policy.permissionGranted,
          reason: policy.reason
        },
        workflow_telemetry: telemetry,
        ui_blocks: uiBlocks
      });
      process.exit(0);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        walkthrough_plan: activeWalkthroughPlan,
        needs_user_step: null
      });
    }
  }

  if (!mutate) {
    const probePrompt = probeMode ? ` ${buildProbeFollowupMessage(url)}` : '';
    const lifecycleOnly = buildBrowserLifecycleLine({
      discovery,
      keepOpenAfterDiscoveryMs,
      awaitUserCheckpointRequested,
      useUserContext,
      headless,
      nonBlockingKeepOpen
    }) || 'Discovery completed.';
    const discoveryNotify =
      shouldSendUserNotification(targetMeta)
        ? buildDiscoveryNotification({
            discovery,
            fallbackUrl: url || null,
            lifecycleText: lifecycleOnly
          })
        : null;
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discover',
      desired_action: desiredAction,
      url: url || null,
      chat_response: `${chatResponse}${probePrompt}`.trim(),
      discovery,
      notify: discoveryNotify,
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      workflow_telemetry: discoveryTelemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }

  const writeResource = asOptionalString(targetMeta.write_resource) || 'plugin:playwright_write_agent';
  const providedActions = parseActionSteps(targetMeta.actions);
  const providedApiAttempts = parseApiAttempts(targetMeta.api_attempts);
  let actions = providedActions;
  let apiAttempts = providedApiAttempts;
  let plannerNotes: string | null = null;
  let needsUserStep: string | null = null;

  if ((actions.length === 0 && apiAttempts.length === 0) && toBool(targetMeta.plan_with_llm, true)) {
    const plannerPrompt = buildPlannerPrompt({
      userTask: effectiveUserTask,
      desiredAction,
      url,
      discovery,
      skillHints: resolveSkillHints(targetMeta),
      siteProfile
    });
    try {
      const llm = runChatLlm({
        profile: requestedProfile,
        prompt: plannerPrompt,
        timeoutMs: plannerTimeoutMs
      });
      const planner = parsePlannerResult(llm.text);
      if (planner.actions.length > 0) {
        actions = planner.actions;
      }
      if (planner.apiAttempts.length > 0) {
        apiAttempts = planner.apiAttempts;
      }
      plannerNotes = planner.notes;
      needsUserStep = planner.needsUserStep;
    } catch {
      const fallback = fallbackPlannerResult({
        desiredAction,
        url,
        inferredAuthenticatedTask: policy.inferredAuthenticatedTask,
        authenticatedReady: checkpointReady || checkpointSatisfied || authenticatedDiscovery
      });
      plannerNotes = fallback.notes;
      needsUserStep = fallback.needsUserStep;
      if (fallback.actions.length > 0 && actions.length === 0) {
        actions = fallback.actions;
      }
      if (fallback.apiAttempts.length > 0 && apiAttempts.length === 0) {
        apiAttempts = fallback.apiAttempts;
      }
    }
  }

  if (
    needsUserStep &&
    /reply\s+"?ready"?/i.test(needsUserStep) &&
    (checkpointReady || checkpointSatisfied || authenticatedDiscovery)
  ) {
    needsUserStep = null;
    plannerNotes =
      plannerNotes ||
      'Checkpoint is already satisfied. Continuing with probe inventory in this session.';
    if (actions.length === 0 && apiAttempts.length === 0) {
      actions = parseActionSteps([
        { type: 'wait_for_selector', selector: 'body', timeout_ms: 8000 },
        { type: 'extract_text', selector: 'main' }
      ]);
    }
  }

  const discoveryUrl = asOptionalString(discovery.url) || url || null;
  const fallbackOrigin = (() => {
    const candidate = asOptionalString(discovery.url) || url || null;
    if (!candidate) {
      return null;
    }
    try {
      return new URL(candidate).origin;
    } catch {
      return null;
    }
  })();
  actions = applySiteProfileToActions(actions, siteProfile);
  apiAttempts = applySiteProfileToApiAttempts(apiAttempts, siteProfile, fallbackOrigin);

  if (actions.length === 0 && apiAttempts.length === 0) {
    needsUserStep =
      needsUserStep ||
      'I need either explicit browser actions or one user checkpoint before I can execute this safely.';
  }

  if (needsUserStep && actions.length === 0 && apiAttempts.length === 0) {
    const probePrompt = probeMode ? ` ${buildProbeFollowupMessage(url)}` : '';
    const telemetry = telemetryFor({
      mode: 'discovery_needs_user',
      discovery,
      needsUserStep
    });
    if (shouldSendUserNotification(targetMeta)) {
      notifyUser('Pinokio: User Input Needed', needsUserStep);
    }
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: discoveryUrl,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        planner_actions: actions,
        planner_api_attempts: apiAttempts,
        planner_notes: plannerNotes,
        needs_user_step: needsUserStep,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: `${needsUserStep}${probePrompt}`.trim(),
      discovery,
      notify: buildNotifyPayload('Pinokio: User Input Needed', needsUserStep, {
        url: discoveryUrl,
        suggestedPrompts
      }),
      suggested_prompts: suggestedPrompts,
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks
    });
    process.exit(0);
  }

  const requiredLabelKeys = inferRequiredLabelKeys({
    desiredAction,
    userTask: effectiveUserTask,
    actions: actions as unknown as Array<Record<string, unknown>>
  });
  const pilotApproved =
    cleanupExecutionApproved ||
    toBool(targetMeta.pilot_approved, false) ||
    /\bpilot\s+(archive|delete|approve|ok|run)\b/i.test(effectiveUserTask);
  const guardrails = enforceExecutionGuardrails({
    mutate,
    desiredAction,
    preferNetworkFirst: toBool(targetMeta.prefer_network_first, true),
    cleanupIntent,
    pilotApproved,
    labels: discoveryLabels,
    requiredLabelKeys,
    networkCandidates: discoveryCandidates,
    actionsCount: actions.length,
    apiAttemptsCount: apiAttempts.length
  });
  if (!guardrails.ok) {
    const issueSummary = guardrails.issues.map((item) => `- ${item}`).join('\n');
    const recovery = guardrails.pilotRequired
      ? 'Reply "PILOT ARCHIVE 1" or "PILOT DELETE 1" to run one safe pilot first.'
      : guardrails.missingNetworkCandidates
        ? 'Reply "SHOW CANDIDATES" on the exact workflow screen, then run this again.'
        : `Enable label mode and capture: ${guardrails.missingLabelKeys.join(', ')}`;
    const guardrailMessage = [
      'Execution paused by deterministic guardrails.',
      issueSummary,
      recovery
    ].join('\n');
    const telemetry = telemetryFor({
      mode: guardrails.pilotRequired ? 'needs_pilot_approval' : 'discovery_needs_user',
      discovery,
      needsUserStep: guardrailMessage
    });
    if (probeMode) {
      probeState = persistProbeState(channel, probeState, {
        task_summary: effectiveUserTask,
        desired_action: desiredAction,
        url: discoveryUrl,
        checkpoint_satisfied: checkpointSatisfied,
        checkpoint_awaited: checkpointAwaited,
        checkpoint_reason: checkpointReason,
        checkpoint_waited_ms:
          Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
            ? Math.trunc(checkpointWaitedMs)
            : 0,
        discovery,
        planner_actions: actions,
        planner_api_attempts: apiAttempts,
        planner_notes: plannerNotes,
        needs_user_step: guardrailMessage,
        ...workflowPatchFromTelemetry(telemetry, targetHost)
      });
    }
    respond({
      ok: true,
      plugin: 'playwright_read_agent',
      mode: guardrails.pilotRequired ? 'needs_pilot_approval' : 'discovery_needs_user',
      desired_action: desiredAction,
      url: url || null,
      chat_response: guardrailMessage,
      discovery,
      suggested_prompts: suggestedPrompts,
      workflow_telemetry: telemetry,
      ui_blocks: uiBlocks,
      guardrails
    });
    process.exit(0);
  }

  const executeTelemetry = telemetryFor({
    mode: 'read_then_write',
    discovery,
    needsUserStep: null
  });
  if (probeMode) {
    probeState = persistProbeState(channel, probeState, {
      task_summary: effectiveUserTask,
      desired_action: desiredAction,
      url: discoveryUrl,
      checkpoint_satisfied: checkpointSatisfied,
      checkpoint_awaited: checkpointAwaited,
      checkpoint_reason: checkpointReason,
      checkpoint_waited_ms:
        Number.isFinite(checkpointWaitedMs) && checkpointWaitedMs >= 0
          ? Math.trunc(checkpointWaitedMs)
          : 0,
      discovery,
      planner_actions: actions,
      planner_api_attempts: apiAttempts,
      planner_notes: plannerNotes,
      needs_user_step: needsUserStep,
      ...workflowPatchFromTelemetry(executeTelemetry, targetHost)
    });
  }

  const executionTarget: Record<string, unknown> = {
    desired_action: desiredAction,
    url: url || discovery.url || null,
    task_summary: effectiveUserTask,
    actions,
    api_attempts: apiAttempts,
    discovery,
    planner_notes: plannerNotes,
    required_label_keys: requiredLabelKeys,
    site_profile: siteProfile,
    label_map: siteProfile?.label_map || {},
    channel,
    response_format: responseFormat,
    timeout_ms: timeoutMs,
    use_stealth: useStealth,
    use_user_context: useUserContext,
    allow_user_context: toBool(targetMeta.allow_user_context, false),
    user_data_dir: userDataDir,
    headless,
    allow_unsafe: false,
    auto_install_chromium: autoInstallChromium,
    auto_install_deps: autoInstallDeps,
    install_command: installCommand || null,
    install_deps_command: installDepsCommand || null
  };
  const delegateRuntime =
    asOptionalString(targetMeta.delegate_runtime) ||
    asOptionalString(targetMeta.runtime) ||
    asOptionalString(request.runtime) ||
    undefined;
  if (delegateRuntime) {
    executionTarget.delegate_runtime = delegateRuntime;
  }

  spawnChild(
    {
      summary: asOptionalString(request.summary) || `playwright ${desiredAction} execution`,
      resource: writeResource,
      action: desiredAction === 'create' ? 'create' : desiredAction === 'delete' ? 'delete' : 'update',
      target: JSON.stringify(executionTarget),
      runtime: delegateRuntime,
      container_image:
        asOptionalString(targetMeta.container_image) ||
        asOptionalString(request.container_image) ||
        null,
      llm_profile:
        typeof request.llm_profile === 'string' && request.llm_profile.trim()
          ? request.llm_profile.trim()
          : null
    },
    {
      ok: true,
      plugin: 'playwright_read_agent',
      mode: 'read_then_write',
      desired_action: desiredAction,
      url: url || null,
      chat_response: plannerNotes || 'Prepared browser execution plan from discovery and delegating to write agent.',
      discovery,
      workflow_telemetry: executeTelemetry,
      guardrails,
      site_profile_host: targetHost,
      suggested_prompts: suggestedPrompts,
      policy: {
        use_user_context: useUserContext,
        inferred_authenticated_task: policy.inferredAuthenticatedTask,
        container_fallback_non_auth: policy.containerFallbackNonAuth,
        allowlisted_domain: policy.allowlistedDomain,
        permission_granted: policy.permissionGranted,
        reason: policy.reason
      },
      ui_blocks: uiBlocks,
      action_count: actions.length,
      api_attempt_count: apiAttempts.length,
      write_resource: writeResource
    }
  );
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
