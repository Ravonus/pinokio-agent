<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import BlockRenderer from './BlockRenderer.svelte';

	let {
		block,
		pageId = ''
	} = $props<{
		block: Extract<UiBlock, { type: 'accordion' }>;
		pageId?: string;
	}>();

	let openIds = $state<Set<string>>(new Set());

	function toggle(id: string) {
		const next = new Set(openIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		openIds = next;
	}
</script>

<div class="space-y-2">
	{#each block.items as item}
		<div class="surface-subtle rounded-xl border border-[var(--line)]">
			<button
				class="flex w-full items-center justify-between p-3 text-left text-sm font-semibold"
				onclick={() => toggle(item.id)}
			>
				{item.title}
				<span
					class="text-[var(--text-soft)] transition-transform"
					class:rotate-180={openIds.has(item.id)}
				>
					&#9662;
				</span>
			</button>
			{#if openIds.has(item.id)}
				<div class="space-y-3 border-t border-[var(--line)] p-3">
					{#each item.blocks as childBlock}
						<BlockRenderer block={childBlock} {pageId} />
					{/each}
				</div>
			{/if}
		</div>
	{/each}
</div>
