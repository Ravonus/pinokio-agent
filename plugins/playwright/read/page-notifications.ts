/**
 * Notification, prompt, and checkpoint resolution helpers extracted from
 * page-analysis.ts.
 *
 * Includes suggested-prompt builders, OS notification dispatch, cleanup
 * approval/preview helpers, and checkpoint readiness resolution.
 */

import { spawnSync } from 'node:child_process';
import { asOptionalString, toBool } from '../../plugin-utils.ts';
import { extractUrlHost } from '../common.ts';
import type { ProbeState } from './types.ts';
import {
	extractNetworkSummary,
	extractProbeLabels,
	summarizeNetworkCandidate
} from './page-analysis.ts';

/* ------------------------------------------------------------------ */
/*  Notification & prompts                                             */
/* ------------------------------------------------------------------ */

export function buildSuggestedPrompts(params: {
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

export function buildNotifyActionFromPrompt(
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

export function buildNotifyAction(
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

export function buildDefaultNotifyActions(title: string, url: string | null): Array<Record<string, unknown>> {
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

export function buildNotifyPayload(
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

export function isReadyFollowupMessage(message: string): boolean {
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

export function hasCleanupExecutionApproval(params: {
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

export function hasCleanupPreviewRequest(params: {
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

export function buildCleanupCandidatePreviewMessage(url: string | null, discovery: Record<string, unknown>): string {
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

export function buildCleanupExecutionApprovalMessage(url: string | null, discovery: Record<string, unknown>): string {
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

export function shouldSendUserNotification(targetMeta: Record<string, unknown>): boolean {
	if (targetMeta.notify_user !== undefined) {
		return toBool(targetMeta.notify_user, true);
	}
	return toBool(process.env.PINOKIO_OS_NOTIFICATIONS_ENABLED, false);
}

export function notificationText(value: string, max: number = 220): string {
	const normalized = String(value || '').replace(/\s+/g, ' ').trim();
	if (normalized.length <= max) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function notifyUser(title: string, message: string): void {
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

/* ------------------------------------------------------------------ */
/*  Checkpoint resolution                                              */
/* ------------------------------------------------------------------ */

export function hostMatchesForCheckpoint(stateUrl: string | null, requestedUrl: string | null): boolean {
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

export function checkpointReadyForUrl(state: ProbeState | null, requestedUrl: string | null): boolean {
	if (!state || !toBool(state.checkpoint_satisfied, false)) {
		return false;
	}
	return hostMatchesForCheckpoint(state.url || null, requestedUrl);
}

export function buildReadyCheckpointPrompt(url: string | null): string {
	return `Reply "READY" and I will open an automation browser for ${url || 'the target site'}. Complete login/MFA/CAPTCHA in that automation window, wait until the target workflow page is open, then click READY in the injected panel (or reply "READY") again.`;
}
