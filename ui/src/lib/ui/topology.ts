import type { CredentialStatus, ManagedServiceStatus, ConfigureDoctorReport, UiExtensionSurface } from './manager';
import type { PluginGroup } from './plugin-groups';

export type NodeKind = 'manager' | 'host' | 'service' | 'container' | 'llm_provider' | 'agent' | 'plugin' | 'connection' | 'network' | 'group';
export type EdgeKind = 'socket' | 'tcp' | 'http' | 'command' | 'network' | 'fallback' | 'credential';

export interface TopologyNode {
	id: string;
	kind: NodeKind;
	label: string;
	status: 'healthy' | 'degraded' | 'down' | 'unknown';
	detail: Record<string, string>;
	drillable?: boolean;
	groupId?: string;
	childNodeIds?: string[];
	iconPath?: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
}

export interface TopologyEdge {
	id: string;
	source: string;
	target: string;
	kind: EdgeKind;
	label?: string;
}

export interface TopologyGraph {
	nodes: TopologyNode[];
	edges: TopologyEdge[];
	refreshedAt: string;
}

function serviceStatus(svc: ManagedServiceStatus): TopologyNode['status'] {
	if (!svc.exists) return 'down';
	if (!svc.running) return 'down';
	if (svc.health === 'healthy') return 'healthy';
	if (svc.health === 'unhealthy') return 'degraded';
	if (svc.running) return 'healthy';
	return 'unknown';
}

function credentialStatus(cred: CredentialStatus): TopologyNode['status'] {
	if (cred.token_present) return 'healthy';
	if (cred.mode === 'oauth_cli') return 'healthy';
	if (cred.configured) return 'degraded';
	return 'down';
}

function providerLabel(provider: string): string {
	switch (provider) {
		case 'openai': return 'OpenAI';
		case 'anthropic': return 'Claude API';
		case 'claude_code': return 'Claude Code';
		case 'codex': return 'Codex';
		default: return provider;
	}
}

function surfaceStatus(surface: UiExtensionSurface): TopologyNode['status'] {
	if (surface.enabled === false) return 'down';
	return 'healthy';
}

