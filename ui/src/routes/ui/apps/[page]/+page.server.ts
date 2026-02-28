import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getPublishedPage } from '$lib/ui/published-pages';

export const load: PageServerLoad = async ({ params }) => {
	const record = await getPublishedPage(params.page);
	if (!record) {
		throw error(404, `Published app page not found: ${params.page}`);
	}
	return { record };
};
