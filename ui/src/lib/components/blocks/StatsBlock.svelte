<script lang="ts">
	import type { UiBlock, UiTone } from '$lib/ui/model';
	import StatusPill from '../StatusPill.svelte';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'stats' }> }>();

	const toneClass = (tone: UiTone | undefined): string => {
		switch (tone) {
			case 'success':
				return 'text-[var(--accent-strong)]';
			case 'warning':
				return 'text-[var(--warn)]';
			case 'danger':
				return 'text-[var(--danger)]';
			default:
				return 'text-[var(--text)]';
		}
	};
</script>

<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
	{#each block.items as item}
		<article class="surface-subtle rounded-xl border border-[var(--line)] p-3">
			<div class="flex items-center justify-between gap-2">
				<p class="text-sm font-semibold">{item.label}</p>
				<StatusPill tone={item.tone}>{item.tone ?? 'neutral'}</StatusPill>
			</div>
			<p class={`mono mt-2 text-base font-semibold ${toneClass(item.tone)}`}>{item.value}</p>
			{#if item.detail}
				<p class="mono subtle mt-1 text-xs">{item.detail}</p>
			{/if}
		</article>
	{/each}
</div>
