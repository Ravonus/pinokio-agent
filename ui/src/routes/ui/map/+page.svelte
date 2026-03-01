<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { TopologyGraph, TopologyNode } from '$lib/ui/topology';
	import { buildGroupedGraph, buildFocusedGraph } from '$lib/ui/topology';
	import { buildPluginGroups } from '$lib/ui/plugin-groups';
	import type { PageData } from './$types';
	import type { UiExtensionSurface, ManagedServiceStatus } from '$lib/ui/manager';
	import type { SocketBusActivity } from '$lib/ui/socket-bus';
	import type { EdgeActivity } from '$lib/ui/activity-mapper';
	import { mapActivityToEdges } from '$lib/ui/activity-mapper';
	import TopologyMap from '$lib/components/topology/TopologyMap.svelte';
	import TopologyDetailPanel from '$lib/components/topology/TopologyDetailPanel.svelte';
	import TopologyControls from '$lib/components/topology/TopologyControls.svelte';
	import TopologyLegend from '$lib/components/topology/TopologyLegend.svelte';
	import TopologyActivityFeed from '$lib/components/topology/TopologyActivityFeed.svelte';

	let { data } = $props<{ data: PageData }>();

	const emptyGraph: TopologyGraph = { nodes: [], edges: [], refreshedAt: '' };
	let graph = $state<TopologyGraph>(emptyGraph);
	let surfaces = $state<UiExtensionSurface[]>([]);
	let services = $state<ManagedServiceStatus[]>([]);
	let selectedNode = $state<TopologyNode | null>(null);
	let layoutLocked = $state(false);

	$effect(() => {
		graph = data.graph ?? emptyGraph;
		surfaces = (data as { surfaces?: UiExtensionSurface[] }).surfaces ?? [];
		services = (data as { services?: ManagedServiceStatus[] }).services ?? [];
	});

	// Drill-down state
	let focusedGroupId = $state<string | null>(null);
	let focusedGroupLabel = $state('');

	// Compute plugin groups from surfaces + services
	const pluginGroups = $derived.by(() => buildPluginGroups(surfaces, services));

	// Compute grouped global graph (collapses agents into group nodes)
	const groupedGraph = $derived.by(() => {
		if (graph.nodes.length === 0 || pluginGroups.groups.length === 0) return null;
		return buildGroupedGraph(graph, pluginGroups.groups);
	});

	// Compute focused drill-down graph for the active group
	const focusedGraph = $derived.by(() => {
		if (!focusedGroupId || pluginGroups.groups.length === 0) return null;
		return buildFocusedGraph(graph, pluginGroups.groups, focusedGroupId);
	});

	let autoRefresh = $state(true);
	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	let activityInterval: ReturnType<typeof setInterval> | null = null;
	let mapComponent: TopologyMap | undefined = $state();
	let lastRefreshed = $state<Date | null>(null);
	let timeSinceRefresh = $state('');

	// Activity state
	let activity = $state<SocketBusActivity>({ messages: [], channels: [], activeSenders: [] });
	let edgeActivityMap = $state<Map<string, EdgeActivity>>(new Map());

	async function refreshGraph() {
		try {
			const res = await fetch('/api/topology');
			const body = await res.json();
			if (body.ok && body.graph) {
				graph = body.graph;
				lastRefreshed = new Date();
			}
			// Also refresh surfaces/services if available
			if (body.surfaces) surfaces = body.surfaces;
			if (body.services) services = body.services;
		} catch {
			// silently fail on polling
		}
	}

	async function refreshActivity() {
		try {
			const res = await fetch('/api/activity');
			const body = await res.json();
			if (body.ok && body.activity) {
				activity = body.activity;
				// Re-map activity to edges using the active graph
				const activeGraph = focusedGroupId && focusedGraph ? focusedGraph : (groupedGraph ?? graph);
				edgeActivityMap = mapActivityToEdges(activity, activeGraph);
			}
		} catch {
			// silently fail on polling
		}
	}

	function startAutoRefresh() {
		stopAutoRefresh();
		refreshInterval = setInterval(refreshGraph, 30_000);
		activityInterval = setInterval(refreshActivity, 5_000);
	}

	function stopAutoRefresh() {
		if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}
		if (activityInterval) {
			clearInterval(activityInterval);
			activityInterval = null;
		}
	}

	let timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

	function updateTimeSince() {
		if (!lastRefreshed) {
			timeSinceRefresh = '';
			return;
		}
		const seconds = Math.floor((Date.now() - lastRefreshed.getTime()) / 1000);
		if (seconds < 5) timeSinceRefresh = 'just now';
		else if (seconds < 60) timeSinceRefresh = `${seconds}s ago`;
		else timeSinceRefresh = `${Math.floor(seconds / 60)}m ago`;
	}

	$effect(() => {
		if (autoRefresh) {
			startAutoRefresh();
		} else {
			stopAutoRefresh();
		}
	});

	onMount(() => {
		lastRefreshed = new Date();
		if (autoRefresh) startAutoRefresh();
		refreshActivity();

		timeUpdateInterval = setInterval(updateTimeSince, 5_000);
		updateTimeSince();
	});

	onDestroy(() => {
		stopAutoRefresh();
		if (timeUpdateInterval) clearInterval(timeUpdateInterval);
	});

	function handleNodeSelect(node: TopologyNode | null) {
		selectedNode = node;
	}

	function handleDrillDown(groupId: string) {
		focusedGroupId = groupId;
		selectedNode = null;
		// Look up the label from the grouped graph's group node (works for both plugin groups and synthetic groups)
		const groupNode = groupedGraph?.nodes.find((n) => n.id === `group:${groupId}`);
		focusedGroupLabel = groupNode?.label ?? groupId;
	}

	function handleDrillUp() {
		focusedGroupId = null;
		focusedGroupLabel = '';
		selectedNode = null;
	}

	function handleSelectNodeById(nodeId: string) {
		// Look in the active graph (flat or focused)
		const activeGraph = focusedGroupId && focusedGraph ? focusedGraph : (groupedGraph ?? graph);
		const node = activeGraph.nodes.find((n) => n.id === nodeId);
		if (node) {
			selectedNode = node;
			mapComponent?.centerOnNode(nodeId);
		}
	}

	function handleTogglePin() {
		if (selectedNode) {
			mapComponent?.togglePin(selectedNode.id);
		}
	}

	function handleCenterOnSelected() {
		if (selectedNode) {
			mapComponent?.centerOnNode(selectedNode.id);
		}
	}

	function handleEscapeKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && focusedGroupId) {
			e.preventDefault();
			mapComponent?.drillUp();
		}
	}

	// Re-map activity when the view changes (drill-down/up or graph refresh)
	$effect(() => {
		const activeGraph = focusedGroupId && focusedGraph ? focusedGraph : (groupedGraph ?? graph);
		if (activity.messages.length > 0 && activeGraph.edges.length > 0) {
			edgeActivityMap = mapActivityToEdges(activity, activeGraph);
		}
	});

	const isSelectedPinned = $derived(
		selectedNode ? (mapComponent?.isNodePinned(selectedNode.id) ?? false) : false
	);
