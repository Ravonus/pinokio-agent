import type { PageServerLoad } from './$types';
import { configurePluginCatalog, configureSkills } from '$lib/ui/manager';

export const load: PageServerLoad = async () => {
	const [skillsResult, catalogResult] = await Promise.allSettled([
		configureSkills(),
		configurePluginCatalog()
	]);

	const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : [];
	const pluginNames =
		catalogResult.status === 'fulfilled'
			? catalogResult.value.configured_plugins.map((plugin) => plugin.name)
			: [];

	pluginNames.sort((a, b) => a.localeCompare(b));

	return {
		skills,
		pluginNames
	};
};
