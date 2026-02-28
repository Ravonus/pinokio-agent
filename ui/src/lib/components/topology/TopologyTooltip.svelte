<script lang="ts">
	import type { TopologyNode, TopologyEdge } from '$lib/ui/topology';

	let {
		node,
		edges = [],
		x = 0,
		y = 0,
		containerWidth = 800,
		containerHeight = 600
	} = $props<{
		node: TopologyNode;
		edges?: TopologyEdge[];
		x?: number;
		y?: number;
		containerWidth?: number;
		containerHeight?: number;
	}>();

	const connectionCount = $derived(
		edges.filter((e) => e.source === node.id || e.target === node.id).length
	);

	const statusBadge = $derived(
		node.status === 'healthy'
			? 'badge-ok'
			: node.status === 'degraded'
				? 'badge-warn'
				: node.status === 'down'
					? 'badge-danger'
					: 'badge-neutral'
	);

	const statusText = $derived(
		node.status === 'healthy'
			? 'Running normally'
			: node.status === 'degraded'
				? 'Experiencing issues'
				: node.status === 'down'
					? 'Offline'
					: 'Status unknown'
	);

	// Clamp position to stay within container
	const tooltipWidth = 200;
	const tooltipHeight = 140;
	const clampedX = $derived(
		Math.min(Math.max(x + 16, 8), containerWidth - tooltipWidth - 8)
	);
	const clampedY = $derived(
		Math.min(Math.max(y - 10, 8), containerHeight - tooltipHeight - 8)
	);
</script>

<div
	class="pointer-events-none absolute z-50 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3 shadow-lg"
	style="left: {clampedX}px; top: {clampedY}px; min-width: 180px; max-width: 240px;"
>
	<div class="flex items-center justify-between gap-2">
		<p class="text-sm font-semibold">{node.label}</p>
		<span class="badge {statusBadge} text-[10px]">{node.status}</span>
	</div>
	<p class="mt-0.5 text-[10px] text-[var(--text-soft)]">{statusText}</p>
	<div class="mt-1 flex items-center gap-3 text-[10px] text-[var(--text-soft)]">
		<span class="mono">{node.kind}</span>
		{#if connectionCount > 0}
			<span>{connectionCount} connection{connectionCount === 1 ? '' : 's'}</span>
		{/if}
	</div>
	{#if Object.keys(node.detail).length > 0}
		<div class="mt-2 space-y-0.5">
			{#each Object.entries(node.detail).slice(0, 4) as [key, value]}
				<div class="flex justify-between gap-3 text-[10px]">
					<span class="text-[var(--text-soft)]">{key}</span>
					<span class="mono truncate text-right" style="max-width: 120px;">{value}</span>
				</div>
			{/each}
			{#if Object.keys(node.detail).length > 4}
				<p class="text-[9px] text-[var(--text-soft)] opacity-60">+{Object.keys(node.detail).length - 4} more...</p>
			{/if}
		</div>
	{/if}
</div>
