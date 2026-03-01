<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCollide,
		forceX,
		forceY
	} from 'd3-force';
	import type { Simulation, SimulationNodeDatum, SimulationLinkDatum, ForceLink } from 'd3-force';
	import type { TopologyGraph, TopologyNode, TopologyEdge } from '$lib/ui/topology';
	import type { EdgeActivity } from '$lib/ui/activity-mapper';
	import TopologyNodeShape from './TopologyNodeShape.svelte';
	import TopologyEdgeLine from './TopologyEdgeLine.svelte';
	import TopologyTooltip from './TopologyTooltip.svelte';

	let {
		graph,
		groupedGraph,
		focusedGraph,
		selectedNode = $bindable<TopologyNode | null>(null),
		layoutLocked = $bindable(false),
		onselect,
		ondrilldown,
		ondrillup,
		edgeActivityMap
	} = $props<{
		graph: TopologyGraph;
		groupedGraph?: TopologyGraph | null;
		focusedGraph?: TopologyGraph | null;
		selectedNode?: TopologyNode | null;
		layoutLocked?: boolean;
		edgeActivityMap?: Map<string, EdgeActivity>;
		onselect?: (node: TopologyNode | null) => void;
		ondrilldown?: (groupId: string) => void;
		ondrillup?: () => void;
	}>();

	type SimNode = TopologyNode & SimulationNodeDatum;
	type SimLink = SimulationLinkDatum<SimNode> & { id: string; kind: TopologyEdge['kind']; label?: string };

	let containerEl: HTMLDivElement | undefined = $state();
	let width = $state(800);
	let height = $state(600);
	let simNodes = $state<SimNode[]>([]);
	let simLinks = $state<SimLink[]>([]);
	let hoveredNode = $state<TopologyNode | null>(null);
	let tooltipX = $state(0);
	let tooltipY = $state(0);

	// View mode
	let viewMode = $state<'global' | 'focused'>('global');
	let transitioning = $state(false);
	const TRANSITION_MS = 180;

	// The graph currently being rendered
	const activeGraph = $derived.by(() => {
		if (viewMode === 'focused' && focusedGraph) return focusedGraph;
		if (groupedGraph) return groupedGraph;
		return graph;
	});

	// Pan/zoom state
	let panX = $state(0);
	let panY = $state(0);
	let scale = $state(1);
	let isPanning = $state(false);
	let panStartX = 0;
	let panStartY = 0;
	let panOffsetX = 0;
	let panOffsetY = 0;

	// Pointer state machine for click vs drag disambiguation
	type PointerIntent = 'idle' | 'pending' | 'dragging' | 'panning';
	let pointerIntent = $state<PointerIntent>('idle');
	let pointerDownPos = { x: 0, y: 0 };
	let pointerDownNode: SimNode | null = null;
	const DRAG_THRESHOLD = 10;
	const TOUCH_DRAG_THRESHOLD = 16;

	// Node pinning
	let pinnedNodes = $state<Set<string>>(new Set());

	// Simulation
	let simulation: Simulation<SimNode, SimLink> | null = null;
	let hasAutoFit = false;
	let prevNodeIds = new Set<string>();
	let prevEdgeIds = new Set<string>();

	// Shared mutable references so tick callback always reads the latest data.
	let liveNodes: SimNode[] = [];
	let liveLinks: SimLink[] = [];

	// Hover debounce
	let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

	function clearHover() {
		if (hoverTimeout) clearTimeout(hoverTimeout);
		hoverTimeout = null;
		hoveredNode = null;
	}

	function buildNodesFrom(g: TopologyGraph): SimNode[] {
		const cx = width / 2;
		const cy = height / 2;
		const count = g.nodes.length;
		const spread = Math.max(400, Math.min(width, height) * 0.8);

		return g.nodes.map((n, i) => {
			const angle = (2 * Math.PI * i) / Math.max(count, 1);
			const r = count <= 1 ? 0 : spread / 2;
			return {
				...n,
				x: n.x ?? cx + Math.cos(angle) * r + (Math.random() - 0.5) * 40,
				y: n.y ?? cy + Math.sin(angle) * r + (Math.random() - 0.5) * 40
			};
		});
	}

	function buildLinksFrom(g: TopologyGraph, nodeMap: Map<string, SimNode>): SimLink[] {
		return g.edges
			.filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
			.map((e) => ({
				source: e.source,
				target: e.target,
				id: e.id,
				kind: e.kind,
				label: e.label
			}));
	}

	function createSimulation(nodes: SimNode[], links: SimLink[]) {
		const cx = width / 2;
		const cy = height / 2;
		const count = nodes.length;
		const isFocused = viewMode === 'focused';

		// Tighter layout in focused mode (fewer nodes, want them close to center)
		const linkDist = isFocused
			? Math.max(150, 100 + count * 10)
			: Math.max(200, 140 + count * 10);
		const chargeStrength = isFocused
			? Math.min(-250, -150 - count * 12)
			: Math.min(-350, -200 - count * 15);
		const centerStrength = isFocused ? 0.03 : 0.015;
		const collideRadius = 60;

		const sim = forceSimulation<SimNode, SimLink>(nodes)
			.force(
				'link',
				forceLink<SimNode, SimLink>(links)
					.id((d) => d.id)
					.distance(linkDist)
					.strength(0.3)
			)
			.force('charge', forceManyBody<SimNode>().strength(chargeStrength))
			.force('x', forceX<SimNode>(cx).strength(centerStrength))
			.force('y', forceY<SimNode>(cy).strength(centerStrength))
			.force('collide', forceCollide<SimNode>(collideRadius).strength(0.9))
			.alphaDecay(0.03)
			.velocityDecay(0.3)
			.on('tick', () => {
				simNodes = [...liveNodes];
				simLinks = [...liveLinks];
			})
			.on('end', () => {
				if (!hasAutoFit && liveNodes.length > 0) {
					hasAutoFit = true;
					fitToView();
				}
			});

		// In focused mode, pin the group node to center
		if (isFocused) {
			const groupNode = nodes.find((n) => n.kind === 'group');
			if (groupNode) {
				groupNode.fx = cx;
				groupNode.fy = cy;
			}
		}

		return sim;
	}

	function initSimulationFrom(g: TopologyGraph) {
		if (g.nodes.length === 0) return;

		simulation?.stop();

		liveNodes = buildNodesFrom(g);
		const nodeMap = new Map(liveNodes.map((n) => [n.id, n]));
		liveLinks = buildLinksFrom(g, nodeMap);

		simulation = createSimulation(liveNodes, liveLinks);

		simNodes = [...liveNodes];
		simLinks = [...liveLinks];
		prevNodeIds = new Set(g.nodes.map((n) => n.id));
		prevEdgeIds = new Set(g.edges.map((e) => e.id));
	}

	function updateGraphFrom(g: TopologyGraph) {
		if (g.nodes.length === 0) {
			simulation?.stop();
			simNodes = [];
			simLinks = [];
			return;
		}

		if (!simulation) {
			initSimulationFrom(g);
			return;
		}

		// Build position cache from current live nodes
		const positionCache = new Map<string, { x: number; y: number; vx: number; vy: number }>();
		for (const n of liveNodes) {
			positionCache.set(n.id, {
				x: n.x ?? width / 2,
				y: n.y ?? height / 2,
				vx: n.vx ?? 0,
				vy: n.vy ?? 0
			});
		}

		const cx = width / 2;
		const cy = height / 2;
		const isFocused = viewMode === 'focused';
		const nodes: SimNode[] = g.nodes.map((n) => {
			const cached = positionCache.get(n.id);
			const isPinned = pinnedNodes.has(n.id);
			// In focused mode, pin the group node to center
			const isGroupCenter = isFocused && n.kind === 'group';
			if (cached) {
				return {
					...n,
					x: isGroupCenter ? cx : cached.x,
					y: isGroupCenter ? cy : cached.y,
					vx: isGroupCenter ? 0 : cached.vx,
					vy: isGroupCenter ? 0 : cached.vy,
					fx: isGroupCenter ? cx : isPinned ? cached.x : null,
					fy: isGroupCenter ? cy : isPinned ? cached.y : null
				};
			}
			const nx = isGroupCenter ? cx : cx + (Math.random() - 0.5) * 200;
			const ny = isGroupCenter ? cy : cy + (Math.random() - 0.5) * 200;
			return { ...n, x: nx, y: ny, fx: isGroupCenter ? cx : isPinned ? nx : null, fy: isGroupCenter ? cy : isPinned ? ny : null };
		});

		const nodeMap = new Map(nodes.map((n) => [n.id, n]));
		const links = buildLinksFrom(g, nodeMap);

		const newNodeIds = new Set(g.nodes.map((n) => n.id));
		const newEdgeIds = new Set(g.edges.map((e) => e.id));
		const structureChanged =
			newNodeIds.size !== prevNodeIds.size ||
			newEdgeIds.size !== prevEdgeIds.size ||
			[...newNodeIds].some((id) => !prevNodeIds.has(id)) ||
			[...newEdgeIds].some((id) => !prevEdgeIds.has(id));

		prevNodeIds = newNodeIds;
		prevEdgeIds = newEdgeIds;

		liveNodes = nodes;
		liveLinks = links;

		simulation.nodes(liveNodes);
		const linkForce = simulation.force('link') as ForceLink<SimNode, SimLink> | undefined;
		if (linkForce) {
			linkForce.links(liveLinks).id((d) => d.id);
		}

		const centerStrength = isFocused ? 0.03 : 0.015;
		simulation.force('x', forceX<SimNode>(cx).strength(centerStrength));
		simulation.force('y', forceY<SimNode>(cy).strength(centerStrength));

		if (structureChanged && !layoutLocked) {
			simulation.alpha(0.3).restart();
		}

		simNodes = [...liveNodes];
		simLinks = [...liveLinks];
	}

	function handleResize() {
		if (!containerEl) return;
		width = containerEl.clientWidth;
		height = containerEl.clientHeight;
	}

	onMount(() => {
		handleResize();
		const resizeObserver = new ResizeObserver(handleResize);
		if (containerEl) resizeObserver.observe(containerEl);

		const g = activeGraph;
		if (g.nodes.length > 0) {
			initSimulationFrom(g);
		}

		const fitFallback = setTimeout(() => {
			if (!hasAutoFit && simNodes.length > 0) {
				hasAutoFit = true;
				fitToView();
			}
		}, 2000);

		return () => {
			clearTimeout(fitFallback);
			resizeObserver.disconnect();
			simulation?.stop();
		};
	});

	onDestroy(() => {
		simulation?.stop();
		if (hoverTimeout) clearTimeout(hoverTimeout);
	});

	// React to activeGraph changes (graph prop or view mode switch)
	$effect(() => {
		const g = activeGraph;
		untrack(() => {
			if (transitioning) return; // don't update during fade
			updateGraphFrom(g);
		});
	});

	// Layout lock effect
	$effect(() => {
		const locked = layoutLocked;
		untrack(() => {
			if (!simulation) return;
			if (locked) {
				for (const n of liveNodes) {
					n.fx = n.x;
					n.fy = n.y;
				}
				simulation.stop();
			} else {
				for (const n of liveNodes) {
					if (!pinnedNodes.has(n.id)) {
						n.fx = null;
						n.fy = null;
					}
				}
				simulation.alpha(0.05).restart();
			}
			simNodes = [...liveNodes];
		});
	});

	// Node lookup for edges
	function findNode(id: string | number | SimNode): SimNode | undefined {
		if (typeof id === 'object') return id;
		if (typeof id === 'number') {
			return simNodes.find((n) => n.id === String(id));
		}
		return simNodes.find((n) => n.id === id);
	}

	function handleNodeSelect(node: TopologyNode) {
		// Drillable group nodes → drill down instead of select
		if (node.drillable && node.groupId) {
			drillDown(node.groupId);
			return;
		}
		selectedNode = selectedNode?.id === node.id ? null : node;
		onselect?.(selectedNode);
	}

	function handleNodeHover(node: TopologyNode | null) {
		if (hoverTimeout) clearTimeout(hoverTimeout);
		if (node) {
			hoverTimeout = setTimeout(() => {
				hoveredNode = node;
			}, 100);
		} else {
			hoveredNode = null;
		}
	}

	// --- Drill-down transitions ---

	export function drillDown(groupId: string) {
		if (transitioning || viewMode === 'focused') return;

		// Notify parent to compute focusedGraph
		ondrilldown?.(groupId);

		// Fade out → switch → fade in
		transitioning = true;
		setTimeout(() => {
			viewMode = 'focused';
			// Reset simulation for new graph
			simulation?.stop();
			simulation = null;
			hasAutoFit = false;
			pinnedNodes = new Set();

			// Let the activeGraph $effect pick up the new focusedGraph
			// Small delay to let state propagate
			requestAnimationFrame(() => {
				const g = focusedGraph ?? activeGraph;
				initSimulationFrom(g);
				transitioning = false;
			});
		}, TRANSITION_MS);
	}

	export function drillUp() {
		if (transitioning || viewMode === 'global') return;

		transitioning = true;
		setTimeout(() => {
			viewMode = 'global';
			selectedNode = null;
			onselect?.(null);
			ondrillup?.();

			simulation?.stop();
			simulation = null;
			hasAutoFit = false;
			pinnedNodes = new Set();

			requestAnimationFrame(() => {
				const g = groupedGraph ?? graph;
				initSimulationFrom(g);
				transitioning = false;
			});
		}, TRANSITION_MS);
	}

	// --- Pointer state machine ---

	function handlePointerMove(e: PointerEvent) {
		tooltipX = e.clientX;
		tooltipY = e.clientY;

		if (pointerIntent === 'panning') {
			panX = panOffsetX + (e.clientX - panStartX);
			panY = panOffsetY + (e.clientY - panStartY);
			return;
		}

		if (pointerIntent === 'pending' && pointerDownNode && simulation) {
			const dx = e.clientX - pointerDownPos.x;
			const dy = e.clientY - pointerDownPos.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			const threshold = e.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;
			if (dist > threshold) {
				pointerIntent = 'dragging';
				clearHover();
				pointerDownNode.fx = pointerDownNode.x;
				pointerDownNode.fy = pointerDownNode.y;
				if (!layoutLocked) {
					simulation.alphaTarget(0.08).restart();
				}
			}
			return;
		}

		if (pointerIntent === 'dragging' && pointerDownNode && simulation) {
			const svgRect = containerEl?.getBoundingClientRect();
			if (svgRect) {
				pointerDownNode.fx = (e.clientX - svgRect.left - panX) / scale;
				pointerDownNode.fy = (e.clientY - svgRect.top - panY) / scale;
			}
		}
	}

	function handleSvgPointerDown(e: PointerEvent) {
		if ((e.target as Element)?.closest('.topology-node')) return;
		pointerIntent = 'panning';
		isPanning = true;
		clearHover();
		panStartX = e.clientX;
		panStartY = e.clientY;
		panOffsetX = panX;
		panOffsetY = panY;
	}

	function handleSvgPointerUp() {
		if (pointerIntent === 'pending' && pointerDownNode) {
			handleNodeSelect(pointerDownNode);
		}

		if (pointerIntent === 'dragging' && pointerDownNode) {
			if (!pinnedNodes.has(pointerDownNode.id)) {
				pointerDownNode.fx = null;
				pointerDownNode.fy = null;
			}
			simulation?.alphaTarget(0).restart();
		}

		if (pointerIntent === 'panning') {
			isPanning = false;
		}

		pointerIntent = 'idle';
		pointerDownNode = null;
	}

	function handleNodePointerDown(node: TopologyNode, e: PointerEvent) {
		e.stopPropagation();
		const simNode = simNodes.find((n) => n.id === node.id);
		if (!simNode) return;
		pointerIntent = 'pending';
		pointerDownNode = simNode;
		pointerDownPos = { x: e.clientX, y: e.clientY };
	}

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.92 : 1.08;
		const newScale = Math.max(0.1, Math.min(5, scale * delta));
		const svgRect = containerEl?.getBoundingClientRect();
		if (svgRect) {
			const mx = e.clientX - svgRect.left;
			const my = e.clientY - svgRect.top;
			panX = mx - (mx - panX) * (newScale / scale);
			panY = my - (my - panY) * (newScale / scale);
		}
		scale = newScale;
	}

	// --- Exported methods ---

	export function zoomIn() {
		scale = Math.min(5, scale * 1.25);
	}

	export function zoomOut() {
		scale = Math.max(0.1, scale * 0.8);
	}

	export function fitToView() {
		if (simNodes.length === 0) return;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of simNodes) {
			const nx = n.x ?? 0;
			const ny = n.y ?? 0;
			minX = Math.min(minX, nx);
			minY = Math.min(minY, ny);
			maxX = Math.max(maxX, nx);
			maxY = Math.max(maxY, ny);
		}
		const padding = 250;
		const graphW = maxX - minX + padding;
		const graphH = maxY - minY + padding;
		scale = Math.min(0.85, Math.min(width / graphW, height / graphH));
		const halfPad = padding / 2;
		panX = (width - graphW * scale) / 2 - minX * scale + halfPad * scale;
		panY = (height - graphH * scale) / 2 - minY * scale + halfPad * scale;
	}

	export function togglePin(nodeId: string) {
		const simNode = simNodes.find((n) => n.id === nodeId);
		if (!simNode) return;
		if (pinnedNodes.has(nodeId)) {
			pinnedNodes.delete(nodeId);
			simNode.fx = null;
			simNode.fy = null;
			pinnedNodes = new Set(pinnedNodes);
		} else {
			pinnedNodes.add(nodeId);
			simNode.fx = simNode.x;
			simNode.fy = simNode.y;
			pinnedNodes = new Set(pinnedNodes);
		}
	}

	export function isNodePinned(nodeId: string): boolean {
		return pinnedNodes.has(nodeId);
	}

	export function centerOnNode(nodeId: string) {
		const node = simNodes.find((n) => n.id === nodeId);
		if (!node || node.x == null || node.y == null) return;
		panX = width / 2 - node.x * scale;
		panY = height / 2 - node.y * scale;
	}

	export function getViewMode(): 'global' | 'focused' {
		return viewMode;
	}
