/**
 * Probe workflow helpers extracted from the playwright-read agent plugin.
 *
 * Contains walkthrough plan construction/resolution, cleanup-intent inference,
 * training prompts, skill-hint resolution, and re-exports of state persistence
 * and skill-export utilities (now in ./probe-state.ts).
 *
 * Every function preserves the original behaviour — only the import
 * locations have changed.
 */

import {
	asOptionalString,
	toBool,
	parseJsonOutput,
	runChatLlm,
} from '../../plugin-utils.ts';

import {
	extractUrlHost,
} from '../common.ts';

import type {
	ProbeWalkthroughStep,
	ProbeWalkthroughStepKind,
	ProbeWalkthroughPlan,
} from './types.ts';

import {
	CLEANUP_TRAINING_SENTINEL,
	walkthroughPlanSchema,
} from './types.ts';

import {
	extractNetworkSummary,
	extractProbeActionEvents,
	extractProbeTrainingState,
	extractProbeWalkthroughState,
	isLikelyMailWorkflow,
} from './page-analysis.ts';

// Re-export state persistence and skill export functions for backward
// compatibility — new code should import directly from './probe-state.ts'.
export {
	sanitizeStateToken,
	resolveStateBaseDirs,
	resolveProbeStatePaths,
	resolveSiteProfilePaths,
	readProbeStateFromPath,
	readSiteProfileFromPath,
	loadProbeState,
	loadSiteProfile,
	writeProbeState,
	writeSiteProfile,
	persistSiteProfile,
	persistProbeState,
	looksLikeProbeSkillExportMessage,
	normalizeSkillName,
	inferSkillNameFromTask,
	summarizeProbeDiscovery,
	buildProbeSkillMarkdown,
	resolveGeneratedSkillDir,
	writeProbeSkillFile,
	runSkillRegistration,
} from './probe-state.ts';

/* ------------------------------------------------------------------ */
/*  Walkthrough plan functions                                         */
/* ------------------------------------------------------------------ */

export function normalizeWalkthroughToken(value: string): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 90);
}

export function normalizeWalkthroughStep(raw: ProbeWalkthroughStep): ProbeWalkthroughStep {
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

export function parseWalkthroughPlanValue(value: unknown, source: ProbeWalkthroughPlan['source']): ProbeWalkthroughPlan | null {
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

export function buildFallbackWalkthroughPlan(params: {
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

export function buildWalkthroughPlanPrompt(params: {
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

export function getWalkthroughPendingStep(plan: ProbeWalkthroughPlan, discovery: Record<string, unknown>): ProbeWalkthroughStep | null {
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

export function hasWalkthroughCompletion(plan: ProbeWalkthroughPlan, discovery: Record<string, unknown>): boolean {
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

export function buildWalkthroughGuidanceMessage(params: {
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

export function buildWalkthroughCapturedMessage(params: {
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

export function resolveWalkthroughPlan(params: {
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

/* ------------------------------------------------------------------ */
/*  Skill resolution                                                   */
/* ------------------------------------------------------------------ */

export function resolveSkillHints(targetMeta: Record<string, unknown>): string[] {
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

/* ------------------------------------------------------------------ */
/*  Cleanup intent & training                                          */
/* ------------------------------------------------------------------ */

export function buildAuthCheckpointMessage(params: {
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

export function inferCleanupIntent(params: {
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

export function hasCleanupPolicyDetails(params: {
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

export function buildCleanupClarificationMessage(url: string | null): string {
	return [
		'Before I run cleanup actions, confirm your policy so I do not remove important messages.',
		'Reply with: 1) what counts as junk, 2) delete vs archive behavior, 3) time/scope (for example older than X days), 4) protected senders/folders.',
		`After you reply, I will run a read-only preview first on ${url || 'the target site'} before any mutation.`
	].join(' ');
}

export function buildCleanupTrainingPrompt(url: string | null): string {
	return [
		`Now teach me your cleanup behavior directly on ${url || 'the target site'} before bulk automation.`,
		'In the automation browser, do 3 quick examples: 1) mark one obvious junk/sales email, 2) keep one important email, 3) delete or archive one message exactly how you want it handled.',
		'Use the injected panel buttons to mark each example (JUNK DONE, KEEP DONE, MUTATION DONE).',
		'When done, click READY in the injected panel (or reply "READY"). I will learn from that probe and generate safe candidates.'
	].join(' ');
}

export function encodeCleanupTrainingNeed(message: string): string {
	return `${CLEANUP_TRAINING_SENTINEL} ${message}`;
}

export function decodeCleanupTrainingNeed(value: string | null): string | null {
	const raw = asOptionalString(value);
	if (!raw) {
		return null;
	}
	if (!raw.startsWith(CLEANUP_TRAINING_SENTINEL)) {
		return raw;
	}
	return raw.slice(CLEANUP_TRAINING_SENTINEL.length).trim();
}

export function hasPendingCleanupTraining(value: string | null): boolean {
	const raw = asOptionalString(value);
	return Boolean(raw && raw.startsWith(CLEANUP_TRAINING_SENTINEL));
}

export function buildCleanupTrainingCapturedMessage(url: string | null, discovery: Record<string, unknown>): string {
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

export function buildProbeFollowupMessage(url: string | null): string {
	return [
		'Probe mode is active.',
		'Tell me the exact outcome you want, what to keep/protect, and any risky actions to avoid.',
		`I will keep discovery first on ${url || 'the target site'} and only plan safe next steps before writes.`
	].join(' ');
}