export function buildTopologyGraph(
	services: ManagedServiceStatus[],
	credentials: CredentialStatus[],
	doctor: ConfigureDoctorReport | null,
	surfaces: UiExtensionSurface[] = []
): TopologyGraph {
	const nodes: TopologyNode[] = [];
	const edges: TopologyEdge[] = [];
	const networkSet = new Set<string>();

	// Deduplicate surfaces by name — prefer "configured" over "derived"
	const surfaceMap = new Map<string, UiExtensionSurface>();
	for (const s of surfaces) {
		const existing = surfaceMap.get(s.name);
		if (!existing || s.source === 'configured') {
			surfaceMap.set(s.name, s);
		}
	}
	const dedupedSurfaces = [...surfaceMap.values()];

	// Host node — always present
	nodes.push({
		id: 'host',
		kind: 'host',
		label: 'Host',
		status: 'healthy',
		detail: {
			type: 'Host Machine',
			services: String(services.length),
			providers: String(new Set(credentials.map(c => c.provider)).size)
		}
	});

	// Manager node — always present
	const managerStatus: TopologyNode['status'] =
		doctor?.ok === false ? 'degraded' : 'healthy';
	nodes.push({
		id: 'manager',
		kind: 'manager',
		label: 'Pinokio Manager',
		status: managerStatus,
		detail: {
			type: 'Agent Manager',
			profiles: doctor ? `${doctor.credentials.length} credentials` : 'unknown',
			errors: doctor ? String(doctor.profile_errors.length) : '0'
		}
	});

	// Edge: host → manager
	edges.push({
		id: 'edge:host-mgr',
		source: 'host',
		target: 'manager',
		kind: 'command',
		label: 'manages'
	});

	// Service nodes
	for (const svc of services) {
		const nodeId = `svc:${svc.name}`;
		nodes.push({
			id: nodeId,
			kind: 'service',
			label: svc.name,
			status: serviceStatus(svc),
			detail: {
				image: svc.image,
				container: svc.container_name,
				ports: svc.host_ports.join(', ') || 'none',
				health: svc.health ?? 'n/a',
				networks: svc.networks.join(', ') || 'none'
			}
		});

		// Edge: manager ↔ service
		const edgeKind: EdgeKind = svc.host_ports.length > 0 ? 'tcp' : 'network';
		edges.push({
			id: `edge:mgr-${svc.name}`,
			source: 'manager',
			target: nodeId,
			kind: edgeKind,
			label: svc.host_ports[0] ?? undefined
		});

		// Container node for each service that exists
		if (svc.exists) {
			const containerId = `ctr:${svc.name}`;
			nodes.push({
				id: containerId,
				kind: 'container',
				label: svc.container_name || svc.name,
				status: serviceStatus(svc),
				detail: {
					image: svc.image,
					container: svc.container_name,
					ports: svc.host_ports.join(', ') || 'none',
					running: svc.running ? 'yes' : 'no'
				}
			});

			// Edge: service → container
			edges.push({
				id: `edge:svc-ctr-${svc.name}`,
				source: nodeId,
				target: containerId,
				kind: 'network',
				label: 'runs'
			});
		}

		// Collect networks for shared-network edges
		for (const net of svc.networks) {
			networkSet.add(net);
		}
	}

	// Network nodes (shared Docker networks)
	for (const net of networkSet) {
		const netId = `net:${net}`;
		nodes.push({
			id: netId,
			kind: 'network',
			label: net,
			status: 'healthy',
			detail: { type: 'Docker Network' }
		});

		// Connect services to their networks
		for (const svc of services) {
			if (svc.networks.includes(net)) {
				edges.push({
					id: `edge:net-${net}-${svc.name}`,
					source: `svc:${svc.name}`,
					target: netId,
					kind: 'network'
				});
			}
		}
	}

	// LLM provider nodes
	const seenProviders = new Set<string>();
	for (const cred of credentials) {
		if (seenProviders.has(cred.provider)) continue;
		seenProviders.add(cred.provider);

		const nodeId = `llm:${cred.provider}`;
		nodes.push({
			id: nodeId,
			kind: 'llm_provider',
			label: providerLabel(cred.provider),
			status: credentialStatus(cred),
			detail: {
				provider: cred.provider,
				mode: cred.mode,
				credential: cred.name,
				source: cred.source ?? 'none'
			}
		});

		const edgeKind: EdgeKind = cred.mode === 'oauth_cli' ? 'command' : 'http';
		edges.push({
			id: `edge:mgr-llm-${cred.provider}`,
			source: 'manager',
			target: nodeId,
			kind: edgeKind,
			label: cred.mode
		});
	}

	// Fallback chain edges
	const readyCreds = credentials.filter(
		(c) => c.token_present || c.mode === 'oauth_cli'
	);
	for (let i = 0; i < readyCreds.length - 1; i++) {
		const from = readyCreds[i];
		const to = readyCreds[i + 1];
		if (from.provider !== to.provider) {
			edges.push({
				id: `edge:fallback-${from.provider}-${to.provider}`,
				source: `llm:${from.provider}`,
				target: `llm:${to.provider}`,
				kind: 'fallback',
				label: 'failover'
			});
		}
	}

	// Extension surface nodes: plugins, connections
	// Skip 'core' (UI config) and 'agents' (LLM profiles — already represented by credential-based LLM provider nodes)
	for (const surface of dedupedSurfaces) {
		if (surface.kind === 'core' || surface.kind === 'agents') continue;

		if (surface.kind === 'plugins') {
			const nodeId = `plugin:${surface.name}`;
			nodes.push({
				id: nodeId,
				kind: 'plugin',
				label: surface.title || surface.name,
				status: surfaceStatus(surface),
				detail: {
					name: surface.name,
					slot: surface.slot ?? 'n/a',
					source: surface.source ?? 'built-in',
					enabled: surface.enabled !== false ? 'yes' : 'no',
					...(surface.route ? { route: surface.route } : {}),
					...(surface.detail ? { info: surface.detail } : {})
				}
			});

			// Edge: manager → plugin
			edges.push({
				id: `edge:mgr-plugin-${surface.name}`,
				source: 'manager',
				target: nodeId,
				kind: 'command',
				label: 'plugin'
			});
		} else if (surface.kind === 'systems') {
			const nodeId = `conn:${surface.name}`;
			nodes.push({
				id: nodeId,
				kind: 'connection',
				label: surface.title || surface.name,
				status: surfaceStatus(surface),
				detail: {
					name: surface.name,
					source: surface.source ?? 'built-in',
					...(surface.detail ? { info: surface.detail } : {})
				}
			});

			// Edge: manager → connection
			const connEdgeKind: EdgeKind = surface.name.includes('socket') ? 'socket' : 'http';
			edges.push({
				id: `edge:mgr-conn-${surface.name}`,
				source: 'manager',
				target: nodeId,
				kind: connEdgeKind,
				label: 'system'
			});
		}
	}

	return {
		nodes,
		edges,
		refreshedAt: new Date().toISOString()
	};
}

