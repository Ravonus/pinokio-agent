<script lang="ts">
	import type { UiBlock, UiTone } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'key_values' }> }>();

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

<div class="surface-subtle rounded-xl border border-[var(--line)] p-3">
	<dl class="grid grid-cols-1 gap-2 md:grid-cols-[minmax(220px,1fr)_2fr]">
		{#each block.items as item}
			<dt class="mono subtle text-xs">{item.key}</dt>
			<dd class={`mono text-sm ${toneClass(item.tone)}`}>{item.value}</dd>
		{/each}
	</dl>
</div>
