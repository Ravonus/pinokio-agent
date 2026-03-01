<script lang="ts">
	import ChatPreviewBlocks from './ChatPreviewBlocks.svelte';

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
		total_count?: number;
		items: ChatPreviewItem[];
	};

	type ChatActionButton = {
		id: string;
		label: string;
		prompt: string;
		description?: string;
	};

	let {
		role,
		text,
		timestamp,
		files = [],
		uiBlocks = [],
		actionButtons = [],
		onActionClick = null
	} = $props<{
		role: 'user' | 'assistant' | 'error';
		text: string;
		timestamp: number;
		files?: string[];
		uiBlocks?: ChatUiBlock[];
		actionButtons?: ChatActionButton[];
		onActionClick?: ((action: ChatActionButton) => void) | null;
	}>();

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	type TextSegment = {
		kind: 'text' | 'link';
		value: string;
	};

	function splitTextSegments(value: string): TextSegment[] {
		const input = String(value ?? '');
		if (!input) {
			return [{ kind: 'text', value: '' }];
		}
		const segments: TextSegment[] = [];
		const re = /(https?:\/\/[^\s<>"'`]+)/gi;
		let lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = re.exec(input)) !== null) {
			const start = match.index;
			const url = match[0] ?? '';
			if (start > lastIndex) {
				segments.push({
					kind: 'text',
					value: input.slice(lastIndex, start)
				});
			}
			segments.push({
				kind: 'link',
				value: url
			});
			lastIndex = start + url.length;
		}
		if (lastIndex < input.length) {
			segments.push({
				kind: 'text',
				value: input.slice(lastIndex)
			});
		}
		return segments;
	}
</script>

<div
	class="raise-in flex"
	class:justify-end={role === 'user'}
	class:justify-start={role !== 'user'}
>
	<div class="max-w-[85%] md:max-w-[70%]">
		{#if role === 'user'}
			<div class="chat-bubble-user">
				<p class="whitespace-pre-wrap text-sm leading-relaxed">
					{#each splitTextSegments(text) as segment}
						{#if segment.kind === 'link'}
							<a href={segment.value} target="_blank" rel="noopener noreferrer" class="underline">
								{segment.value}
							</a>
						{:else}
							{segment.value}
						{/if}
					{/each}
				</p>
			</div>
		{:else if role === 'error'}
			<div class="chat-bubble-error">
				<div class="mb-1 flex items-center gap-1.5">
					<svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<span class="text-xs font-medium uppercase tracking-wide">Error</span>
				</div>
				<p class="whitespace-pre-wrap text-sm leading-relaxed">
					{#each splitTextSegments(text) as segment}
						{#if segment.kind === 'link'}
							<a href={segment.value} target="_blank" rel="noopener noreferrer" class="underline">
								{segment.value}
							</a>
						{:else}
							{segment.value}
						{/if}
					{/each}
				</p>
			</div>
			{:else}
				<div class="chat-bubble-assistant">
					<p class="whitespace-pre-wrap text-sm leading-relaxed">
						{#each splitTextSegments(text) as segment}
							{#if segment.kind === 'link'}
								<a href={segment.value} target="_blank" rel="noopener noreferrer" class="text-[var(--accent)] underline">
									{segment.value}
								</a>
							{:else}
								{segment.value}
							{/if}
						{/each}
					</p>
					<ChatPreviewBlocks blocks={uiBlocks} />
					{#if actionButtons.length > 0}
						<div class="mt-3 flex flex-wrap gap-2">
							{#each actionButtons as action (`${action.id}-${action.prompt}`)}
								<button
									type="button"
									class="btn btn-primary btn-sm"
									title={action.description ?? action.label}
									onclick={() => onActionClick?.(action)}
								>
									{action.label}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

		{#if files.length > 0}
			<div class="mt-1.5 flex flex-wrap gap-1.5" class:justify-end={role === 'user'}>
				{#each files as file}
					<span class="inline-flex items-center gap-1 rounded-md bg-[var(--bg-2)] px-2 py-0.5 text-xs text-[var(--text-soft)]">
						<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
						</svg>
						{file}
					</span>
				{/each}
			</div>
		{/if}

		<p
			class="mono mt-1 text-[10px] text-[var(--text-soft)]"
			class:text-right={role === 'user'}
		>
			{formatTime(timestamp)}
		</p>
	</div>
</div>
