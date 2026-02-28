import type { PageServerLoad } from './$types';
import { configureStatus, configureServices, configureDoctor, discoverExtensionSurfaces } from '$lib/ui/manager';
import { buildTopologyGraph } from '$lib/ui/topology';

export const load: PageServerLoad = async () => {
	try {
		const [credentials, services, doctor, surfaces] = await Promise.all([
			configureStatus(),
			configureServices(),
			configureDoctor(),
			discoverExtensionSurfaces()
		]);
		const graph = buildTopologyGraph(services, credentials, doctor, surfaces);
		return { graph, surfaces, services };
	} catch {
		return {
			graph: { nodes: [], edges: [], refreshedAt: new Date().toISOString() },
			surfaces: [],
			services: []
		};
	}
};
