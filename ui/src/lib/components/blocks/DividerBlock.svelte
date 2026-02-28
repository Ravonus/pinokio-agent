<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'divider' }> }>();
</script>

{#if block.label}
	<div class="divider-labeled">{block.label}</div>
{:else}
	<hr class="divider" />
{/if}
