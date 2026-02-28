import type { SocketBusActivity, SocketBusMessage } from './socket-bus';
import type { TopologyGraph, TopologyNode, TopologyEdge } from './topology';

export interface EdgeActivity {
	messageCount: number;
	lastSeq: number;
	intensity: 'low' | 'medium' | 'high';
}

/**
 * Resolve a sender_resource string to a topology node ID.
 * Examples:
 *   "system:plugins" → "manager"
 *   "plugin:chat_agent" → "plugin:chat_agent"
 *   "plugin:explorer" → "plugin:explorer"
 */
function resolveNodeId(senderResource: string, nodeIds: Set<string>): string | null {
	if (senderResource.startsWith('system:')) return 'manager';

	// Direct match (plugin:X or conn:X)
	if (nodeIds.has(senderResource)) return senderResource;

	// Try plugin: prefix
	const asPlugin = senderResource.startsWith('plugin:') ? senderResource : `plugin:${senderResource}`;
	if (nodeIds.has(asPlugin)) return asPlugin;

	// Try conn: prefix
	const asConn = senderResource.startsWith('conn:') ? senderResource : `conn:${senderResource}`;
	if (nodeIds.has(asConn)) return asConn;

	return null;
}

/**
 * Extract a target node ID from a channel name.
 * Channel patterns:
 *   "plugin:pinokio.chat:meta" → look for a plugin node matching "pinokio.chat" or its plugins
 *   "global" → "manager"
 *   "plugins_index" → "manager"
 */
function resolveChannelTarget(channel: string, nodeIds: Set<string>): string | null {
	if (channel === 'global' || channel === 'plugins_index') return 'manager';

	// "plugin:pinokio.X:meta" or "plugin:pinokio.X:readme"
	const pluginMatch = channel.match(/^plugin:([^:]+):(.+)$/);
	if (pluginMatch) {
		const manifestId = pluginMatch[1]; // e.g. "pinokio.chat"

		// Look for nodes that contain this manifest ID
		for (const nodeId of nodeIds) {
			if (!nodeId.startsWith('plugin:') && !nodeId.startsWith('conn:')) continue;
			const name = nodeId.replace(/^(plugin:|conn:)/, '');
			// Direct match like "pinokio.chat"
			if (name === manifestId) return nodeId;
			// Match plugin agents like "chat_agent" — extract short name from manifest
			const shortName = manifestId.replace(/^pinokio\./, '');
			if (name.startsWith(shortName + '_') || name === shortName) return nodeId;
		}
	}

	return null;
}

/**
 * Resolve a node ID through group nodes.
 * If the node isn't directly in the graph but is a child of a group node, return the group node ID.
 */
function resolveToGraphNode(nodeId: string, graph: TopologyGraph): string | null {
	const graphNodeIds = new Set(graph.nodes.map((n) => n.id));
	if (graphNodeIds.has(nodeId)) return nodeId;

	// Check if it's a child of a group node
	for (const node of graph.nodes) {
		if (node.kind === 'group' && node.childNodeIds?.includes(nodeId)) {
			return node.id;
		}
	}

	return null;
}

/**
 * Find an edge between two node IDs in the graph.
 */
function findEdge(graph: TopologyGraph, sourceId: string, targetId: string): TopologyEdge | null {
	return graph.edges.find(
		(e) =>
			(e.source === sourceId && e.target === targetId) ||
			(e.source === targetId && e.target === sourceId)
	) ?? null;
}

function computeIntensity(count: number): EdgeActivity['intensity'] {
	if (count >= 10) return 'high';
	if (count >= 4) return 'medium';
	return 'low';
}

/**
 * Map socket bus activity to topology edge activity for visualization.
 */
export function mapActivityToEdges(
	activity: SocketBusActivity,
	graph: TopologyGraph
): Map<string, EdgeActivity> {
	const result = new Map<string, EdgeActivity>();
	if (activity.messages.length === 0 || graph.edges.length === 0) return result;

	// Build the set of all node IDs from the flat graph
	const allNodeIds = new Set(graph.nodes.map((n) => n.id));
	// Also include child node IDs from group nodes
	for (const node of graph.nodes) {
		if (node.childNodeIds) {
			for (const childId of node.childNodeIds) {
				allNodeIds.add(childId);
			}
		}
	}

	// Track counts per edge
	const edgeCounts = new Map<string, { count: number; lastSeq: number }>();

	for (const msg of activity.messages) {
		// Resolve sender to a node ID
		const senderNodeId = resolveNodeId(msg.sender_resource, allNodeIds);
		if (!senderNodeId) continue;

		// Resolve channel to a target node ID
		const targetNodeId = resolveChannelTarget(msg.channel, allNodeIds);
		if (!targetNodeId) continue;

		// Resolve through groups (for grouped view)
		const resolvedSource = resolveToGraphNode(senderNodeId, graph);
		const resolvedTarget = resolveToGraphNode(targetNodeId, graph);
		if (!resolvedSource || !resolvedTarget) continue;
		if (resolvedSource === resolvedTarget) continue; // skip self-loops

		// Find the edge
		const edge = findEdge(graph, resolvedSource, resolvedTarget);
		if (!edge) continue;

		const existing = edgeCounts.get(edge.id);
		if (existing) {
			existing.count++;
			existing.lastSeq = Math.max(existing.lastSeq, msg.seq);
		} else {
			edgeCounts.set(edge.id, { count: 1, lastSeq: msg.seq });
		}
	}

	for (const [edgeId, data] of edgeCounts) {
		result.set(edgeId, {
			messageCount: data.count,
			lastSeq: data.lastSeq,
			intensity: computeIntensity(data.count)
		});
	}

	return result;
}