</script>

<div
	bind:this={containerEl}
	class="relative h-full w-full overflow-hidden"
	style="touch-action: none;"
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svg
		class="h-full w-full select-none"
		class:cursor-grab={pointerIntent === 'idle'}
		class:cursor-grabbing={pointerIntent === 'panning' || pointerIntent === 'dragging'}
		onpointermove={handlePointerMove}
		onpointerdown={handleSvgPointerDown}
		onpointerup={handleSvgPointerUp}
		onpointerleave={handleSvgPointerUp}
		onwheel={handleWheel}
	>
		<g
			transform="translate({panX}, {panY}) scale({scale})"
			style="opacity: {transitioning ? 0 : 1}; transition: opacity {TRANSITION_MS}ms ease;"
		>
			<!-- Edges -->
			{#each simLinks as link (link.id)}
				{@const src = findNode(link.source)}
				{@const tgt = findNode(link.target)}
				{#if src && tgt}
					<TopologyEdgeLine
						edge={{ id: link.id, source: src.id, target: tgt.id, kind: link.kind, label: link.label }}
						sourceNode={src}
						targetNode={tgt}
						activity={edgeActivityMap?.get(link.id)}
					/>
				{/if}
			{/each}

			<!-- Nodes -->
			{#each simNodes as node (node.id)}
				<TopologyNodeShape
					{node}
					selected={selectedNode?.id === node.id}
					pinned={pinnedNodes.has(node.id)}
					onpointerdown={(e) => handleNodePointerDown(node, e)}
					onhover={handleNodeHover}
				/>
			{/each}
		</g>
	</svg>

	<!-- Tooltip -->
	{#if hoveredNode && pointerIntent === 'idle' && !transitioning}
		<TopologyTooltip
			node={hoveredNode}
			edges={activeGraph.edges}
			x={tooltipX - (containerEl?.getBoundingClientRect().left ?? 0)}
			y={tooltipY - (containerEl?.getBoundingClientRect().top ?? 0)}
			containerWidth={width}
			containerHeight={height}
		/>
	{/if}
</div>
