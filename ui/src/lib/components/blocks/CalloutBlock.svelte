<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'callout' }> }>();

	const toneClass = $derived(`callout callout-${block.tone}`);

	const toneIcon = $derived(
		block.tone === 'tip'
			? '\u2728'
			: block.tone === 'warning'
				? '\u26A0'
				: block.tone === 'danger'
					? '\u26D4'
					: '\u2139'
	);
</script>

<div class={toneClass}>
	<div class="flex items-start gap-2">
		<span class="text-sm">{toneIcon}</span>
		<div>
			{#if block.title}
				<p class="font-semibold">{block.title}</p>
			{/if}
			<p class="text-sm" class:mt-0.5={block.title}>{block.message}</p>
		</div>
	</div>
</div>
