import type { PageServerLoad } from './$types';
import { configurePluginCatalog } from '$lib/ui/manager';

export const load: PageServerLoad = async () => {
	try {
		const catalog = await configurePluginCatalog();
		return { catalog };
	} catch {
		return {
			catalog: {
				manifest_dirs: [],
				manifests: [],
				parse_errors: [],
				installed_manifests: [],
				configured_plugins: []
			}
		};
	}
};
