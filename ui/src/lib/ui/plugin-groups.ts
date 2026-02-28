import type { UiExtensionSurface, ManagedServiceStatus } from './manager';

export interface PluginGroupDef {
	id: string;
	label: string;
	description: string;
	icon: string; // SVG path data
	matchNames: string[];
	matchPrefix?: string;
	serviceNames?: string[];
	builtIn?: boolean; // true = shipped with system, cannot be removed
}

export interface PluginGroup {
	def: PluginGroupDef;
	surfaces: UiExtensionSurface[];
	services: ManagedServiceStatus[];
	allEnabled: boolean;
	someEnabled: boolean;
	enabledCount: number;
}

/** Built-in group definitions derived from agent.toml structure */
const BUILTIN_GROUPS: PluginGroupDef[] = [
	{
		id: 'database',
		label: 'Database',
		description: 'PostgreSQL database agents for CRUD operations, routing, and data management.',
		icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
		matchNames: [
			'postgres_agent',
			'db_router_agent',
			'db_read_agent',
			'db_write_agent',
			'db_create_agent',
			'db_update_agent',
			'db_delete_agent'
		],
		matchPrefix: 'db_',
		serviceNames: ['postgres_main'],
		builtIn: true
	},
	{
		id: 'chat',
		label: 'Chat',
		description: 'Interactive chat interface with worker agents for conversation processing.',
		icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
		matchNames: ['chat_agent', 'chat_worker_agent', 'chat'],
		matchPrefix: 'chat_',
		builtIn: true
	},
	{
		id: 'memory',
		label: 'Memory',
		description: 'Persistent memory agent for storing and retrieving conversation context.',
		icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z',
		matchNames: ['memory_agent'],
		matchPrefix: 'memory_',
		builtIn: true
	},
	{
		id: 'system',
		label: 'System Utilities',
		description: 'System-level agents for host operations and debugging.',
		icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
		matchNames: ['echo', 'unsafe_host_agent'],
		matchPrefix: undefined,
		builtIn: true
	},
	{
		id: 'connections',
		label: 'Connections',
		description: 'External service integrations and connection handlers.',
		icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
		matchNames: ['telegram'],
		matchPrefix: undefined,
		builtIn: true
	},
	{
		id: 'core',
		label: 'Core',
		description: 'Core system surfaces for configuration and management.',
		icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
		matchNames: ['configure'],
		matchPrefix: undefined,
		builtIn: true
	}
];

/** Default icon for auto-discovered groups (grid/puzzle icon) */
const AUTO_GROUP_ICON =
	'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z';

/**
 * Extract a group key from a surface name by taking the first word.
 * e.g. "explorer_read_agent" → "explorer", "postgres_agent" → "postgres"
 */
function extractGroupKey(name: string): string {
	const idx = name.indexOf('_');
	return idx > 0 ? name.substring(0, idx) : name;
}

function titleCase(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build grouped plugin data from flat surfaces and services.
 *
 * All surfaces (including core) go through the same grouping logic.
 * Each surface is matched to at most one group via exact name match first, then prefix match.
 * Remaining unmatched surfaces are auto-grouped by common name prefix so new plugins
 * automatically cluster together without needing manual group definitions.
 */
export function buildPluginGroups(
	surfaces: UiExtensionSurface[],
	services: ManagedServiceStatus[] = [],
	customDefs: PluginGroupDef[] = []
): {
	groups: PluginGroup[];
	ungrouped: UiExtensionSurface[];
} {
	const allDefs = [...BUILTIN_GROUPS, ...customDefs];

	// Build a map of service name → status
	const serviceMap = new Map<string, ManagedServiceStatus>();
	for (const svc of services) {
		serviceMap.set(svc.name, svc);
	}

	// Track which surfaces have been claimed by a group
	const claimed = new Set<string>();

	const groups: PluginGroup[] = [];

	for (const def of allDefs) {
		const matched: UiExtensionSurface[] = [];

		// Exact name matches first
		for (const s of surfaces) {
			if (def.matchNames.includes(s.name) && !claimed.has(s.name)) {
				matched.push(s);
				claimed.add(s.name);
			}
		}

		// Prefix fallback for unclaimed surfaces
		if (def.matchPrefix) {
			for (const s of surfaces) {
				if (!claimed.has(s.name) && s.name.startsWith(def.matchPrefix)) {
					matched.push(s);
					claimed.add(s.name);
				}
			}
		}

		if (matched.length === 0) continue;

		// Gather associated services
		const groupServices: ManagedServiceStatus[] = [];
		if (def.serviceNames) {
			for (const svcName of def.serviceNames) {
				const svc = serviceMap.get(svcName);
				if (svc) groupServices.push(svc);
			}
		}

		const enabledSurfaces = matched.filter((s) => s.enabled !== false);

		groups.push({
			def,
			surfaces: matched,
			services: groupServices,
			allEnabled: enabledSurfaces.length === matched.length,
			someEnabled: enabledSurfaces.length > 0,
			enabledCount: enabledSurfaces.length
		});
	}

	// --- Auto-group remaining unclaimed surfaces by common name prefix ---
	// This ensures new plugins (e.g. explorer_read_agent, explorer_write_agent)
	// automatically cluster without requiring manual group definitions.
	const remaining = surfaces.filter((s) => !claimed.has(s.name));
	const prefixBuckets = new Map<string, UiExtensionSurface[]>();

	for (const s of remaining) {
		const key = extractGroupKey(s.name);
		if (!prefixBuckets.has(key)) prefixBuckets.set(key, []);
		prefixBuckets.get(key)!.push(s);
	}

	const stillUngrouped: UiExtensionSurface[] = [];

	for (const [prefix, bucket] of prefixBuckets) {
		// Only auto-group when 2+ surfaces share a prefix — singletons stay ungrouped
		if (bucket.length < 2) {
			stillUngrouped.push(...bucket);
			continue;
		}

		const enabledSurfaces = bucket.filter((s) => s.enabled !== false);

		groups.push({
			def: {
				id: `auto_${prefix}`,
				label: titleCase(prefix),
				description: `${titleCase(prefix)} plugin group.`,
				icon: AUTO_GROUP_ICON,
				matchNames: bucket.map((s) => s.name),
				builtIn: false
			},
			surfaces: bucket,
			services: [],
			allEnabled: enabledSurfaces.length === bucket.length,
			someEnabled: enabledSurfaces.length > 0,
			enabledCount: enabledSurfaces.length
		});

		// Mark as claimed so they don't leak
		for (const s of bucket) claimed.add(s.name);
	}

	return { groups, ungrouped: stillUngrouped };
}
