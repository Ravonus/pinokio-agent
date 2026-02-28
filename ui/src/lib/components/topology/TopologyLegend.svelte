<script lang="ts">
	const edgeTypes = [
		{ kind: 'socket', label: 'Socket', color: '#a855f7' },
		{ kind: 'tcp', label: 'TCP', color: '#3b82f6' },
		{ kind: 'http', label: 'HTTP', color: '#22c55e' },
		{ kind: 'command', label: 'Command', color: '#f59e0b' },
		{ kind: 'network', label: 'Network', color: 'var(--line-strong)' },
		{ kind: 'fallback', label: 'Failover', color: '#f97316' },
		{ kind: 'credential', label: 'Credential', color: '#6366f1' }
	];

	const nodeTypes = [
		{ kind: 'group', label: 'Plugin Group', shape: 'bigroundedrect' },
		{ kind: 'host', label: 'Host', shape: 'roundedsquare' },
		{ kind: 'manager', label: 'Manager', shape: 'circle' },
		{ kind: 'service', label: 'Service', shape: 'rect' },
		{ kind: 'container', label: 'Container', shape: 'dashedrect' },
		{ kind: 'llm_provider', label: 'LLM Provider', shape: 'hexagon' },
		{ kind: 'agent', label: 'Agent', shape: 'pentagon' },
		{ kind: 'plugin', label: 'Plugin', shape: 'diamond' },
		{ kind: 'connection', label: 'System', shape: 'smalldiamond' },
		{ kind: 'network', label: 'Network', shape: 'pill' }
	];
</script>

<div class="absolute bottom-3 left-3 z-20 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-[10px] shadow-sm md:bottom-4 md:left-4">
	<p class="mb-1.5 font-semibold uppercase tracking-wide text-[var(--text-soft)]">Legend</p>

	<div class="flex flex-wrap gap-x-3 gap-y-1">
		{#each nodeTypes as nodeType}
			<div class="flex items-center gap-1.5">
				{#if nodeType.shape === 'bigroundedrect'}
				<svg class="h-3 w-4" viewBox="0 0 16 12"><rect x="1" y="1" width="14" height="10" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5" /></svg>
			{:else if nodeType.shape === 'circle'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5" /></svg>
				{:else if nodeType.shape === 'rect'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="1" y="2" width="10" height="8" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1" /></svg>
				{:else if nodeType.shape === 'roundedsquare'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="1" y="1.5" width="10" height="9" rx="1.5" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1" /></svg>
				{:else if nodeType.shape === 'dashedrect'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="1" y="2" width="10" height="8" rx="1" fill="var(--bg-2)" stroke="var(--accent)" stroke-width="1" stroke-dasharray="2 1" /></svg>
				{:else if nodeType.shape === 'hexagon'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><polygon points="6,1 11,3.5 11,8.5 6,11 1,8.5 1,3.5" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1" /></svg>
				{:else if nodeType.shape === 'pentagon'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><polygon points="6,1 11,4.5 9.5,10 2.5,10 1,4.5" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1" /></svg>
				{:else if nodeType.shape === 'diamond'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><polygon points="6,1 11,6 6,11 1,6" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1" /></svg>
				{:else if nodeType.shape === 'smalldiamond'}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><polygon points="6,2 10,6 6,10 2,6" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1" /></svg>
				{:else}
					<svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="1" y="3" width="10" height="6" rx="3" fill="var(--bg-2)" stroke="var(--line-strong)" stroke-width="1" stroke-dasharray="2 1" /></svg>
				{/if}
				<span>{nodeType.label}</span>
			</div>
		{/each}
	</div>

	<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
		{#each edgeTypes as edgeType}
			<div class="flex items-center gap-1.5">
				<svg class="h-2 w-4" viewBox="0 0 16 8">
					<line
						x1="0" y1="4" x2="16" y2="4"
						stroke={edgeType.color}
						stroke-width="2"
						stroke-dasharray={edgeType.kind === 'http' ? '4 2' : edgeType.kind === 'command' ? '2 3' : edgeType.kind === 'network' ? '' : edgeType.kind === 'fallback' ? '6 3' : ''}
						opacity={edgeType.kind === 'network' ? 0.5 : 1}
					/>
				</svg>
				<span>{edgeType.label}</span>
			</div>
		{/each}
		<div class="flex items-center gap-1.5">
			<svg class="h-2 w-4" viewBox="0 0 16 8">
				<line x1="0" y1="4" x2="16" y2="4" stroke="#22c55e" stroke-width="2" opacity="0.3" />
				<circle cx="4" cy="4" r="2" fill="#22c55e" opacity="0.9">
					<animate attributeName="cx" from="0" to="16" dur="1s" repeatCount="indefinite" />
				</circle>
			</svg>
			<span>Live</span>
		</div>
	</div>
</div>
