import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { configureStatus, configureServices, configureDoctor, discoverExtensionSurfaces } from '$lib/ui/manager';
import { buildTopologyGraph } from '$lib/ui/topology';

export const GET: RequestHandler = async () => {
	try {
		const [credentials, services, doctor, surfaces] = await Promise.all([
			configureStatus(),
			configureServices(),
			configureDoctor(),
			discoverExtensionSurfaces()
		]);
		const graph = buildTopologyGraph(services, credentials, doctor, surfaces);
		return json(
			{ ok: true, graph },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return json(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			},
			{ status: 500, headers: { 'cache-control': 'no-store' } }
		);
	}
};