// --- Grouped / Drill-Down Graph Builders ---

function aggregateStatus(statuses: TopologyNode['status'][]): TopologyNode['status'] {
	if (statuses.length === 0) return 'unknown';
	if (statuses.every((s) => s === 'healthy')) return 'healthy';
	if (statuses.every((s) => s === 'down')) return 'down';
	if (statuses.some((s) => s === 'down' || s === 'degraded')) return 'degraded';
	return 'unknown';
}

/**
 * Build a grouped global graph by collapsing plugin groups into single nodes.
 * Hides containers and networks from global view (detail for drill-down only).
 * Collapses all LLM providers into a single "AI Providers" group node.
 */
export function buildGroupedGraph(
	flatGraph: TopologyGraph,
	groups: PluginGroup[]
): TopologyGraph {
	const nodeMap = new Map(flatGraph.nodes.map((n) => [n.id, n]));

	// Map from individual node ID → group ID
	const nodeToGroup = new Map<string, string>();
	// Map from group ID → set of child node IDs
	const groupChildren = new Map<string, Set<string>>();

	for (const group of groups) {
		const childIds = new Set<string>();
		for (const surface of group.surfaces) {
			for (const prefix of ['agent:', 'plugin:', 'conn:']) {
				const nodeId = `${prefix}${surface.name}`;
				if (nodeMap.has(nodeId)) {
					nodeToGroup.set(nodeId, group.def.id);
					childIds.add(nodeId);
				}
			}
		}
		// Also absorb associated service + container nodes
		if (group.def.serviceNames) {
			for (const svcName of group.def.serviceNames) {
				for (const prefix of ['svc:', 'ctr:']) {
					const nodeId = `${prefix}${svcName}`;
					if (nodeMap.has(nodeId)) {
						nodeToGroup.set(nodeId, group.def.id);
						childIds.add(nodeId);
					}
				}
			}
		}
		if (childIds.size > 0) {
			groupChildren.set(group.def.id, childIds);
		}
	}

	// Collapse LLM providers into a single "AI Providers" group
	const llmNodeIds = new Set<string>();
	for (const node of flatGraph.nodes) {
		if (node.kind === 'llm_provider') {
			nodeToGroup.set(node.id, 'ai_providers');
			llmNodeIds.add(node.id);
		}
	}
	if (llmNodeIds.size > 0) {
		groupChildren.set('ai_providers', llmNodeIds);
	}

	// Hide container and network nodes from global view entirely
	const hiddenKinds = new Set<NodeKind>(['container', 'network']);

	// Build group nodes
	const groupNodes: TopologyNode[] = [];

	// Plugin groups
	for (const group of groups) {
		const childIds = groupChildren.get(group.def.id);
		if (!childIds || childIds.size === 0) continue;

		const childStatuses = [...childIds]
			.map((id) => nodeMap.get(id))
			.filter(Boolean)
			.map((n) => n!.status);

		const enabledCount = group.surfaces.filter((s) => s.enabled !== false).length;

		groupNodes.push({
			id: `group:${group.def.id}`,
			kind: 'group',
			label: group.def.label,
			status: aggregateStatus(childStatuses),
			drillable: childIds.size >= 2,
			groupId: group.def.id,
			childNodeIds: [...childIds],
			iconPath: group.def.icon,
			detail: {
				agents: String(group.surfaces.length),
				services: String(group.services.length),
				enabled: `${enabledCount} of ${group.surfaces.length}`
			}
		});
	}

	// AI Providers group node
	if (llmNodeIds.size > 0) {
		const llmStatuses = [...llmNodeIds]
			.map((id) => nodeMap.get(id))
			.filter(Boolean)
			.map((n) => n!.status);

		groupNodes.push({
			id: 'group:ai_providers',
			kind: 'group',
			label: 'AI Providers',
			status: aggregateStatus(llmStatuses),
			drillable: llmNodeIds.size >= 2,
			groupId: 'ai_providers',
			childNodeIds: [...llmNodeIds],
			iconPath: 'M13 10V3L4 14h7v7l9-11h-7z',
			detail: {
				providers: String(llmNodeIds.size),
				type: 'LLM Providers'
			}
		});
	}

	// Nodes: keep non-grouped, non-hidden nodes + add group nodes
	const nodes: TopologyNode[] = [
		...flatGraph.nodes.filter((n) => !nodeToGroup.has(n.id) && !hiddenKinds.has(n.kind)),
		...groupNodes
	];

	// Edges: rewrite edges, skip hidden endpoints
	const validNodeIds = new Set(nodes.map((n) => n.id));
	const edgeDedup = new Set<string>();
	const edges: TopologyEdge[] = [];

	for (const edge of flatGraph.edges) {
		const srcGroup = nodeToGroup.get(edge.source);
		const tgtGroup = nodeToGroup.get(edge.target);

		// Both endpoints inside the same group — skip (internal edge)
		if (srcGroup && tgtGroup && srcGroup === tgtGroup) continue;

		// Rewrite endpoints to group node
		const newSource = srcGroup ? `group:${srcGroup}` : edge.source;
		const newTarget = tgtGroup ? `group:${tgtGroup}` : edge.target;

		// Skip self-loops
		if (newSource === newTarget) continue;

		// Skip edges to hidden/removed nodes
		if (!validNodeIds.has(newSource) || !validNodeIds.has(newTarget)) continue;

		// Dedup by source+target+kind
		const key = `${newSource}|${newTarget}|${edge.kind}`;
		if (edgeDedup.has(key)) continue;
		edgeDedup.add(key);

		edges.push({
			id: `grouped:${newSource}-${newTarget}-${edge.kind}`,
			source: newSource,
			target: newTarget,
			kind: edge.kind,
			label: edge.label
		});
	}

	return { nodes, edges, refreshedAt: flatGraph.refreshedAt };
}

