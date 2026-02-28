<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'media' }> }>();
</script>

<figure class="rounded-xl border border-[var(--line)] overflow-hidden">
	{#if block.kind === 'video'}
		<video
			src={block.src}
			controls
			class="w-full"
			style={block.width ? `max-width: ${block.width}px` : ''}
		>
			<track kind="captions" />
		</video>
	{:else if block.kind === 'iframe'}
		<iframe
			src={block.src}
			title={block.alt ?? 'Embedded content'}
			class="w-full border-0"
			style={`height: ${block.height ?? 400}px`}
			loading="lazy"
		></iframe>
	{:else}
		<img
			src={block.src}
			alt={block.alt ?? ''}
			class="w-full"
			style={block.width ? `max-width: ${block.width}px` : ''}
			loading="lazy"
		/>
	{/if}
	{#if block.caption}
		<figcaption class="subtle px-3 py-2 text-center text-xs">{block.caption}</figcaption>
	{/if}
</figure>
