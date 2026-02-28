<script lang="ts">
	import type { TopologyNode } from '$lib/ui/topology';

	let {
		node,
		selected = false,
		pinned = false,
		onpointerdown,
		onhover
	} = $props<{
		node: TopologyNode;
		selected?: boolean;
		pinned?: boolean;
		onpointerdown?: (e: PointerEvent) => void;
		onhover?: (node: TopologyNode | null) => void;
	}>();

	const statusColor = $derived(
		node.status === 'healthy'
			? 'var(--accent)'
			: node.status === 'degraded'
				? 'var(--warn)'
				: node.status === 'down'
					? 'var(--danger)'
					: 'var(--text-soft)'
	);

	const fillColor = $derived(
		node.status === 'healthy'
			? 'var(--accent-soft)'
			: node.status === 'degraded'
				? 'color-mix(in srgb, var(--warn) 15%, var(--bg-1))'
				: node.status === 'down'
					? 'color-mix(in srgb, var(--danger) 15%, var(--bg-1))'
					: 'var(--bg-2)'
	);

	const selectedStroke = $derived(selected ? 'var(--accent-strong)' : statusColor);
	const selectedWidth = $derived(selected ? 3 : node.kind === 'manager' ? 2.5 : 2);

	// Status icon: small indicator dot
	const statusIconColor = $derived(
		node.status === 'healthy' ? '#22c55e'
		: node.status === 'degraded' ? '#f59e0b'
		: node.status === 'down' ? '#ef4444'
		: '#9ca3af'
	);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<g
	class="topology-node"
	class:topology-node-selected={selected}
	class:topology-node-pinned={pinned}
	class:node-pulse-healthy={node.status === 'healthy'}
	class:node-pulse-degraded={node.status === 'degraded'}
	transform="translate({node.x ?? 0}, {node.y ?? 0})"
	onpointerdown={onpointerdown}
	onmouseenter={() => onhover?.(node)}
	onmouseleave={() => onhover?.(null)}
