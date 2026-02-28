<script lang="ts">
	import type { TopologyGraph } from '$lib/ui/topology';

	let {
		autoRefresh = $bindable(true),
		layoutLocked = $bindable(false),
		graph,
		onzoomin,
		onzoomout,
		onfit,
		onrefresh
	} = $props<{
		autoRefresh?: boolean;
		layoutLocked?: boolean;
		graph?: TopologyGraph;
		onzoomin: () => void;
		onzoomout: () => void;
		onfit: () => void;
		onrefresh: () => void;
	}>();

	const nodeCount = $derived(graph?.nodes.length ?? 0);
	const healthyCount = $derived(graph?.nodes.filter(n => n.status === 'healthy').length ?? 0);
	const degradedCount = $derived(graph?.nodes.filter(n => n.status === 'degraded').length ?? 0);
	const downCount = $derived(graph?.nodes.filter(n => n.status === 'down').length ?? 0);
</script>

<div class="absolute right-3 top-3 z-20 flex flex-col gap-1 md:right-4 md:top-4">
	<button
		class="topology-control-btn"
		onclick={onzoomin}
		title="Zoom in"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m6-6H6" />
		</svg>
	</button>
	<button
		class="topology-control-btn"
		onclick={onzoomout}
		title="Zoom out"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M18 12H6" />
		</svg>
	</button>
	<button
		class="topology-control-btn"
		onclick={onfit}
		title="Fit to view"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
		</svg>
	</button>
	<div class="my-0.5 border-t border-[var(--line)]"></div>
	<button
		class="topology-control-btn"
		class:topology-control-active={layoutLocked}
		onclick={() => (layoutLocked = !layoutLocked)}
		title={layoutLocked ? 'Unlock layout' : 'Lock layout'}
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			{#if layoutLocked}
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
			{:else}
				<path stroke-linecap="round" stroke-linejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
			{/if}
		</svg>
	</button>
	<div class="my-0.5 border-t border-[var(--line)]"></div>
	<button
		class="topology-control-btn"
		onclick={onrefresh}
		title="Refresh now"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
		</svg>
	</button>
	<button
		class="topology-control-btn"
		class:topology-control-active={autoRefresh}
		onclick={() => (autoRefresh = !autoRefresh)}
		title={autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
		</svg>
	</button>
</div>

<!-- Status summary -->
{#if nodeCount > 0}
	<div class="absolute right-3 bottom-3 z-20 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-[10px] shadow-sm md:right-4 md:bottom-4">
		<span class="text-[var(--text-soft)]">{nodeCount} nodes</span>
		{#if healthyCount > 0}
			<span class="ml-2 text-[#22c55e]">{healthyCount} healthy</span>
		{/if}
		{#if degradedCount > 0}
			<span class="ml-2 text-[#f59e0b]">{degradedCount} degraded</span>
		{/if}
		{#if downCount > 0}
			<span class="ml-2 text-[#ef4444]">{downCount} down</span>
		{/if}
	</div>
{/if}
