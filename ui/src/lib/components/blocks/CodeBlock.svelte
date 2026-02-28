<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'code' }> }>();
</script>

<div class="code-shell">
	{#if block.title}
		<div
			class="border-b border-white/12 px-3 py-2 text-xs uppercase tracking-wide text-[#b4d8c8]"
		>
			{block.title}
		</div>
	{/if}
	<pre class="mono overflow-x-auto p-3 text-xs leading-relaxed"><code>{block.code}</code></pre>
</div>
