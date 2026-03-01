<script lang="ts">
	import type { TopologyNode, TopologyEdge } from '$lib/ui/topology';

	let {
		node,
		edges = [],
		isPinned = false,
		onclose,
		onselectnode,
		ontogglepin,
		oncenter
	} = $props<{
		node: TopologyNode;
		edges?: TopologyEdge[];
		isPinned?: boolean;
		onclose: () => void;
		onselectnode?: (nodeId: string) => void;
		ontogglepin?: () => void;
		oncenter?: () => void;
	}>();

	const connectedEdges = $derived(
		edges.filter((e: TopologyEdge) => e.source === node.id || e.target === node.id)
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

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	function getConnectedNodeId(edge: TopologyEdge): string {
		return edge.source === node.id ? edge.target : edge.source;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Desktop: right panel. Mobile: bottom sheet -->
<div class="topology-detail-panel">
	<div class="flex items-start justify-between gap-2 border-b border-[var(--line)] p-4">
		<div>
			<h2 class="text-base font-semibold">{node.label}</h2>
			<div class="mt-1 flex items-center gap-2">
				<span class="badge {statusBadge}">{node.status}</span>
				<span class="mono text-xs text-[var(--text-soft)]">{node.kind}</span>
			</div>
			<p class="mt-1 text-xs text-[var(--text-soft)]">{statusText}</p>
		</div>
		<button
			class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--text)]"
			onclick={onclose}
			aria-label="Close panel"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		</button>
	</div>

	<!-- Action buttons -->
	<div class="flex gap-2 border-b border-[var(--line)] px-4 py-2">
		{#if ontogglepin}
			<button
				class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
				class:bg-[var(--accent-soft)]={isPinned}
				class:text-[var(--accent-strong)]={isPinned}
				class:bg-[var(--bg-2)]={!isPinned}
				class:text-[var(--text-soft)]={!isPinned}
				class:hover:bg-[var(--bg-3)]={!isPinned}
				onclick={ontogglepin}
			>
				<svg class="h-3.5 w-3.5" fill={isPinned ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
				</svg>
				{isPinned ? 'Unpin' : 'Pin'}
			</button>
		{/if}
		{#if oncenter}
			<button
				class="flex items-center gap-1.5 rounded-md bg-[var(--bg-2)] px-3 py-1.5 text-xs font-medium text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-3)]"
				onclick={oncenter}
			>
				<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 10l-4 4m0 0l-4-4m4 4V3m0 17a9 9 0 110-18 9 9 0 010 18z" />
				</svg>
				Center
			</button>
		{/if}
	</div>

	<div class="flex-1 overflow-y-auto p-4">
		<!-- Metadata -->
		{#if Object.keys(node.detail).length > 0}
			<div class="space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">Details</h3>
				{#each Object.entries(node.detail) as [key, value]}
					<div class="flex justify-between gap-3 rounded-md bg-[var(--bg-1)] px-3 py-2 text-sm">
						<span class="text-[var(--text-soft)]">{key}</span>
						<span class="mono truncate text-right font-medium">{value}</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Connected edges -->
		{#if connectedEdges.length > 0}
			<div class="mt-4 space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--text-soft)]">
					Connections ({connectedEdges.length})
				</h3>
				{#each connectedEdges as edge}
					{@const connectedId = getConnectedNodeId(edge)}
					<button
						class="flex w-full items-center gap-2 rounded-md bg-[var(--bg-1)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-2)]"
						onclick={() => onselectnode?.(connectedId)}
					>
						<span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full topology-edge-dot-{edge.kind}"></span>
						<span class="flex-1 truncate">
							{connectedId}
						</span>
						<span class="mono text-xs text-[var(--text-soft)]">{edge.kind}</span>
						<svg class="h-3 w-3 shrink-0 text-[var(--text-soft)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
						</svg>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
