<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from '$lib/components/Toast.svelte';
	import ChatBubble from '$lib/components/chat/ChatBubble.svelte';
	import TypingIndicator from '$lib/components/chat/TypingIndicator.svelte';
	import ChatInput from '$lib/components/chat/ChatInput.svelte';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const pluginEnabled = $derived(data.pluginEnabled !== false);
	const unsafeHostEnabled = $derived(data.unsafeHostEnabled === true);

	const UI_CHAT_CHANNEL = 'ui_chat';

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

	type ChatMessage = {
		role: 'user' | 'assistant' | 'error';
		text: string;
		timestamp: number;
		files?: string[];
		uiBlocks?: ChatUiBlock[];
	};

	let prompt = $state('');
	let profile = $state('codex');
	let runtime = $state<'container' | 'unsafe_host'>('container');
	let busy = $state(false);
	let messageListEl: HTMLDivElement | undefined = $state();
	let messages = $state<ChatMessage[]>([
		{
			role: 'assistant',
			text: "Hello! I'm your AI assistant. Ask me anything and I'll do my best to help.",
			timestamp: Date.now()
		}
	]);

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

	function extractAssistantPayload(report: unknown): { text: string; uiBlocks: ChatUiBlock[] } {
		const seen = new Set<unknown>();
		const textCandidates: string[] = [];
		const uiBlocks: ChatUiBlock[] = [];
		const uiBlockKeys = new Set<string>();
		let explorerSummary: string | null = null;

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

			const plugin = asOptionalString(value.plugin) ?? 'unknown';
			const directWriteSummary = summarizeWriteResult(value);
			if (directWriteSummary) {
				textCandidates.push(directWriteSummary);
			}

			if (Array.isArray(value.ui_blocks)) {
				for (const rawBlock of value.ui_blocks) {
					addUiBlock(normalizeUiBlock(rawBlock, plugin));
				}
			}

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

		const text =
			textCandidates.find((candidate) => candidate.length > 0) ??
			explorerSummary ??
			(uiBlocks.length > 0 ? 'Here is what I found.' : 'Task completed.');
		return { text, uiBlocks };
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
		const fileNames = files.map((f) => f.name);
		messages = [...messages, { role: 'user', text, timestamp: Date.now(), files: fileNames }];
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
							allow_unsafe_fallback: false
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
				messages = [
					...messages,
					{
						role: 'assistant',
						text: reply.text,
						uiBlocks: reply.uiBlocks,
						timestamp: Date.now()
					}
				];
		} catch (error) {
			const message =
				error instanceof DOMException && error.name === 'AbortError'
					? 'Chat request timed out. Check container runtime health and credential setup in /ui/configure.'
					: error instanceof Error
						? error.message
						: String(error);
			messages = [...messages, { role: 'error', text: message, timestamp: Date.now() }];
			toast(message, 'danger');
		} finally {
			if (requestTimeout) {
				clearTimeout(requestTimeout);
			}
			busy = false;
			await scrollToBottom();
		}
	}

	function clearConversation() {
		messages = [
			{
				role: 'assistant',
				text: 'Conversation cleared. Ask another question when ready.',
				timestamp: Date.now()
			}
		];
	}

	$effect(() => {
		messages;
		scrollToBottom();
	});

	$effect(() => {
		if (!unsafeHostEnabled && runtime === 'unsafe_host') {
			runtime = 'container';
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
					{busy ? 'Thinking...' : 'Online'}
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
				{#each messages as message, index (`${message.timestamp}-${index}`)}
					<ChatBubble
						role={message.role}
						text={message.text}
						timestamp={message.timestamp}
						files={message.files ?? []}
						uiBlocks={message.uiBlocks ?? []}
					/>
				{/each}
			{#if busy}
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
