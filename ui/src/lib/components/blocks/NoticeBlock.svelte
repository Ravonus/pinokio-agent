<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import StatusPill from '../StatusPill.svelte';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'notice' }> }>();
</script>

<div class="surface-subtle rounded-xl border border-[var(--line)] p-3">
	<StatusPill tone={block.tone}>{block.tone}</StatusPill>
	<p class="mt-2 font-medium">{block.message}</p>
	{#if block.detail}
		<p class="subtle mt-1 text-sm">{block.detail}</p>
	{/if}
</div>
