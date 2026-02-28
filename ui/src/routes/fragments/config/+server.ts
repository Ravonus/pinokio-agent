import type { RequestHandler } from './$types';
import { buildConfigModel } from '$lib/ui/runtime';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function valueClass(tone?: string): string {
	if (tone === 'warning') {
		return 'tone-warning';
	}
	if (tone === 'danger') {
		return 'tone-danger';
	}
	if (tone === 'success') {
		return 'tone-success';
	}
	return 'tone-neutral';
}

export const GET: RequestHandler = async () => {
	const model = await buildConfigModel();
	const summaryBlock = model.sections
		.flatMap((section) => section.blocks)
		.find((block) => block.type === 'key_values');

	const rows = summaryBlock
		? summaryBlock.items
				.slice(0, 8)
				.map(
					(item) => `
					<div class="grid grid-cols-[1fr_1fr] gap-2 border-b border-[var(--line)] py-1.5 last:border-b-0">
						<p class="mono text-[11px] subtle">${escapeHtml(item.key)}</p>
						<p class="mono text-[11px] ${valueClass(item.tone)}">${escapeHtml(item.value)}</p>
					</div>
				`
				)
				.join('')
		: '';

	const html = rows
		? `<div class="surface-subtle rounded-lg border border-[var(--line)] p-2">${rows}</div>`
		: '<p class="mono text-xs subtle">No config summary available.</p>';

	return new Response(html, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/html; charset=utf-8'
		}
	});
};
