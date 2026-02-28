import type { LayoutServerLoad } from './$types';
import { discoverExtensionSurfaces } from '$lib/ui/manager';

type NavigationExtension = {
	name: string;
	title: string;
	route: string;
	order: number;
};

export const load: LayoutServerLoad = async () => {
	try {
		const surfaces = await discoverExtensionSurfaces();
		const navigationExtensions: NavigationExtension[] = surfaces
			.filter((surface) => {
				const slot = surface.slot ?? 'settings';
				return surface.enabled !== false && slot === 'navigation' && Boolean(surface.route);
			})
			.map((surface) => ({
				name: surface.name,
				title: surface.title?.trim() || surface.name,
				route: String(surface.route),
				order: typeof surface.order === 'number' ? surface.order : 100
			}))
			.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

		return { navigationExtensions };
	} catch {
		return { navigationExtensions: [] as NavigationExtension[] };
	}
};
