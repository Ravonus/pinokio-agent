import type { PageServerLoad } from './$types';
import { buildAppsModel, buildConfigModel, buildHealthModel } from '$lib/ui/runtime';
import { loadConfigureUiBundle } from '$lib/ui/configure-model';

export const load: PageServerLoad = async ({ url }) => {
	const rawView = url.searchParams.get('view');
	const view =
		rawView === 'config' || rawView === 'configure' || rawView === 'apps' ? rawView : 'health';
	const [healthModel, configModel, appsModel, configureBundle] = await Promise.all([
		buildHealthModel(),
		buildConfigModel(),
		buildAppsModel(),
		loadConfigureUiBundle()
	]);
	return {
		view,
		healthModel,
		configModel,
		appsModel,
		configureModel: configureBundle.model
	};
};
