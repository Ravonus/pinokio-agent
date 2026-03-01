<script lang="ts">
	import { base } from '$app/paths';
	import { onMount, tick } from 'svelte';
	import { toast } from '$lib/components/Toast.svelte';
	import ChatBubble from '$lib/components/chat/ChatBubble.svelte';
	import TypingIndicator from '$lib/components/chat/TypingIndicator.svelte';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const pluginEnabled = $derived(data.pluginEnabled !== false);
	const unsafeHostEnabled = $derived(data.unsafeHostEnabled === true);

	const UI_CHAT_CHANNEL = 'ui_chat';
	const CHAT_CACHE_KEY = `pinokio.ui.chat.cache.${UI_CHAT_CHANNEL}`;
	const WORKFLOW_HINT_CACHE_KEY = `pinokio.ui.chat.workflow_hint.${UI_CHAT_CHANNEL}`;
	const CHAT_CACHE_MAX = 200;

	type ChatPreviewItem = {
		name: string;
		kind: string;
		path?: string;
		relative_path?: string;
		size?: number | null;
		modified_at?: string | null;
		thumbnail?: string | null;
	};

	type ChatUiBlock = {
		type: string;
		title?: string;
		subtitle?: string;
		scope_dir?: string;
		query?: string | null;
		total_count?: number;
		shown_count?: number;
		items: ChatPreviewItem[];
		channel_targets?: string[];
		source_plugin?: string;
	};

	type ChatActionButton = {
		id: string;
		label: string;
		prompt: string;
		description?: string;
	};

	type ChatNotificationAction = {
		id: string;
		label: string;
		prompt?: string;
		url?: string;
	};

	type ChatNotification = {
		title: string;
		body: string;
		tag?: string;
		url?: string;
		prompt?: string;
		actions?: ChatNotificationAction[];
	};

	type ChatMessage = {
		role: 'user' | 'assistant' | 'error';
		text: string;
		timestamp: number;
		files?: string[];
		uiBlocks?: ChatUiBlock[];
		actions?: ChatActionButton[];
	};

	type BrowserWorkflowHint = {
		mode?: string;
		state?: string;
		pending_step?: string | null;
		last_transition?: string | null;
		last_error?: string | null;
		challenge_detected?: boolean;
		cleanup_intent?: boolean;
		policy_needed?: boolean;
	};

	let prompt = $state('');
	let profile = $state('codex');
	let runtime = $state<'container' | 'unsafe_host'>('container');
	let busy = $state(false);
	let notificationPermissionPrompted = $state(false);
	let notificationPermissionDeniedWarned = $state(false);
	let serviceWorkerRegistration: ServiceWorkerRegistration | null = $state(null);
	const recentNotificationByTag = new Map<string, { at: number; fingerprint: string }>();
	let messageListEl: HTMLDivElement | undefined = $state();
	let messages = $state<ChatMessage[]>([]);
	let browserWorkflowHint = $state<BrowserWorkflowHint | null>(null);

	/* ── Typewriter state ── */
	let twIndex = $state(-1);
	let twChars = $state(0);
	let twRafId: number | null = null;

	function stopTypewriter() {
		if (twRafId !== null) {
			cancelAnimationFrame(twRafId);
			twRafId = null;
		}
		twIndex = -1;
		twChars = 0;
	}

	function finishTypewriter() {
		if (twIndex >= 0 && messages[twIndex]) {
			twChars = messages[twIndex].text.length;
		}
		stopTypewriter();
	}

	function startTypewriter(messageIndex: number) {
		stopTypewriter();
		const fullLen = messages[messageIndex].text.length;
		if (fullLen < 20) return;
		twIndex = messageIndex;
		twChars = 0;
		let last = performance.now();
		const step = (now: number) => {
			const dt = now - last;
			if (dt >= 16) {
				last = now;
				const speed = twChars < 200 ? 2 : twChars < 600 ? 5 : 10;
				twChars = Math.min(twChars + speed, fullLen);
			}
			if (twChars < fullLen) {
				twRafId = requestAnimationFrame(step);
			} else {
				twRafId = null;
				twIndex = -1;
			}
		};
		twRafId = requestAnimationFrame(step);
	}

	function displayText(message: ChatMessage, index: number): string {
		return twIndex === index ? message.text.slice(0, twChars) : message.text;
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function asOptionalString(value: unknown): string | null {
		if (typeof value !== 'string') {
			return null;
		}
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	function safeNumber(value: unknown): number | null {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string') {
			const parsed = Number.parseInt(value, 10);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	function safeBool(value: unknown, fallback = false): boolean {
		if (typeof value === 'boolean') {
			return value;
		}
		if (typeof value === 'number') {
			return value !== 0;
		}
		const normalized = asOptionalString(value)?.toLowerCase();
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

	function normalizeCachedMessage(raw: unknown): ChatMessage | null {
		if (!isRecord(raw)) {
			return null;
		}
		const roleValue = asOptionalString(raw.role);
		if (roleValue !== 'user' && roleValue !== 'assistant' && roleValue !== 'error') {
			return null;
		}
		const text = asOptionalString(raw.text);
		if (!text) {
			return null;
		}
		const timestamp = safeNumber(raw.timestamp) ?? Date.now();
		return {
			role: roleValue,
			text,
			timestamp,
			files: Array.isArray(raw.files)
				? raw.files.map((value) => String(value)).filter((value) => value.trim().length > 0).slice(0, 8)
				: undefined,
			uiBlocks: Array.isArray(raw.uiBlocks)
				? raw.uiBlocks
						.map((value) => normalizeUiBlock(value, 'cache'))
						.filter((value): value is ChatUiBlock => value !== null)
				: undefined,
			actions: Array.isArray(raw.actions)
				? raw.actions
						.map((value) => normalizeActionButton(value))
						.filter((value): value is ChatActionButton => value !== null)
				: undefined
		};
	}

	function loadMessagesCache(): ChatMessage[] {
		if (typeof window === 'undefined') {
			return [];
		}
		try {
			const raw = window.localStorage.getItem(CHAT_CACHE_KEY);
			if (!raw) {
				return [];
			}
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed
				.map((value) => normalizeCachedMessage(value))
				.filter((value): value is ChatMessage => value !== null)
				.slice(-CHAT_CACHE_MAX);
		} catch {
			return [];
		}
	}

	function persistMessagesCache(nextMessages: ChatMessage[]): void {
		if (typeof window === 'undefined') {
			return;
		}
		try {
			window.localStorage.setItem(
				CHAT_CACHE_KEY,
				JSON.stringify(nextMessages.slice(-CHAT_CACHE_MAX))
			);
		} catch {
			// best-effort cache
		}
	}

	function loadWorkflowHintCache(): BrowserWorkflowHint | null {
		if (typeof window === 'undefined') {
			return null;
		}
		try {
			const raw = window.localStorage.getItem(WORKFLOW_HINT_CACHE_KEY);
			if (!raw) {
				return null;
			}
			const parsed = JSON.parse(raw);
			if (!isRecord(parsed)) {
				return null;
			}
			return {
				mode: asOptionalString(parsed.mode) ?? undefined,
				state: asOptionalString(parsed.state) ?? undefined,
				pending_step: asOptionalString(parsed.pending_step),
				last_transition: asOptionalString(parsed.last_transition),
				last_error: asOptionalString(parsed.last_error),
				challenge_detected: safeBool(parsed.challenge_detected, false),
				cleanup_intent: safeBool(parsed.cleanup_intent, false),
				policy_needed: safeBool(parsed.policy_needed, false)
			};
		} catch {
			return null;
		}
	}

	function persistWorkflowHintCache(nextHint: BrowserWorkflowHint | null): void {
		if (typeof window === 'undefined') {
			return;
		}
		try {
			if (!nextHint) {
				window.localStorage.removeItem(WORKFLOW_HINT_CACHE_KEY);
				return;
			}
			window.localStorage.setItem(WORKFLOW_HINT_CACHE_KEY, JSON.stringify(nextHint));
		} catch {
			// best-effort cache
		}
	}

	function mergeHistoryWithCache(history: ChatMessage[], cached: ChatMessage[]): ChatMessage[] {
		const merged = [...history, ...cached];
		const seen = new Set<string>();
		const deduped: ChatMessage[] = [];
		for (const message of merged) {
			const key = `${message.role}|${message.timestamp}|${message.text}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			deduped.push(message);
		}
		deduped.sort((a, b) => a.timestamp - b.timestamp);
		return deduped.slice(-CHAT_CACHE_MAX);
	}

	function formatBytes(value: number): string {
		if (!Number.isFinite(value) || value < 0) {
			return '0 B';
		}
		if (value < 1024) {
			return `${value} B`;
		}
		const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
		let n = value;
		let unitIndex = -1;
		while (n >= 1024 && unitIndex < units.length - 1) {
			n /= 1024;
			unitIndex += 1;
		}
		return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[unitIndex]}`;
	}

	function firstJsonStart(text: string): number {
		const firstObject = text.indexOf('{');
		const firstArray = text.indexOf('[');
		if (firstObject === -1) return firstArray;
		if (firstArray === -1) return firstObject;
		return Math.min(firstObject, firstArray);
	}

	function parseJsonOutput(raw: string): unknown | null {
		const trimmed = String(raw ?? '').trim();
		if (!trimmed) {
			return null;
		}
		try {
			return JSON.parse(trimmed) as unknown;
		} catch {
			const start = firstJsonStart(trimmed);
			if (start < 0) {
				return null;
			}
			const endCandidates = [
				trimmed.length,
				Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']')) + 1
			].filter((value) => Number.isFinite(value) && value > start);
			for (const end of endCandidates) {
				try {
					return JSON.parse(trimmed.slice(start, end)) as unknown;
				} catch {
					// try next candidate
				}
			}
			return null;
		}
	}

	function decodeJsonEscapedString(value: string): string {
		try {
			return JSON.parse(`"${value}"`) as string;
		} catch {
			return value
				.replace(/\\n/g, '\n')
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, '\\');
		}
	}

	function extractChatResponseFromRaw(raw: string): string | null {
		const match = raw.match(/"chat_response"\s*:\s*"((?:\\.|[^"\\])*)"/s);
		if (!match || !match[1]) {
			return null;
		}
		return asOptionalString(decodeJsonEscapedString(match[1]));
	}

	function baseNameFromPath(input: string): string {
		const normalized = input.trim().replace(/\/+$/, '');
		if (!normalized) {
			return 'Folder';
		}
		const segments = normalized.split(/[\\/]/).filter(Boolean);
		return segments.length > 0 ? segments[segments.length - 1] : normalized;
	}

	function normalizePreviewItem(item: unknown): ChatPreviewItem | null {
		if (!isRecord(item)) {
			return null;
		}
		const name =
			asOptionalString(item.name) ??
			asOptionalString(item.relative_path) ??
			asOptionalString(item.path);
		if (!name) {
			return null;
		}
		const kindValue = asOptionalString(item.kind)?.toLowerCase() ?? 'file';
		const kind =
			kindValue === 'directory' || kindValue === 'dir'
				? 'directory'
				: kindValue === 'file'
					? 'file'
					: 'entry';
		return {
			name,
			kind,
			path: asOptionalString(item.path) ?? undefined,
			relative_path: asOptionalString(item.relative_path) ?? undefined,
			size: safeNumber(item.size),
			modified_at: asOptionalString(item.modified_at) ?? undefined,
			thumbnail: asOptionalString(item.thumbnail) ?? undefined
		};
	}

	function normalizeUiBlock(raw: unknown, fallbackPlugin: string): ChatUiBlock | null {
		if (!isRecord(raw)) {
			return null;
		}
		const type = asOptionalString(raw.type) ?? '';
		if (!type) {
			return null;
		}
		const rawTargets = Array.isArray(raw.channel_targets)
			? raw.channel_targets.map((value) => String(value).toLowerCase().trim()).filter(Boolean)
			: [];
		if (
			rawTargets.length > 0 &&
			!rawTargets.includes(UI_CHAT_CHANNEL) &&
			!rawTargets.includes('*') &&
			!rawTargets.includes('all')
		) {
			return null;
		}
		const items = Array.isArray(raw.items)
			? raw.items.map(normalizePreviewItem).filter((value): value is ChatPreviewItem => value !== null)
			: [];
		return {
			type,
			title: asOptionalString(raw.title) ?? undefined,
			subtitle: asOptionalString(raw.subtitle) ?? undefined,
			scope_dir: asOptionalString(raw.scope_dir) ?? undefined,
			query: asOptionalString(raw.query),
			total_count: safeNumber(raw.total_count) ?? undefined,
			shown_count: safeNumber(raw.shown_count) ?? undefined,
			items,
			channel_targets: rawTargets,
			source_plugin: asOptionalString(raw.source_plugin) ?? fallbackPlugin
		};
	}

	function normalizeActionButton(raw: unknown): ChatActionButton | null {
		if (typeof raw === 'string') {
			const prompt = asOptionalString(raw);
			if (!prompt) {
				return null;
			}
			const id = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'action';
			return {
				id,
				label: prompt.length <= 28 ? prompt : `${prompt.slice(0, 25)}...`,
				prompt
			};
		}
		if (!isRecord(raw)) {
			return null;
		}
		const prompt = asOptionalString(raw.prompt) ?? asOptionalString(raw.command);
		if (!prompt) {
			return null;
		}
		const label = asOptionalString(raw.label) ?? prompt;
		const id =
			asOptionalString(raw.id) ??
			label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) ??
			'action';
		return {
			id,
			label,
			prompt,
			description: asOptionalString(raw.description) ?? undefined
		};
	}

	function normalizeNotificationAction(raw: unknown): ChatNotificationAction | null {
		if (!isRecord(raw)) {
			return null;
		}
		const id = asOptionalString(raw.id);
		const label = asOptionalString(raw.label) ?? asOptionalString(raw.title);
		if (!id || !label) {
			return null;
		}
		return {
			id,
			label,
			prompt: asOptionalString(raw.prompt) ?? undefined,
			url: asOptionalString(raw.url) ?? undefined
		};
	}

	function normalizeChatNotification(raw: unknown): ChatNotification | null {
		if (!isRecord(raw)) {
			return null;
		}
		const title = asOptionalString(raw.title);
		const body = asOptionalString(raw.body) ?? asOptionalString(raw.message);
		if (!title || !body) {
			return null;
		}
		const actions = Array.isArray(raw.actions)
			? raw.actions
					.map(normalizeNotificationAction)
					.filter((value): value is ChatNotificationAction => value !== null)
					.slice(0, 2)
			: [];
		return {
			title,
			body,
			tag: asOptionalString(raw.tag) ?? undefined,
			url: asOptionalString(raw.url) ?? undefined,
			prompt: asOptionalString(raw.prompt) ?? undefined,
			actions: actions.length > 0 ? actions : undefined
		};
	}

	function buildExplorerFallbackBlock(payload: Record<string, unknown>): ChatUiBlock | null {
		const matches = Array.isArray(payload.matches)
			? payload.matches.map(normalizePreviewItem).filter((value): value is ChatPreviewItem => value !== null)
			: [];
		const scopeDir = asOptionalString(payload.scope_dir) ?? '';
		const query = asOptionalString(payload.query);
		const title = query
			? `Search Results: ${query}`
			: `Files in ${scopeDir ? baseNameFromPath(scopeDir) : 'Folder'}`;
		return {
			type: 'file_grid',
			title,
			subtitle: query ? 'Directory search preview' : 'Directory contents',
			scope_dir: scopeDir || undefined,
			query,
			total_count: safeNumber(payload.match_count) ?? matches.length,
			shown_count: matches.length,
			items: matches,
			channel_targets: [UI_CHAT_CHANNEL],
			source_plugin: 'explorer_read_agent'
		};
	}

	function summarizeExplorerResult(payload: Record<string, unknown>, block: ChatUiBlock | null): string {
		const scopeDir = asOptionalString(payload.scope_dir);
		const info = isRecord(payload.info) ? payload.info : null;
		if (info) {
			const infoPath = asOptionalString(info.path) ?? scopeDir;
			const kind = asOptionalString(info.kind)?.toLowerCase();
			if (kind === 'file') {
				const size = safeNumber(info.size_bytes) ?? safeNumber(info.total_size_bytes);
				if (infoPath && size !== null) {
					return `File info for ${infoPath}: ${size.toLocaleString()} bytes (${formatBytes(size)}).`;
				}
			}
			if (kind === 'directory') {
				const files = safeNumber(info.file_count);
				const directories = safeNumber(info.directory_count);
				const totalBytes = safeNumber(info.total_size_bytes);
				if (infoPath && files !== null && directories !== null && totalBytes !== null) {
					return `Directory info for ${infoPath}: ${files} files, ${directories} folders, ${totalBytes.toLocaleString()} bytes (${formatBytes(totalBytes)}).`;
				}
			}
		}
		const total = safeNumber(payload.match_count) ?? block?.items.length ?? 0;
		if (total <= 0) {
			return scopeDir
				? `No matching files or folders found in ${scopeDir}.`
				: 'No matching files or folders found.';
		}
		return scopeDir
			? `Found ${total} item(s) in ${scopeDir}.`
			: `Found ${total} item(s).`;
	}

	function summarizeWriteResult(payload: Record<string, unknown>): string | null {
		const plugin = asOptionalString(payload.plugin);
		if (plugin !== 'explorer_write_agent') {
			return null;
		}
		const result = isRecord(payload.result) ? payload.result : null;
		if (!result) {
			return 'Directory update completed.';
		}
		const operation = asOptionalString(result.operation) ?? 'update';
		const primaryPath =
			asOptionalString(result.path) ??
			asOptionalString(result.destination_path) ??
			asOptionalString(result.source_path);
		const applied = result.applied === false ? 'Planned' : 'Completed';
		return primaryPath ? `${applied} ${operation} for ${primaryPath}.` : `${applied} ${operation}.`;
	}

	function isStatusOnlyText(value: string): boolean {
		const lower = value.trim().toLowerCase();
		if (!lower) {
			return true;
		}
		return (
			lower.startsWith('routing via ') ||
			lower.startsWith('executing through directory plugin') ||
			lower.startsWith('delegating ') ||
			lower === 'task completed.' ||
			lower === 'here is what i found.'
		);
	}

	function pickAssistantText(
		textCandidates: string[],
		explorerSummary: string | null,
		uiBlocks: ChatUiBlock[]
	): string {
		const normalized = textCandidates
			.map((candidate) => candidate.trim())
			.filter((candidate) => candidate.length > 0);
		const nonStatus = normalized.filter((candidate) => !isStatusOnlyText(candidate));
		const chosen = nonStatus.at(-1) ?? normalized.at(-1);
		return chosen ?? explorerSummary ?? (uiBlocks.length > 0 ? 'Here is what I found.' : 'Task completed.');
	}

	function extractFirstUrl(text: string): string | null {
		const match = String(text ?? '').match(/\bhttps?:\/\/[^\s<>"'`]+/i);
		return match && match[0] ? match[0] : null;
	}

	function shouldAutoOpenUrl(text: string): boolean {
		const lower = String(text ?? '').toLowerCase();
		if (!lower) {
			return false;
		}
		return (
			lower.startsWith('open http://') ||
			lower.startsWith('open https://') ||
			lower.includes('open https://') ||
			lower.includes('open http://')
		);
	}

	function extractAssistantPayload(report: unknown): {
		text: string;
		uiBlocks: ChatUiBlock[];
		actions: ChatActionButton[];
		notification: ChatNotification | null;
		workflowHint: BrowserWorkflowHint | null;
	} {
		const seen = new Set<unknown>();
		const textCandidates: string[] = [];
		const uiBlocks: ChatUiBlock[] = [];
		const uiBlockKeys = new Set<string>();
		let explorerSummary: string | null = null;
		let sawPlaywrightProbe = false;
		let sawProbeSkillCreated = false;
		let suggestedProbeSkillName: string | null = null;
		const actions: ChatActionButton[] = [];
		const actionPromptSet = new Set<string>();
		let notification: ChatNotification | null = null;
		let workflowHint: BrowserWorkflowHint | null = null;
		const addAction = (action: ChatActionButton | null) => {
			if (!action) {
				return;
			}
			const key = action.prompt.trim().toLowerCase();
			if (!key || actionPromptSet.has(key)) {
				return;
			}
			actionPromptSet.add(key);
			actions.push(action);
		};
		const setNotification = (value: ChatNotification | null) => {
			if (!value || notification) {
				return;
			}
			notification = value;
		};

		const addUiBlock = (block: ChatUiBlock | null) => {
			if (!block) {
				return;
			}
			const first = block.items[0];
			const key = [
				block.source_plugin ?? '',
				block.type,
				block.title ?? '',
				block.scope_dir ?? '',
				String(block.total_count ?? block.items.length),
				first?.path ?? first?.relative_path ?? first?.name ?? ''
			].join('|');
			if (uiBlockKeys.has(key)) {
				return;
			}
			uiBlockKeys.add(key);
			uiBlocks.push(block);
		};

		const visitData = (value: unknown): void => {
			if (!isRecord(value) || seen.has(value)) {
				return;
			}
			seen.add(value);

			const rawPayload = value.raw;
			if (typeof rawPayload === 'string') {
				const parsed = parseJsonOutput(rawPayload);
				if (parsed) {
					visitData(parsed);
				} else {
					const fallbackText = extractChatResponseFromRaw(rawPayload);
					if (fallbackText) {
						textCandidates.push(fallbackText);
					}
				}
			}

			const direct = asOptionalString(value.chat_response);
			if (direct) {
				textCandidates.push(direct);
			}
			setNotification(normalizeChatNotification(value.notify));
			setNotification(normalizeChatNotification(value.notification));

			const plugin = asOptionalString(value.plugin) ?? 'unknown';
			const mode = asOptionalString(value.mode)?.toLowerCase() ?? '';
			const needsUserStep = asOptionalString(value.needs_user_step);
			const telemetryRaw = isRecord(value.workflow_telemetry) ? value.workflow_telemetry : null;
			const discovery = isRecord(value.discovery) ? value.discovery : null;
			const challengeDetected = discovery
				? safeBool((discovery.challenge as Record<string, unknown> | undefined)?.detected, false)
				: false;
			if (plugin.startsWith('playwright_') || mode.includes('discover') || mode.includes('execute') || mode.includes('challenge') || mode.includes('pilot')) {
				const nextHint: BrowserWorkflowHint = {
					mode: mode || workflowHint?.mode,
					state:
						asOptionalString(telemetryRaw?.state) ??
						(mode === 'challenge_detected'
							? 'challenge_detected'
							: mode === 'human_required'
								? 'human_required'
								: mode === 'needs_pilot_approval'
									? 'needs_pilot_approval'
									: mode === 'read_then_write' || mode === 'execute'
										? 'executing'
										: mode === 'discover' || mode === 'plan_only'
											? 'probing'
											: mode === 'discovery_needs_user'
												? 'human_required'
												: workflowHint?.state),
					pending_step: asOptionalString(telemetryRaw?.pending_step) ?? needsUserStep ?? workflowHint?.pending_step ?? null,
					last_transition:
						asOptionalString(telemetryRaw?.last_transition) ??
						(mode ? `mode:${mode}` : workflowHint?.last_transition ?? null),
					last_error:
						asOptionalString(telemetryRaw?.last_error) ??
						asOptionalString((value.error as unknown) ?? null) ??
						workflowHint?.last_error ??
						null,
					challenge_detected: challengeDetected || safeBool(telemetryRaw?.state === 'challenge_detected', false),
					cleanup_intent: safeBool(value.cleanup_intent, workflowHint?.cleanup_intent ?? false),
					policy_needed: safeBool(value.cleanup_policy_provided, false) === false && safeBool(value.cleanup_intent, false)
				};
				workflowHint = nextHint;
			}
			const directWriteSummary = summarizeWriteResult(value);
			if (directWriteSummary) {
				textCandidates.push(directWriteSummary);
			}

			if (plugin === 'playwright_read_agent') {
				const hasDiscovery = isRecord(value.discovery);
				const probeModes = new Set([
					'discover',
					'discovery_needs_user',
					'plan_only',
					'read_then_write',
					'probe_skill_created'
				]);
				if (hasDiscovery || probeModes.has(mode)) {
					sawPlaywrightProbe = true;
				}
				const probeSkill = isRecord(value.probe_skill) ? value.probe_skill : null;
				const createdSkillName = probeSkill ? asOptionalString(probeSkill.name) : null;
				if (createdSkillName) {
					suggestedProbeSkillName = createdSkillName;
				}
				if (mode === 'probe_skill_created' || probeSkill) {
					sawProbeSkillCreated = true;
				}
				if (mode === 'discovery_needs_user' && direct && !notification) {
					setNotification({
						title: 'Pinokio: Browser Action Needed',
						body: direct,
						tag: 'pinokio-playwright-action'
					});
				}
			}

			const hintedSkillName = asOptionalString(value.probe_skill_name);
			if (hintedSkillName && !suggestedProbeSkillName) {
				suggestedProbeSkillName = hintedSkillName;
			}

			if (Array.isArray(value.ui_blocks)) {
				for (const rawBlock of value.ui_blocks) {
					addUiBlock(normalizeUiBlock(rawBlock, plugin));
				}
			}
			if (Array.isArray(value.suggested_prompts)) {
				for (const actionItem of value.suggested_prompts) {
					addAction(normalizeActionButton(actionItem));
				}
			}
			if (Array.isArray(value.actions)) {
				for (const actionItem of value.actions) {
					addAction(normalizeActionButton(actionItem));
				}
			}
			addAction(normalizeActionButton(value.suggested_prompt));

			if (plugin === 'explorer_read_agent') {
				const explorerBlock = buildExplorerFallbackBlock(value);
				addUiBlock(explorerBlock);
				if (!explorerSummary) {
					explorerSummary = summarizeExplorerResult(value, explorerBlock);
				}
			}

			const spawned = isRecord(value.spawn_child_result) ? value.spawn_child_result : null;
			if (spawned && spawned.report) {
				visitReport(spawned.report);
			}

			for (const nested of Object.values(value)) {
				visitData(nested);
			}
		};

		const visitReport = (value: unknown): void => {
			if (!isRecord(value) || seen.has(value)) {
				return;
			}
			seen.add(value);

			const agents = Array.isArray(value.agents) ? value.agents : [];
			for (const agent of agents) {
				if (isRecord(agent)) {
					visitData(agent.data);
				}
			}

			for (const nested of Object.values(value)) {
				visitData(nested);
			}
		};

		visitReport(report);

			const text = pickAssistantText(textCandidates, explorerSummary, uiBlocks);
			if (workflowHint) {
				const hint = workflowHint as BrowserWorkflowHint;
				const telemetryBlock: ChatUiBlock = {
					type: 'playwright_workflow_telemetry',
					title: 'Workflow Telemetry',
					subtitle: 'Current browser automation status',
					items: [
						{
							name: `State: ${hint.state ?? 'unknown'}`,
							kind: 'entry',
							relative_path: hint.pending_step ?? 'No pending step'
						},
						{
							name: `Last transition: ${hint.last_transition ?? 'unknown'}`,
							kind: 'entry',
							relative_path: hint.last_error ? `Last error: ${hint.last_error}` : 'Last error: none'
						}
					],
				total_count: 2,
				channel_targets: [UI_CHAT_CHANNEL],
				source_plugin: 'playwright'
			};
			addUiBlock(telemetryBlock);
		}
		if (sawPlaywrightProbe && !sawProbeSkillCreated) {
			const prompt = suggestedProbeSkillName
				? `convert this probe to a skill named ${suggestedProbeSkillName}`
				: 'convert this probe to a skill';
			addAction({
				id: 'save_probe_skill',
				label: 'Save Probe as Skill',
				prompt,
				description: 'Generate a reusable skill from this browser probe flow.'
			});
		}
		return { text, uiBlocks, actions, notification, workflowHint };
	}

	function browserNotificationsSupported(): boolean {
		return typeof window !== 'undefined' && 'Notification' in window;
	}

	function sanitizeNotificationActionId(value: string): string {
		const normalized = String(value || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '_')
			.replace(/^_+|_+$/g, '');
		return normalized || 'action';
	}

	function buildNotificationActions(
		notification: ChatNotification,
		actionButtons: ChatActionButton[]
	): ChatNotificationAction[] {
		if (Array.isArray(notification.actions) && notification.actions.length > 0) {
			return notification.actions.slice(0, 2).map((action, index) => ({
				id: sanitizeNotificationActionId(action.id || `action_${index + 1}`),
				label: action.label,
				prompt: action.prompt,
				url: action.url
			}));
		}
		return actionButtons.slice(0, 2).map((action, index) => ({
			id: sanitizeNotificationActionId(action.id || `action_${index + 1}`),
			label: action.label,
			prompt: action.prompt,
			url: '/ui/chat'
		}));
	}

	function shouldThrottleNotification(
		notification: ChatNotification,
		actions: ChatNotificationAction[]
	): boolean {
		const tag = (notification.tag || 'pinokio-chat').trim().toLowerCase() || 'pinokio-chat';
		const fingerprint = JSON.stringify({
			title: notification.title,
			body: notification.body,
			prompt: notification.prompt ?? null,
			actions: actions.map((item) => ({
				id: item.id,
				label: item.label,
				prompt: item.prompt ?? null
			}))
		});
		const now = Date.now();
		const previous = recentNotificationByTag.get(tag);
		if (previous && previous.fingerprint === fingerprint && now - previous.at < 15_000) {
			return true;
		}
		recentNotificationByTag.set(tag, { at: now, fingerprint });
		return false;
	}

	async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
		if (serviceWorkerRegistration) {
			return serviceWorkerRegistration;
		}
		if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
			return null;
		}
		try {
			const registration = await navigator.serviceWorker.register(`${base}/service-worker.js`);
			serviceWorkerRegistration = registration;
			return registration;
		} catch {
			return null;
		}
	}

	async function maybeSendBrowserNotification(
		notification: ChatNotification | null,
		actionButtons: ChatActionButton[] = []
	) {
		if (!notification || !browserNotificationsSupported()) {
			return;
		}
		try {
			const actions = buildNotificationActions(notification, actionButtons);
			if (shouldThrottleNotification(notification, actions)) {
				return;
			}
			if (Notification.permission === 'denied') {
				if (!notificationPermissionDeniedWarned) {
					notificationPermissionDeniedWarned = true;
					toast('Browser notifications are blocked for this site. Enable them in browser settings.', 'warning');
				}
				return;
			}
			if (Notification.permission !== 'granted') {
				if (notificationPermissionPrompted) {
					return;
				}
				notificationPermissionPrompted = true;
				const permission = await Notification.requestPermission();
				if (permission !== 'granted') {
					toast('Enable browser notifications to get prompts while working in other tabs.', 'warning');
					return;
				}
			}
			const notificationData = {
				url: notification.url ?? '/ui/chat',
				prompt: notification.prompt ?? undefined,
				tag: notification.tag ?? 'pinokio-chat',
				actions
			};
			const registration = await ensureServiceWorkerRegistration();
			if (registration && 'showNotification' in registration) {
				await registration.showNotification(notification.title, {
					body: notification.body,
					tag: notification.tag ?? 'pinokio-chat',
					data: notificationData
				});
				return;
			}
			new Notification(notification.title, {
				body: notification.body,
				tag: notification.tag ?? 'pinokio-chat',
				data: notificationData
			});
		} catch {
			// best-effort browser notifications
		}
	}

	function consumePromptFromQuery(): string | null {
		if (typeof window === 'undefined') {
			return null;
		}
		const url = new URL(window.location.href);
		const runPrompt = asOptionalString(url.searchParams.get('run_prompt'));
		const autoRun = asOptionalString(url.searchParams.get('auto_run'));
		if (!runPrompt) {
			return null;
		}
		url.searchParams.delete('run_prompt');
		url.searchParams.delete('auto_run');
		const next = `${url.pathname}${url.search}${url.hash}`;
		window.history.replaceState(window.history.state, '', next);
		if (autoRun && ['1', 'true', 'yes'].includes(autoRun.toLowerCase())) {
			return runPrompt;
		}
		prompt = runPrompt;
		toast('Loaded action from notification. Press Enter to run it.', 'neutral');
		return null;
	}

	async function scrollToBottom() {
		await tick();
		requestAnimationFrame(() => {
			if (messageListEl) {
				messageListEl.scrollTop = messageListEl.scrollHeight;
			}
		});
	}

	async function handleSend(text: string, files: File[]) {
		if (!text || busy) return;
		finishTypewriter();
		const fileNames = files.map((f) => f.name);
		messages = [...messages, { role: 'user', text, timestamp: Date.now(), files: fileNames }];
		persistMessagesCache(messages);
		await scrollToBottom();
		busy = true;
		let requestTimeout: ReturnType<typeof setTimeout> | null = null;
		try {
			const controller = new AbortController();
			requestTimeout = setTimeout(() => controller.abort('chat request timeout'), 305_000);
			const selectedRuntime = unsafeHostEnabled ? runtime : 'container';
			const response = await fetch('/api/task', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				signal: controller.signal,
				body: JSON.stringify({
					task: text,
					resource: 'plugin:chat_agent',
					action: 'read',
					target: JSON.stringify({
						message: text,
						runtime: selectedRuntime,
						channel: UI_CHAT_CHANNEL,
						response_format: 'ui_blocks',
						allow_unsafe_fallback: false,
						browser_mode_hint: browserWorkflowHint?.mode ?? null,
						browser_workflow_state_hint: browserWorkflowHint?.state ?? null,
						browser_pending_step_hint: browserWorkflowHint?.pending_step ?? null,
						browser_last_transition_hint: browserWorkflowHint?.last_transition ?? null,
						browser_last_error_hint: browserWorkflowHint?.last_error ?? null,
						browser_challenge_detected_hint: browserWorkflowHint?.challenge_detected ?? false,
						browser_cleanup_intent_hint: browserWorkflowHint?.cleanup_intent ?? false,
						browser_policy_needed_hint: browserWorkflowHint?.policy_needed ?? false
					}),
					profile
				})
			});
			const body = (await response.json()) as {
				ok?: boolean;
				error?: string;
				report?: unknown;
			};
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `chat failed (${response.status})`);
			}
			const reply = extractAssistantPayload(body.report);
			if (reply.workflowHint) {
				browserWorkflowHint = reply.workflowHint;
				persistWorkflowHintCache(browserWorkflowHint);
			}
			if (shouldAutoOpenUrl(reply.text)) {
				const url = extractFirstUrl(reply.text);
				if (url) {
					const opened = window.open(url, '_blank', 'noopener,noreferrer');
					if (!opened) {
						toast('Popup blocked. Click the link in chat to open it.', 'warning');
					}
				}
			}
			messages = [
				...messages,
				{
					role: 'assistant',
					text: reply.text,
					uiBlocks: reply.uiBlocks,
					actions: reply.actions,
					timestamp: Date.now()
				}
			];
			persistMessagesCache(messages);
			startTypewriter(messages.length - 1);
			await maybeSendBrowserNotification(reply.notification, reply.actions);
		} catch (error) {
			const message =
				error instanceof DOMException && error.name === 'AbortError'
					? 'Chat request timed out. Check container runtime health and credential setup in /ui/configure.'
					: error instanceof Error
						? error.message
						: String(error);
			messages = [...messages, { role: 'error', text: message, timestamp: Date.now() }];
			persistMessagesCache(messages);
			toast(message, 'danger');
		} finally {
			if (requestTimeout) {
				clearTimeout(requestTimeout);
			}
			busy = false;
			await scrollToBottom();
		}
	}

	function handleActionClick(action: ChatActionButton) {
		if (busy) {
			return;
		}
		void handleSend(action.prompt, []);
	}

	function clearConversation() {
		stopTypewriter();
		browserWorkflowHint = null;
		persistWorkflowHintCache(null);
		messages = [
			{
				role: 'assistant',
				text: 'Conversation cleared. Ask another question when ready.',
				timestamp: Date.now(),
			}
		];
		persistMessagesCache(messages);
	}

	function extractHistoryMessages(report: unknown): Array<{ role: string; content: string; created_at: string }> | null {
		const seen = new Set<unknown>();
		const walk = (value: unknown): Array<{ role: string; content: string; created_at: string }> | null => {
			if (!isRecord(value) || seen.has(value)) return null;
			seen.add(value);
			if (asOptionalString(value.mode) === 'load_history' && Array.isArray(value.messages)) {
				return value.messages as Array<{ role: string; content: string; created_at: string }>;
			}
			const rawPayload = value.raw;
			if (typeof rawPayload === 'string') {
				const parsed = parseJsonOutput(rawPayload);
				if (parsed) {
					const found = walk(parsed);
					if (found) return found;
				}
			}
			const spawned = isRecord(value.spawn_child_result) ? value.spawn_child_result : null;
			if (spawned && spawned.report) {
				const found = walk(spawned.report);
				if (found) return found;
			}
			if (Array.isArray(value.agents)) {
				for (const agent of value.agents) {
					if (isRecord(agent)) {
						const found = walk(agent.data);
						if (found) return found;
					}
				}
			}
			for (const nested of Object.values(value)) {
				const found = walk(nested);
				if (found) return found;
			}
			return null;
		};
		return walk(report);
	}

	let historyLoaded = $state(false);

	const DEFAULT_GREETING: ChatMessage = {
		role: 'assistant',
		text: "Hello! I'm your AI assistant. Ask me anything and I'll do my best to help.",
		timestamp: Date.now(),
	};

	async function loadChatHistory() {
		busy = true;
		const cachedAtLoad = loadMessagesCache();
		try {
			const response = await fetch('/api/task', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					task: 'load chat history',
					resource: 'plugin:chat_agent',
					action: 'read',
					target: JSON.stringify({
						op: 'load_history',
						channel: UI_CHAT_CHANNEL,
						limit: 50,
					}),
					profile: 'codex',
				}),
			});
			const body = (await response.json()) as { ok?: boolean; report?: unknown };
			if (response.ok && body.ok && body.report) {
				const historyMessages = extractHistoryMessages(body.report);
				if (historyMessages && historyMessages.length > 0) {
					const loaded: ChatMessage[] = historyMessages
						.filter((m) => m.role === 'user' || m.role === 'assistant')
						.map((m) => ({
							role: m.role as 'user' | 'assistant',
							text: m.content,
							timestamp: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
						}));
					if (loaded.length > 0) {
						messages = mergeHistoryWithCache(loaded, cachedAtLoad);
					}
				}
			}
		} catch {
			// History load is best-effort
		} finally {
			if (messages.length === 0) {
				messages = cachedAtLoad.length > 0 ? cachedAtLoad : [DEFAULT_GREETING];
			}
			persistMessagesCache(messages);
			historyLoaded = true;
			busy = false;
		}
	}

	$effect(() => {
		messages;
		scrollToBottom();
	});

	$effect(() => {
		twChars;
		if (twIndex >= 0 && messageListEl) {
			messageListEl.scrollTop = messageListEl.scrollHeight;
		}
	});

	$effect(() => {
		if (!unsafeHostEnabled && runtime === 'unsafe_host') {
			runtime = 'container';
		}
	});

	onMount(() => {
		const cached = loadMessagesCache();
		const cachedWorkflowHint = loadWorkflowHintCache();
		if (cachedWorkflowHint) {
			browserWorkflowHint = cachedWorkflowHint;
		}
		if (cached.length > 0) {
			messages = cached;
		}
		void ensureServiceWorkerRegistration();
		void loadChatHistory();
		const promptFromNotification = consumePromptFromQuery();
		if (promptFromNotification && !busy) {
			void handleSend(promptFromNotification, []);
		}
	});
