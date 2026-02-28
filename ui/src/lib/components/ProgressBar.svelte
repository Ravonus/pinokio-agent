<script lang="ts">
	let {
		value = 0,
		max = 100,
		label = '',
		tone = 'accent'
	} = $props<{
		value?: number;
		max?: number;
		label?: string;
		tone?: 'accent' | 'warning' | 'danger';
	}>();

	const percent = $derived(Math.min(100, Math.max(0, (value / max) * 100)));
	const fillColor = $derived(
		tone === 'warning' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--accent)'
	);
</script>

{#if label}
	<div class="mb-1 flex items-center justify-between text-xs">
		<span class="text-[var(--text-soft)]">{label}</span>
		<span class="mono">{Math.round(percent)}%</span>
	</div>
{/if}
<div class="progress-track">
	<div class="progress-fill" style={`width: ${percent}%; background: ${fillColor}`}></div>
</div>