</script>

<svelte:window onkeydown={handleEscapeKey} />

<div class="relative flex h-[calc(100vh-48px)] md:h-screen">
	<!-- Map -->
	<div class="flex-1">
		<TopologyMap
			bind:this={mapComponent}
			{graph}
			{groupedGraph}
			{focusedGraph}
			{edgeActivityMap}
			bind:selectedNode
			bind:layoutLocked
			onselect={handleNodeSelect}
			ondrilldown={handleDrillDown}
			ondrillup={handleDrillUp}
		/>
	</div>

	<!-- Breadcrumb (when drilled into a group) -->
	{#if focusedGroupId}
		<div class="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 shadow-md md:left-4 md:top-4">
			<button
				class="flex items-center gap-1.5 text-sm font-medium text-[var(--accent)] transition-colors hover:text-[var(--accent-strong)]"
				onclick={() => mapComponent?.drillUp()}
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
				Topology
			</button>
			<svg class="h-3 w-3 text-[var(--text-soft)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
			</svg>
			<span class="text-sm font-semibold">{focusedGroupLabel}</span>
		</div>
	{/if}

	<!-- Controls -->
	<TopologyControls
		bind:autoRefresh
		bind:layoutLocked
		{graph}
		onzoomin={() => mapComponent?.zoomIn()}
		onzoomout={() => mapComponent?.zoomOut()}
		onfit={() => mapComponent?.fitToView()}
		onrefresh={refreshGraph}
	/>

	<!-- Activity Feed -->
	{#if activity.messages.length > 0}
		<TopologyActivityFeed messages={activity.messages} />
	{/if}

	<!-- Legend -->
	<TopologyLegend />

	<!-- Last updated -->
	{#if timeSinceRefresh}
		<div class="absolute bottom-3 right-3 z-10 text-[10px] text-[var(--text-soft)] opacity-60 md:bottom-4 md:right-4">
			Updated {timeSinceRefresh}
		</div>
	{/if}

	<!-- Detail panel -->
	{#if selectedNode}
		<TopologyDetailPanel
			node={selectedNode}
			edges={focusedGroupId && focusedGraph ? focusedGraph.edges : (groupedGraph ?? graph).edges}
			isPinned={isSelectedPinned}
			onclose={() => (selectedNode = null)}
			onselectnode={handleSelectNodeById}
			ontogglepin={handleTogglePin}
			oncenter={handleCenterOnSelected}
		/>
	{/if}

	<!-- Empty state -->
	{#if graph.nodes.length === 0}
		<div class="absolute inset-0 flex items-center justify-center">
			<div class="text-center">
				<svg class="mx-auto h-16 w-16 text-[var(--text-soft)] opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
				</svg>
				<p class="mt-3 text-sm font-medium text-[var(--text-soft)]">No topology data</p>
				<p class="mt-1 text-xs text-[var(--text-soft)] opacity-60">
					Configure providers and services to see the network map
				</p>
			</div>
		</div>
	{/if}
</div>