>
	{#if node.kind === 'group'}
		<!-- Larger rounded rectangle for plugin groups -->
		<rect
			x="-46"
			y="-34"
			width="92"
			height="68"
			rx="14"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth + 0.5}
		/>
		<!-- Group icon -->
		{#if node.iconPath}
			<g transform="translate(-10, -18) scale(0.83)">
				<path
					d={node.iconPath}
					fill="none"
					stroke="var(--accent)"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</g>
		{/if}
		<!-- Label -->
		<text
			y="22"
			text-anchor="middle"
			fill="var(--text)"
			font-size="10"
			font-weight="600"
			font-family="var(--font-sans)"
		>
			{node.label.length > 12 ? node.label.slice(0, 10) + '...' : node.label}
		</text>
		<!-- Child count badge -->
		{#if node.detail?.agents}
			<g transform="translate(34, -26)">
				<rect x="-9" y="-8" width="18" height="16" rx="8" fill="var(--accent)" />
				<text y="4" text-anchor="middle" fill="white" font-size="9" font-weight="700"
					font-family="var(--font-sans)">{node.detail.agents}</text>
			</g>
		{/if}
		<!-- Drillable expand indicator -->
		{#if node.drillable}
			<g transform="translate(36, 22)">
				<circle r="8" fill="var(--bg-1)" stroke="var(--accent)" stroke-width="1.5" />
				<path d="M-3,0 L3,0 M0,-3 L0,3" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" />
			</g>
		{/if}
	{:else if node.kind === 'manager'}
		<!-- Large circle for manager -->
		<circle
			r="32"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="10"
			font-weight="600"
			font-family="var(--font-sans)"
		>
			{node.label.length > 12 ? node.label.slice(0, 10) + '...' : node.label}
		</text>
	{:else if node.kind === 'host'}
		<!-- Large rounded square for host -->
		<rect
			x="-36"
			y="-26"
			width="72"
			height="52"
			rx="6"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="-4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="10"
			font-weight="600"
			font-family="var(--font-sans)"
		>
			{node.label.length > 10 ? node.label.slice(0, 8) + '...' : node.label}
		</text>
		<text
			y="12"
			text-anchor="middle"
			fill="var(--text-soft)"
			font-size="8"
			font-family="var(--font-mono)"
		>
			host
		</text>
	{:else if node.kind === 'service'}
		<!-- Rounded rectangle for services -->
		<rect
			x="-40"
			y="-22"
			width="80"
			height="44"
			rx="8"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="10"
			font-weight="500"
			font-family="var(--font-sans)"
		>
			{node.label.length > 10 ? node.label.slice(0, 8) + '...' : node.label}
		</text>
	{:else if node.kind === 'container'}
		<!-- Dashed rectangle for containers -->
		<rect
			x="-38"
			y="-20"
			width="76"
			height="40"
			rx="4"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width="1.5"
			stroke-dasharray="5 3"
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="9"
			font-weight="500"
			font-family="var(--font-sans)"
		>
			{node.label.length > 10 ? node.label.slice(0, 8) + '...' : node.label}
		</text>
	{:else if node.kind === 'llm_provider'}
		<!-- Hexagon for LLM providers -->
		<polygon
			points="0,-28 24,-14 24,14 0,28 -24,14 -24,-14"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="9"
			font-weight="500"
			font-family="var(--font-sans)"
		>
			{node.label.length > 10 ? node.label.slice(0, 8) + '...' : node.label}
		</text>
	{:else if node.kind === 'agent'}
		<!-- Pentagon for agents -->
		<polygon
			points="0,-26 25,-8 15,22 -15,22 -25,-8"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="6"
			text-anchor="middle"
			fill="var(--text)"
			font-size="9"
			font-weight="500"
			font-family="var(--font-sans)"
		>
			{node.label.length > 10 ? node.label.slice(0, 8) + '...' : node.label}
		</text>
	{:else if node.kind === 'network'}
		<!-- Cloud-like rounded shape for networks -->
		<rect
			x="-34"
			y="-16"
			width="68"
			height="32"
			rx="16"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width="1.5"
			stroke-dasharray="4 2"
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text-soft)"
			font-size="9"
			font-weight="400"
			font-family="var(--font-sans)"
		>
			{node.label.length > 10 ? node.label.slice(0, 8) + '...' : node.label}
		</text>
	{:else if node.kind === 'connection'}
		<!-- Rotated square (diamond) for connections/systems -->
		<polygon
			points="0,-22 22,0 0,22 -22,0"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="8"
			font-weight="500"
			font-family="var(--font-sans)"
		>
			{node.label.length > 8 ? node.label.slice(0, 6) + '...' : node.label}
		</text>
	{:else}
		<!-- Diamond for plugins -->
		<polygon
			points="0,-24 24,0 0,24 -24,0"
			fill={fillColor}
			stroke={selectedStroke}
			stroke-width={selectedWidth}
		/>
		<text
			y="4"
			text-anchor="middle"
			fill="var(--text)"
			font-size="9"
			font-weight="500"
			font-family="var(--font-sans)"
		>
			{node.label.length > 8 ? node.label.slice(0, 6) + '...' : node.label}
		</text>
	{/if}

	<!-- Status indicator dot -->
	{#if node.kind === 'manager'}
		<circle cx="24" cy="-24" r="5" fill={statusIconColor} stroke="var(--bg-1)" stroke-width="1.5" />
	{:else if node.kind === 'host'}
		<circle cx="28" cy="-20" r="5" fill={statusIconColor} stroke="var(--bg-1)" stroke-width="1.5" />
	{:else if node.kind === 'service' || node.kind === 'container'}
		<circle cx="32" cy="-16" r="4.5" fill={statusIconColor} stroke="var(--bg-1)" stroke-width="1.5" />
	{:else if node.kind !== 'network'}
		<circle cx="18" cy="-18" r="4" fill={statusIconColor} stroke="var(--bg-1)" stroke-width="1.5" />
	{/if}

	<!-- Pin indicator -->
	{#if pinned}
		<circle cx="0" cy="-36" r="3" fill="var(--accent)" stroke="var(--bg-1)" stroke-width="1" />
	{/if}
</g>