/**
 * Build a focused graph for drilling into a specific plugin group.
 * Shows the group node at center + its children + edges between them.
 */
export function buildFocusedGraph(
	flatGraph: TopologyGraph,
	groups: PluginGroup[],
	groupId: string
): TopologyGraph | null {
	// Special case: synthetic AI Providers group
	if (groupId === 'ai_providers') {
		return buildFocusedAiProvidersGraph(flatGraph);
	}

	const group = groups.find((g) => g.def.id === groupId);
	if (!group) return null;

	const flatNodeMap = new Map(flatGraph.nodes.map((n) => [n.id, n]));

	// Collect child node IDs
	const childIds = new Set<string>();
	for (const surface of group.surfaces) {
		for (const prefix of ['agent:', 'plugin:', 'conn:']) {
			const nodeId = `${prefix}${surface.name}`;
			if (flatNodeMap.has(nodeId)) childIds.add(nodeId);
		}
	}
	if (group.def.serviceNames) {
		for (const svcName of group.def.serviceNames) {
			for (const prefix of ['svc:', 'ctr:']) {
				const nodeId = `${prefix}${svcName}`;
				if (flatNodeMap.has(nodeId)) childIds.add(nodeId);
			}
		}
	}

	// Also include network nodes connected to group services
	for (const edge of flatGraph.edges) {
		if (childIds.has(edge.source) && edge.target.startsWith('net:')) {
			childIds.add(edge.target);
		}
		if (childIds.has(edge.target) && edge.source.startsWith('net:')) {
			childIds.add(edge.source);
		}
	}

	const enabledCount = group.surfaces.filter((s) => s.enabled !== false).length;

	// Group node (not drillable in focused view)
	const groupNode: TopologyNode = {
		id: `group:${group.def.id}`,
		kind: 'group',
		label: group.def.label,
		status: aggregateStatus(
			[...childIds].map((id) => flatNodeMap.get(id)?.status ?? 'unknown')
		),
		drillable: false,
		groupId: group.def.id,
		iconPath: group.def.icon,
		detail: {
			description: group.def.description,
			agents: String(group.surfaces.length),
			services: String(group.services.length),
			enabled: `${enabledCount} of ${group.surfaces.length}`
		}
	};

	// Child nodes from the flat graph
	const childNodes = [...childIds]
		.map((id) => flatNodeMap.get(id))
		.filter(Boolean) as TopologyNode[];

	const nodes = [groupNode, ...childNodes];

	// Edges: internal edges between children, plus edges from group to each child
	const edges: TopologyEdge[] = [];

	// Internal edges (both endpoints in child set)
	for (const edge of flatGraph.edges) {
		if (childIds.has(edge.source) && childIds.has(edge.target)) {
			edges.push(edge);
		}
	}

	// Synthetic membership edges from group node to each agent/plugin child
	for (const childId of childIds) {
		const child = flatNodeMap.get(childId);
		if (!child) continue;
		// Only add membership edges to agents/plugins, not services/containers/networks
		if (['agent', 'plugin', 'connection'].includes(child.kind)) {
			edges.push({
				id: `edge:group-child-${childId}`,
				source: groupNode.id,
				target: childId,
				kind: 'command',
				label: 'member'
			});
		}
	}

	return { nodes, edges, refreshedAt: flatGraph.refreshedAt };
}

