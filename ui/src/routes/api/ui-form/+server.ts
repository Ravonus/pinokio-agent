import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePublishedPagesDir } from '$lib/ui/published-pages';

function sanitizePart(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9._\-/\s:]/g, '')
		.replace(/[._/\s:]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

async function extractPayload(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get('content-type') || '';
	if (contentType.includes('application/json')) {
		const body = await request.json();
		if (!body || typeof body !== 'object') {
			return {};
		}
		return body as Record<string, unknown>;
	}

	const form = await request.formData();
	const out: Record<string, unknown> = {};
	for (const [key, value] of form.entries()) {
		if (typeof value === 'string') {
			out[key] = value;
		}
	}
	return out;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const payload = await extractPayload(request);
		const pageIdRaw = String(payload.__pinokio_page_id || payload.page_id || 'unknown');
		const formIdRaw = String(payload.__pinokio_form_id || payload.form_id || 'default');
		const pageId = sanitizePart(pageIdRaw) || 'unknown';
		const formId = sanitizePart(formIdRaw) || 'default';

		const root = resolvePublishedPagesDir();
		const targetDir = join(root, 'submissions', pageId, formId);
		await mkdir(targetDir, { recursive: true });

		const timestamp = Date.now();
		const filename = `${timestamp}-${randomUUID().slice(0, 8)}.json`;
		const fullPath = join(targetDir, filename);
		const record = {
			received_at: new Date(timestamp).toISOString(),
			page_id: pageId,
			form_id: formId,
			payload
		};
		await writeFile(fullPath, JSON.stringify(record, null, 2), 'utf8');

		return json({
			ok: true,
			stored: fullPath,
			record
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