</script>

{#if !pluginEnabled}
	<div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
		<svg class="h-16 w-16 text-[var(--text-soft)] opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
			<path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
		</svg>
		<h2 class="text-lg font-semibold">Chat Plugin Disabled</h2>
		<p class="max-w-md text-sm text-[var(--text-soft)]">
			The Chat plugin is currently disabled. Enable it from the
			<a href="/ui/plugins" class="text-[var(--accent)] hover:underline">Plugins</a> page to use this feature.
		</p>
	</div>
{:else}
<div class="chat-container">
	<!-- Chat header -->
	<div class="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
		<div class="flex items-center gap-3">
			<div class="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent-soft)]">
				<svg class="h-5 w-5 text-[var(--accent-strong)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
				</svg>
			</div>
			<div>
				<h1 class="text-sm font-semibold">Chat Agent</h1>
				<p class="text-xs text-[var(--text-soft)]">
					{busy && !historyLoaded ? 'Loading...' : busy ? 'Thinking...' : 'Online'}
				</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<select
				class="field h-8 rounded-lg px-2 text-xs"
				bind:value={profile}
			>
				<option value="codex">Codex</option>
				<option value="default">Default</option>
				<option value="claude_code">Claude Code</option>
			</select>
			<select class="field h-8 rounded-lg px-2 text-xs" bind:value={runtime} title="Execution runtime">
				<option value="container">Container</option>
				{#if unsafeHostEnabled}
					<option value="unsafe_host">Unsafe Host</option>
				{/if}
			</select>
			<button
				class="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--text)]"
				onclick={clearConversation}
				disabled={busy}
				title="Clear conversation"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
				</svg>
			</button>
		</div>
	</div>

	<!-- Message list -->
	<div bind:this={messageListEl} class="chat-message-list">
		<div class="mx-auto max-w-3xl space-y-4">
			{#if !historyLoaded}
				<div class="flex items-center justify-center py-8 text-sm text-[var(--text-soft)]">
					<svg class="mr-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					Loading conversation...
				</div>
			{:else}
				{#each messages as message, index (`${message.timestamp}-${index}`)}
					<ChatBubble
						role={message.role}
						text={displayText(message, index)}
						timestamp={message.timestamp}
						files={message.files ?? []}
						uiBlocks={message.uiBlocks ?? []}
						actionButtons={twIndex === index ? [] : (message.actions ?? [])}
						onActionClick={handleActionClick}
					/>
				{/each}
			{/if}
			{#if busy && historyLoaded && twIndex < 0}
				<TypingIndicator />
			{/if}
		</div>
	</div>

	<!-- Input bar -->
	<ChatInput
		bind:value={prompt}
		{busy}
		onsubmit={handleSend}
	/>
</div>
{/if}
