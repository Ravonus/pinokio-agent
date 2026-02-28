<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import BlockRenderer from './BlockRenderer.svelte';

	let {
		block,
		pageId = ''
	} = $props<{
		block: Extract<UiBlock, { type: 'tabs' }>;
		pageId?: string;
	}>();

	const defaultTab = $derived(block.tabs[0]?.id ?? '');
	let activeTab = $state('');
	$effect(() => {
		if (!activeTab || !block.tabs.some((t: (typeof block.tabs)[number]) => t.id === activeTab)) {
			activeTab = defaultTab;
		}
	});
</script>

<div>
	<div class="tab-row mb-4">
		{#each block.tabs as tab}
			<button
				class="tab-btn"
				aria-current={activeTab === tab.id ? 'page' : undefined}
				onclick={() => (activeTab = tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</div>
	{#each block.tabs as tab}
		{#if tab.id === activeTab}
			<div class="space-y-3">
				{#each tab.blocks as childBlock}
					<BlockRenderer block={childBlock} {pageId} />
				{/each}
			</div>
		{/if}
	{/each}
</div>
