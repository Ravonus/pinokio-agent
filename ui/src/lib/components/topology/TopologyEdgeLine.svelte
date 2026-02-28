<script lang="ts">
	import type { TopologyEdge, TopologyNode } from '$lib/ui/topology';
	import type { EdgeActivity } from '$lib/ui/activity-mapper';

	const EDGE_COLORS: Record<string, string> = {
		socket: '#a855f7',
		tcp: '#3b82f6',
		http: '#22c55e',
		command: '#f59e0b',
		network: '#94a3b8',
		fallback: '#f97316',
		credential: '#6366f1'
	};

	let {
		edge,
		sourceNode,
		targetNode,
		activity
	} = $props<{
		edge: TopologyEdge;
		sourceNode: TopologyNode;
		targetNode: TopologyNode;
		activity?: EdgeActivity;
	}>();

	const x1 = $derived(sourceNode.x ?? 0);
	const y1 = $derived(sourceNode.y ?? 0);
	const x2 = $derived(targetNode.x ?? 0);
	const y2 = $derived(targetNode.y ?? 0);

	const pathD = $derived(`M${x1},${y1} L${x2},${y2}`);
	const dotColor = $derived(EDGE_COLORS[edge.kind] ?? '#94a3b8');

	const dotCount = $derived.by(() => {
		if (!activity) return 0;
		if (activity.intensity === 'high') return 3;
		if (activity.intensity === 'medium') return 2;
		return 1;
	});

	const animDuration = $derived.by(() => {
		if (!activity) return '2s';
		if (activity.intensity === 'high') return '0.7s';
		if (activity.intensity === 'medium') return '1.2s';
		return '2s';
	});
</script>

<!-- Edge line -->
<line
	class="topology-edge topology-edge-{edge.kind}"
	{x1} {y1} {x2} {y2}
/>

<!-- Active glow overlay -->
{#if activity}
	<line
		{x1} {y1} {x2} {y2}
		stroke={dotColor}
		stroke-width="4"
		stroke-linecap="round"
		opacity="0.2"
		class="topology-edge-glow"
	/>
{/if}

<!-- Flowing dots -->
{#if activity && dotCount > 0}
	<path d={pathD} fill="none" stroke="none" id="path-{edge.id}" />
	{#each Array(dotCount) as _, i}
		<circle r="3" fill={dotColor} opacity="0.9">
			<animateMotion
				dur={animDuration}
				repeatCount="indefinite"
				begin="{i * (parseFloat(animDuration) / dotCount)}s"
				path={pathD}
			/>
		</circle>
	{/each}
{/if}

{#if edge.label}
	<text
		x={(x1 + x2) / 2}
		y={(y1 + y2) / 2 - 6}
		text-anchor="middle"
		fill="var(--text-soft)"
		font-size="8"
		font-family="var(--font-mono)"
		opacity="0.7"
	>
		{edge.label}
	</text>
{/if}
