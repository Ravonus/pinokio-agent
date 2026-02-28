<script lang="ts">
	import type { ManagedServiceStatus } from '$lib/ui/manager';

	let { service } = $props<{ service: ManagedServiceStatus }>();

	const statusColor = $derived(
		service.running && service.health === 'healthy'
			? 'var(--success, #22c55e)'
			: service.running
				? 'var(--warning, #f59e0b)'
				: 'var(--danger, #ef4444)'
	);

	const statusText = $derived(
		service.running && service.health === 'healthy'
			? 'Healthy'
			: service.running && service.health
				? service.health
				: service.running
					? 'Running'
					: 'Stopped'
	);

	const imageTag = $derived(service.image.split(':').pop() ?? service.image);
</script>

<div class="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[color-mix(in_srgb,var(--bg-1)_50%,var(--surface))] px-3 py-2">
	<!-- Status dot -->
	<span
		class="h-2.5 w-2.5 shrink-0 rounded-full"
		style="background: {statusColor}"
		title={statusText}
	></span>

	<!-- Info -->
	<div class="min-w-0 flex-1">
		<div class="flex items-center gap-2">
			<span class="text-xs font-semibold">{service.name}</span>
			<span class="text-[10px] text-[var(--text-soft)] font-mono">{service.image}</span>
		</div>
		<div class="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-soft)]">
			<span>{statusText}</span>
			{#if service.host_ports.length > 0}
				<span class="font-mono">{service.host_ports.join(', ')}</span>
			{/if}
			{#if service.container_name}
				<span class="font-mono opacity-60">{service.container_name}</span>
			{/if}
		</div>
	</div>

	<!-- Container icon -->
	<svg class="h-4 w-4 shrink-0 text-[var(--text-soft)] opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
		<path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
	</svg>
</div>
