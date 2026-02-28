import type { PageServerLoad } from './$types';
import { loadConfigureUiBundle } from '$lib/ui/configure-model';

export const load: PageServerLoad = async () => {
	return loadConfigureUiBundle();
};
