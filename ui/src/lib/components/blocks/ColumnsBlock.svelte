<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import BlockRenderer from './BlockRenderer.svelte';

	let {
		block,
		pageId = ''
	} = $props<{
		block: Extract<UiBlock, { type: 'columns' }>;
		pageId?: string;
	}>();

	const gridClass = $derived(
		block.count === 1
			? 'grid grid-cols-1 gap-4'
			: block.count === 3
				? 'grid grid-cols-1 gap-4 md:grid-cols-3'
				: block.count === 4
					? 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4'
					: 'grid grid-cols-1 gap-4 md:grid-cols-2'
	);
</script>

<div class={gridClass}>
	{#each block.columns as column}
		<div class="space-y-3">
			{#each column.blocks as childBlock}
				<BlockRenderer block={childBlock} {pageId} />
			{/each}
		</div>
	{/each}
</div>
