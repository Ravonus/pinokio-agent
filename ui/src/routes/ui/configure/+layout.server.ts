import type { LayoutServerLoad } from './$types';
import { discoverExtensionSurfaces } from '$lib/ui/manager';

type SettingsExtension = {
	name: string;
	title: string;
	route: string;
	order: number;
};

export const load: LayoutServerLoad = async () => {
	try {
		const surfaces = await discoverExtensionSurfaces();
		const settingsExtensions: SettingsExtension[] = surfaces
			.filter((surface) => {
				const slot = surface.slot ?? 'settings';
				return surface.enabled !== false && slot === 'settings' && Boolean(surface.route);
			})
			.map((surface) => ({
				name: surface.name,
				title: surface.title?.trim() || surface.name,
				route: String(surface.route),
				order: typeof surface.order === 'number' ? surface.order : 100
			}))
			.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

		return { settingsExtensions };
	} catch {
		return { settingsExtensions: [] as SettingsExtension[] };
	}
};