/**
 * Build focused graph for the synthetic AI Providers group.
 */
function buildFocusedAiProvidersGraph(flatGraph: TopologyGraph): TopologyGraph {
	const llmNodes = flatGraph.nodes.filter((n) => n.kind === 'llm_provider');
	const llmNodeIds = new Set(llmNodes.map((n) => n.id));

	const groupNode: TopologyNode = {
		id: 'group:ai_providers',
		kind: 'group',
		label: 'AI Providers',
		status: aggregateStatus(llmNodes.map((n) => n.status)),
		drillable: false,
		groupId: 'ai_providers',
		iconPath: 'M13 10V3L4 14h7v7l9-11h-7z',
		detail: {
			providers: String(llmNodes.length),
			type: 'LLM Providers'
		}
	};

	const nodes = [groupNode, ...llmNodes];
	const edges: TopologyEdge[] = [];

	// Edges between LLM providers (fallback chains)
	for (const edge of flatGraph.edges) {
		if (llmNodeIds.has(edge.source) && llmNodeIds.has(edge.target)) {
			edges.push(edge);
		}
	}

	// Membership edges from group to each provider
	for (const llmNode of llmNodes) {
		edges.push({
			id: `edge:group-child-${llmNode.id}`,
			source: groupNode.id,
			target: llmNode.id,
			kind: 'credential',
			label: 'provider'
		});
	}

	return { nodes, edges, refreshedAt: flatGraph.refreshedAt };
}
