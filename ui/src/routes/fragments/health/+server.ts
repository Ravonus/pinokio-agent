import type { RequestHandler } from './$types';
import { buildHealthModel } from '$lib/ui/runtime';

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function badgeClass(tone?: string): string {
	if (tone === 'success') {
		return 'badge badge-ok';
	}
	if (tone === 'warning') {
		return 'badge badge-warn';
	}
	if (tone === 'danger') {
		return 'badge badge-danger';
	}
	return 'badge badge-neutral';
}

export const GET: RequestHandler = async () => {
	const model = await buildHealthModel();
	const statsBlock = model.sections
		.flatMap((section) => section.blocks)
		.find((block) => block.type === 'stats');

	const html = statsBlock
		? `<div class="space-y-2">${statsBlock.items
				.map(
					(item) => `
					<article class="surface-subtle rounded-lg border border-[var(--line)] p-2">
						<div class="flex items-center justify-between gap-2">
							<p class="text-xs font-semibold">${escapeHtml(item.label)}</p>
							<span class="${badgeClass(item.tone)}">${escapeHtml(item.tone ?? 'neutral')}</span>
						</div>
						<p class="mono mt-1 text-xs">${escapeHtml(item.value)}</p>
						<p class="mono text-[11px] subtle">${escapeHtml(item.detail ?? '')}</p>
					</article>
				`
				)
				.join('')}</div>`
		: '<p class="mono text-xs subtle">No health data available.</p>';

	return new Response(html, {
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/html; charset=utf-8'
		}
	});
};
