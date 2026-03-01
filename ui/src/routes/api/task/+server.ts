import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { runTaskFromApp } from '$lib/ui/manager';
import { persistChatFromTaskResult } from '$lib/server/chat-history';

const TaskSchema = z.object({
	task: z.string().min(1),
	resource: z.string().min(1),
	action: z.enum(['create', 'read', 'update', 'delete']),
	target: z.string().optional(),
	runtime: z.string().optional(),
	profile: z.string().optional(),
	image: z.string().optional(),
	network: z.string().optional()
});

export const POST: RequestHandler = async ({ request }) => {
	try {
		const payload = TaskSchema.parse(await request.json());
		const report = await runTaskFromApp(payload);
		try {
			await persistChatFromTaskResult({
				resource: payload.resource,
				task: payload.task,
				target: payload.target,
				profile: payload.profile,
				report
			});
		} catch {
			// Chat DB persistence is best-effort and must never fail task delivery.
		}
		return json({
			ok: true,
			report
		});
	} catch (error) {
		return json(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			},
			{ status: 400 }
		);
	}
};
