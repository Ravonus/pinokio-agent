<script lang="ts">
	let { size = 'md', label = '' } = $props<{ size?: 'sm' | 'md' | 'lg'; label?: string }>();
	const sizeClass = $derived(size === 'sm' ? 'spinner-sm' : size === 'lg' ? 'spinner-lg' : '');
</script>

<span class="inline-flex items-center gap-2">
	<span class={`spinner ${sizeClass}`}></span>
	{#if label}
		<span class="text-sm text-[var(--text-soft)]">{label}</span>
	{/if}
</span>
