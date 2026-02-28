<script lang="ts">
	import type { UiBlock, UiTone } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'metric_cards' }> }>();

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

	const trendIcon = (trend: 'up' | 'down' | 'flat' | undefined): string => {
		switch (trend) {
			case 'up':
				return '\u2191';
			case 'down':
				return '\u2193';
			case 'flat':
				return '\u2192';
			default:
				return '';
		}
	};

	const trendColor = (trend: 'up' | 'down' | 'flat' | undefined): string => {
		switch (trend) {
			case 'up':
				return 'text-[var(--accent-strong)]';
			case 'down':
				return 'text-[var(--danger)]';
			default:
				return 'text-[var(--text-soft)]';
		}
	};
</script>

<div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
	{#each block.items as item}
		<article class="surface-subtle rounded-xl border border-[var(--line)] p-4">
			<p class="subtle text-xs font-medium uppercase tracking-wide">{item.label}</p>
			<p class={`mt-1 text-2xl font-bold ${toneClass(item.tone)}`}>{item.value}</p>
			{#if item.change || item.trend}
				<p class={`mono mt-1 text-xs ${trendColor(item.trend)}`}>
					{#if item.trend}
						<span>{trendIcon(item.trend)}</span>
					{/if}
					{#if item.change}
						<span>{item.change}</span>
					{/if}
				</p>
			{/if}
		</article>
	{/each}
</div>
