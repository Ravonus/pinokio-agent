<script lang="ts">
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

	const MAX_VISIBLE_ITEMS = 60;

	let { blocks = [] } = $props<{
		blocks?: ChatUiBlock[];
	}>();

	function formatBytes(value?: number | null): string {
		if (!Number.isFinite(value) || (value ?? 0) < 0) {
			return '';
		}
		const bytes = value as number;
		if (bytes < 1024) {
			return `${bytes} B`;
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		}
		if (bytes < 1024 * 1024 * 1024) {
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	function extensionFromName(name: string): string {
		const value = String(name || '');
		const index = value.lastIndexOf('.');
		if (index <= 0 || index === value.length - 1) {
			return '';
		}
		return value.slice(index + 1).toLowerCase();
	}

	function thumbForItem(item: ChatPreviewItem): string {
		const custom = typeof item.thumbnail === 'string' ? item.thumbnail.trim() : '';
		if (custom) {
			return custom.slice(0, 4).toUpperCase();
		}
		if (item.kind === 'directory') {
			return 'DIR';
		}
		const ext = extensionFromName(item.name);
		if (!ext) {
			return 'FILE';
		}
		if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff'].includes(ext)) {
			return 'IMG';
		}
		if (['mov', 'mp4', 'mkv', 'avi', 'webm'].includes(ext)) {
			return 'VID';
		}
		if (['mp3', 'wav', 'ogg', 'aac', 'm4a'].includes(ext)) {
			return 'AUD';
		}
		if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
			return 'ZIP';
		}
		if (ext === 'pdf') {
			return 'PDF';
		}
		if (
			['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'java', 'c', 'cpp', 'json', 'yaml', 'yml', 'toml', 'md'].includes(
				ext
			)
		) {
			return 'CODE';
		}
		return ext.slice(0, 4).toUpperCase();
	}

	function itemMeta(item: ChatPreviewItem): string {
		const parts: string[] = [];
		parts.push(item.kind === 'directory' ? 'Directory' : 'File');
		const size = formatBytes(item.size);
		if (size) {
			parts.push(size);
		}
		return parts.join(' · ');
	}

	function shownCount(block: ChatUiBlock): number {
		return Math.min(block.items.length, MAX_VISIBLE_ITEMS);
	}

	function isTelemetryBlock(block: ChatUiBlock): boolean {
		return block.type === 'playwright_workflow_telemetry';
	}
</script>

{#if blocks.length > 0}
	<div class="chat-preview-stack">
		{#each blocks as block, index (`${block.type}-${block.title ?? 'preview'}-${index}`)}
			<section class="chat-preview-block">
				<div class="mb-2">
					<p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">
						{block.title ?? 'Plugin Preview'}
					</p>
					{#if block.subtitle}
						<p class="mt-0.5 text-xs text-[var(--text-soft)]">{block.subtitle}</p>
					{/if}
					{#if block.scope_dir}
						<p class="mono mt-0.5 truncate text-[10px] text-[var(--text-soft)]">{block.scope_dir}</p>
					{/if}
				</div>
				{#if isTelemetryBlock(block)}
						<div class="space-y-2">
							{#each block.items.slice(0, MAX_VISIBLE_ITEMS) as item, itemIndex (`${block.type}-${itemIndex}-${item.path ?? item.relative_path ?? item.name}`)}
								<article class="surface-subtle rounded-lg border border-[var(--line)] p-2">
									<p class="text-xs font-semibold text-[var(--text)]">{item.name}</p>
									<p class="mono mt-1 break-words text-[11px] text-[var(--text-soft)]">
										{item.relative_path ?? item.path ?? item.name}
									</p>
								</article>
							{/each}
						</div>
					{:else}
						<div class="chat-preview-grid" class:chat-preview-grid-list={block.type === 'file_list'}>
							{#each block.items.slice(0, MAX_VISIBLE_ITEMS) as item, itemIndex (`${block.type}-${itemIndex}-${item.path ?? item.relative_path ?? item.name}`)}
								<article class="chat-preview-card">
									<div class="chat-preview-thumb" data-kind={item.kind}>
										<span>{thumbForItem(item)}</span>
									</div>
								<div class="min-w-0">
									<p class="truncate text-xs font-semibold text-[var(--text)]">{item.name}</p>
									<p class="mono mt-0.5 truncate text-[10px] text-[var(--text-soft)]">
										{item.relative_path ?? item.path ?? item.name}
									</p>
									<p class="mt-0.5 text-[10px] text-[var(--text-soft)]">{itemMeta(item)}</p>
								</div>
							</article>
						{/each}
					</div>
				{/if}
				{#if (block.total_count ?? block.items.length) > shownCount(block)}
					<p class="mt-2 text-[11px] text-[var(--text-soft)]">
						Showing {shownCount(block)} of {block.total_count ?? block.items.length} items
					</p>
				{/if}
			</section>
		{/each}
	</div>
{/if}
