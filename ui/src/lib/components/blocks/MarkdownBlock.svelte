<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'markdown' }> }>();

	function renderMarkdown(md: string): string {
		let html = md
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-3 mb-1">$1</h3>')
			.replace(/^## (.+)$/gm, '<h2 class="text-xl font-semibold mt-4 mb-1">$1</h2>')
			.replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-4 mb-2">$1</h1>')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.+?)\*/g, '<em>$1</em>')
			.replace(
				/`(.+?)`/g,
				'<code class="mono rounded bg-[var(--bg-2)] px-1.5 py-0.5 text-sm">$1</code>'
			)
			.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
			.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
			.replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal">$2</li>')
			.replace(/\n\n/g, '</p><p class="mt-2">')
			.replace(/\n/g, '<br />');
		return `<p class="mt-2">${html}</p>`;
	}
</script>

<div class="text-sm leading-relaxed">
	{@html renderMarkdown(block.content)}
</div>
