import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseUiModel, type UiModel } from './model';

const PublishedPageSourceSchema = z
	.object({
		task_id: z.string().optional(),
		task_summary: z.string().optional(),
		agent_id: z.string().optional(),
		resource: z.string().optional(),
		action: z.string().optional(),
		execution: z.string().optional(),
		plugin: z.string().nullable().optional(),
		connection: z.string().nullable().optional()
	})
	.passthrough();

const PublishedPageFileSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	route: z.string().min(1),
	created_at_ms: z.number().int().nonnegative().optional(),
	updated_at_ms: z.number().int().nonnegative().optional(),
	source: PublishedPageSourceSchema.optional(),
	model: z.unknown()
});

export interface PublishedPageSummary {
	id: string;
	title: string;
	route: string;
	updatedAtMs: number;
	sourceLabel: string;
}

export interface PublishedPageRecord {
	id: string;
	title: string;
	route: string;
	createdAtMs: number;
	updatedAtMs: number;
	sourceLabel: string;
	source?: z.infer<typeof PublishedPageSourceSchema>;
	model: UiModel;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolvePublishedPagesDir(): string {
	const explicit = process.env.PINOKIO_UI_PAGES_DIR?.trim();
	if (explicit) {
		return explicit;
	}
	const home = process.env.HOME?.trim();
	if (home) {
		return join(home, '.pinokio-agent', 'ui-pages');
	}
	return join(process.cwd(), '.pinokio-agent', 'ui-pages');
}

function sanitizePageId(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9._\-/\s:]/g, '')
		.replace(/[._/\s:]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function sourceLabel(source?: z.infer<typeof PublishedPageSourceSchema>): string {
	if (!source) {
		return 'system';
	}
	if (source.plugin) {
		return `plugin:${source.plugin}`;
	}
	if (source.connection) {
		return `connection:${source.connection}`;
	}
	if (source.resource) {
		return source.resource;
	}
	return 'system';
}

export async function listPublishedPages(): Promise<PublishedPageSummary[]> {
	const dir = resolvePublishedPagesDir();
	if (!(await pathExists(dir))) {
		return [];
	}

	const entries = await readdir(dir, { withFileTypes: true });
	const out: PublishedPageSummary[] = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) {
			continue;
		}
		const fullPath = join(dir, entry.name);
		try {
			const raw = await readFile(fullPath, 'utf8');
			const parsed = PublishedPageFileSchema.parse(JSON.parse(raw));
			const id = sanitizePageId(parsed.id);
			if (!id) {
				continue;
			}
			out.push({
				id,
				title: parsed.title,
				route: parsed.route || `/ui/apps/${id}`,
				updatedAtMs: parsed.updated_at_ms ?? 0,
				sourceLabel: sourceLabel(parsed.source)
			});
		} catch {
			// Ignore invalid files so one bad payload doesn't break the app list.
		}
	}

	out.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id));
	return out;
}

export async function getPublishedPage(id: string): Promise<PublishedPageRecord | null> {
	const safeId = sanitizePageId(id);
	if (!safeId) {
		return null;
	}

	const file = join(resolvePublishedPagesDir(), `${safeId}.json`);
	if (!(await pathExists(file))) {
		return null;
	}

	try {
		const raw = await readFile(file, 'utf8');
		const parsed = PublishedPageFileSchema.parse(JSON.parse(raw));
		const model = parseUiModel(parsed.model);
		return {
			id: safeId,
			title: parsed.title,
			route: parsed.route || `/ui/apps/${safeId}`,
			createdAtMs: parsed.created_at_ms ?? 0,
			updatedAtMs: parsed.updated_at_ms ?? 0,
			sourceLabel: sourceLabel(parsed.source),
			source: parsed.source,
			model
		};
	} catch {
		return null;
	}
}
