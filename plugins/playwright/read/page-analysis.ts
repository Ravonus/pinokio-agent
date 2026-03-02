/**
 * Page-analysis helpers extracted from the playwright-read agent plugin.
 *
 * Includes resolve helpers, discovery extraction, site-profile mapping,
 * and page analysis.  Notification/prompt builders and checkpoint
 * resolution live in './page-notifications.ts'.
 */

import type { PluginRequest } from '../../../sdk/typescript/pinokio-sdk.ts';
import { asOptionalString, toBool, normalizeAction } from '../../plugin-utils.ts';
import {
	extractUrlHost,
	inferUrlFromMessage,
	parseActionSteps,
	parseApiAttempts
} from '../common.ts';
import {
	type SiteProfile,
	buildSelectorFallbackStack,
	resolveApiAttemptFromCandidates
} from '../runtime-utils.ts';

/* Re-export notification & checkpoint helpers for backward compatibility. */
export {
	buildSuggestedPrompts,
	buildNotifyActionFromPrompt,
	buildNotifyAction,
	buildDefaultNotifyActions,
	buildNotifyPayload,
	isReadyFollowupMessage,
	hasCleanupExecutionApproval,
	hasCleanupPreviewRequest,
	buildCleanupCandidatePreviewMessage,
	buildCleanupExecutionApprovalMessage,
	shouldSendUserNotification,
	notificationText,
	notifyUser,
	hostMatchesForCheckpoint,
	checkpointReadyForUrl,
	buildReadyCheckpointPrompt
} from './page-notifications.ts';

/* ------------------------------------------------------------------ */
/*  Resolve helpers                                                    */
/* ------------------------------------------------------------------ */

export function resolveDesiredAction(request: PluginRequest, targetMeta: Record<string, unknown>): string {
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

export function resolveTargetUrl(request: PluginRequest, targetMeta: Record<string, unknown>): string | null {
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

/* ------------------------------------------------------------------ */
/*  Discovery extraction                                               */
/* ------------------------------------------------------------------ */

export function extractNetworkSummary(discovery: Record<string, unknown>): Record<string, unknown> {
	return discovery.network_summary &&
		typeof discovery.network_summary === 'object' &&
		!Array.isArray(discovery.network_summary)
		? (discovery.network_summary as Record<string, unknown>)
		: {};
}

export function extractProbeLabels(discovery: Record<string, unknown>): Array<Record<string, unknown>> {
	if (!Array.isArray(discovery.probe_labels)) {
		return [];
	}
	return discovery.probe_labels
		.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
		.slice(0, 200) as Array<Record<string, unknown>>;
}

export function extractProbeActionEvents(discovery: Record<string, unknown>): Array<Record<string, unknown>> {
	if (!Array.isArray(discovery.probe_action_events)) {
		return [];
	}
	return discovery.probe_action_events
		.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
		.slice(-80) as Array<Record<string, unknown>>;
}

export function extractProbeTrainingState(discovery: Record<string, unknown>): Record<string, unknown> | null {
	const raw = discovery.probe_training_state;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	return raw as Record<string, unknown>;
}

export function hasCleanupTrainingExamples(discovery: Record<string, unknown>): boolean {
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

export function extractProbeWalkthroughState(discovery: Record<string, unknown>): Record<string, unknown> | null {
	const raw = discovery.probe_walkthrough_state;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	return raw as Record<string, unknown>;
}

export function extractDiscoveryNetworkCandidates(discovery: Record<string, unknown>): Array<Record<string, unknown>> {
	const network = extractNetworkSummary(discovery);
	if (!Array.isArray(network.candidates)) {
		return [];
	}
	return network.candidates
		.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
		.map((item) => item as Record<string, unknown>)
		.slice(0, 120);
}

export function summarizeNetworkCandidate(candidate: Record<string, unknown>): string {
	const methods = Array.isArray(candidate.methods)
		? candidate.methods.map((item) => String(item || '').toUpperCase()).filter(Boolean).slice(0, 4).join('/')
		: '';
	const pathTemplate = asOptionalString(candidate.path_template) || '/';
	const host = asOptionalString(candidate.host) || asOptionalString(candidate.origin) || 'unknown-host';
	return `${methods || 'GET'} ${pathTemplate} (${host})`;
}

/* ------------------------------------------------------------------ */
/*  Site profile mapping                                               */
/* ------------------------------------------------------------------ */

export function mapSiteProfileLabelsToProbeLabels(
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

export function mapSiteProfileNetworkCandidatesToDiscovery(
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

export function dedupeProbeLabels(
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

export function dedupeNetworkCandidates(
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

export function applySiteProfileToActions(
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

export function applySiteProfileToApiAttempts(
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

/* ------------------------------------------------------------------ */
/*  Page analysis                                                      */
/* ------------------------------------------------------------------ */

export function isLikelyMailWorkflow(params: { userTask: string; url: string | null }): boolean {
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

export function buildUiBlocks(discovery: Record<string, unknown>, desiredAction: string): Record<string, unknown>[] {
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

export function looksLikeAuthenticatedDiscovery(params: {
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
