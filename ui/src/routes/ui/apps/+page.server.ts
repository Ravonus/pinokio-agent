import type { PageServerLoad } from './$types';
import { listPublishedPages } from '$lib/ui/published-pages';
import { discoverExtensionSurfaces } from '$lib/ui/manager';

export const load: PageServerLoad = async () => {
	const [pages, surfaces] = await Promise.all([listPublishedPages(), discoverExtensionSurfaces()]);
	const extensionPages = surfaces
		.filter((surface) => {
			const slot = surface.slot ?? 'settings';
			return slot === 'page' && surface.enabled !== false && Boolean(surface.route);
		})
		.map((surface) => ({
			name: surface.name,
			title: surface.title?.trim() || surface.name,
			detail: surface.detail,
			route: String(surface.route),
			order: typeof surface.order === 'number' ? surface.order : 100
		}))
		.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
	return { pages, extensionPages };
};
