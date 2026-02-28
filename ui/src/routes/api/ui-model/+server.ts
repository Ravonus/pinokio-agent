import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildAppsModel, buildConfigModel, buildHealthModel } from '$lib/ui/runtime';
import { loadConfigureUiBundle } from '$lib/ui/configure-model';

export const GET: RequestHandler = async ({ url }) => {
	const rawView = url.searchParams.get('view');
	const view =
		rawView === 'config' || rawView === 'configure' || rawView === 'apps' ? rawView : 'health';
	const model =
		view === 'config'
			? await buildConfigModel()
			: view === 'apps'
				? await buildAppsModel()
			: view === 'configure'
				? (await loadConfigureUiBundle()).model
				: await buildHealthModel();
	return json(model, {
		headers: {
			'cache-control': 'no-store'
		}
	});
};
