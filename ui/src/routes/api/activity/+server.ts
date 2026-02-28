import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { join } from 'node:path';
import { resolveWorkspaceRoot } from '$lib/ui/runtime';
import { readSocketBusActivity } from '$lib/ui/socket-bus';

export const GET: RequestHandler = async () => {
	try {
		const root = await resolveWorkspaceRoot();
		const busDir = join(root, '.pka', 'socket-bus');
		const activity = await readSocketBusActivity(busDir);
		return json(
			{ ok: true, activity },
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
