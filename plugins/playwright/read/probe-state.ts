/**
 * State persistence and skill-export utilities extracted from
 * probe-workflow.ts.
 *
 * Contains functions for reading/writing probe state and site profiles
 * to disk, plus functions for exporting probe discoveries as reusable
 * Pinokio skills.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
	asOptionalString,
	toBool,
} from '../../plugin-utils.ts';

import {
	extractUrlHost,
	parseActionSteps,
	parseApiAttempts,
	resolveAgentBinary,
} from '../common.ts';

import {
	type SiteProfile,
	extractSiteProfileLabels,
	extractSiteProfileNetworkCandidates,
	mergeSiteProfile,
} from '../runtime-utils.ts';

import type {
	ProbeState,
	ProbeSkillBuildInput,
	SkillRegistrationResult,
} from './types.ts';

import {
	extractNetworkSummary,
	extractProbeLabels,
	summarizeNetworkCandidate,
} from './page-analysis.ts';

import { parseWalkthroughPlanValue } from './probe-workflow.ts';

/* ------------------------------------------------------------------ */
/*  State persistence                                                  */
/* ------------------------------------------------------------------ */

export function sanitizeStateToken(value: string): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '_')
		.replace(/^_+|_+$/g, '') || 'default';
}

export function resolveStateBaseDirs(): string[] {
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

export function resolveProbeStatePaths(channel: string): string[] {
	const stateFile = `playwright_probe_${sanitizeStateToken(channel)}.json`;
	return resolveStateBaseDirs().map((baseDir) => path.join(baseDir, stateFile));
}

export function resolveSiteProfilePaths(host: string): string[] {
	const safeHost = sanitizeStateToken(host || 'unknown');
	const fileName = `playwright_site_profile_${safeHost}.json`;
	return resolveStateBaseDirs().map((baseDir) => path.join(baseDir, fileName));
}

export function readProbeStateFromPath(statePath: string): ProbeState | null {
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

export function readSiteProfileFromPath(statePath: string): SiteProfile | null {
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

export function loadProbeState(channel: string): ProbeState | null {
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

export function loadSiteProfile(host: string | null): SiteProfile | null {
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

export function writeProbeState(channel: string, state: ProbeState): boolean {
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

export function writeSiteProfile(host: string, profile: SiteProfile): boolean {
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

export function persistSiteProfile(host: string, existing: SiteProfile | null, patch: {
	labels?: ReturnType<typeof extractSiteProfileLabels>;
	network_candidates?: ReturnType<typeof extractSiteProfileNetworkCandidates>;
	mark_success?: boolean;
}): SiteProfile {
	const merged = mergeSiteProfile(host, existing, patch);
	writeSiteProfile(host, merged);
	return merged;
}

export function persistProbeState(channel: string, existing: ProbeState | null, patch: Partial<ProbeState>): ProbeState {
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

/* ------------------------------------------------------------------ */
/*  Skill export                                                       */
/* ------------------------------------------------------------------ */

export function looksLikeProbeSkillExportMessage(message: string): boolean {
	const lower = String(message || '').toLowerCase();
	if (!lower.trim() || !lower.includes('skill')) {
		return false;
	}
	return (
		/\b(convert|save|turn|make|export|create|generate|publish)\b/.test(lower) &&
		/\b(skill|workflow)\b/.test(lower)
	);
}

export function normalizeSkillName(name: string): string {
	return String(name || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '.')
		.replace(/[^a-z0-9_.-]+/g, '.')
		.replace(/\.{2,}/g, '.')
		.replace(/^\.+|\.+$/g, '')
		.slice(0, 80);
}

export function inferSkillNameFromTask(url: string | null, task: string): string {
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

export function summarizeProbeDiscovery(discovery: Record<string, unknown> | undefined): string[] {
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

export function buildProbeSkillMarkdown(input: ProbeSkillBuildInput): string {
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

export function resolveGeneratedSkillDir(): string {
	return (
		asOptionalString(process.env.PINOKIO_PLAYWRIGHT_SKILL_DIR) ||
		path.join(process.cwd(), 'plugins', 'skills', 'playwright', 'generated')
	);
}

export function writeProbeSkillFile(skillName: string, content: string): string {
	const outDir = resolveGeneratedSkillDir();
	fs.mkdirSync(outDir, { recursive: true });
	const fileName = `${skillName.replace(/[^a-z0-9_.-]+/gi, '.').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '')}.md`;
	const fullPath = path.join(outDir, fileName || 'playwright.generated.workflow.md');
	fs.writeFileSync(fullPath, content, { encoding: 'utf8', flag: 'w' });
	return fullPath;
}

export function runSkillRegistration(params: {
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
