<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import ProgressBar from '../ProgressBar.svelte';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'progress' }> }>();

	function toneProp(
		tone: string | undefined
	): 'accent' | 'warning' | 'danger' {
		if (tone === 'warning') return 'warning';
		if (tone === 'danger') return 'danger';
		return 'accent';
	}
</script>

<div class="space-y-3">
	{#each block.items as item}
		<ProgressBar
			value={item.value}
			max={item.max}
			label={item.label}
			tone={toneProp(item.tone)}
		/>
	{/each}
</div>
