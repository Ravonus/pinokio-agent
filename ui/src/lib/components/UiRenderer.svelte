<script lang="ts">
	import type { UiModel } from '$lib/ui/model';
	import BlockRenderer from './blocks/BlockRenderer.svelte';

	let { model } = $props<{ model: UiModel }>();
</script>

<section class="surface surface-strong p-6 md:p-8">
	<div class="border-b border-[var(--line)] pb-5">
		<h1 class="headline">{model.title}</h1>
		{#if model.subtitle}
			<p class="subtle mt-2">{model.subtitle}</p>
		{/if}
		{#if model.refreshedAt}
			<p class="mono subtle mt-2 text-xs">
				Updated {new Date(model.refreshedAt).toLocaleString()}
			</p>
		{/if}
	</div>

	<div class="mt-6 space-y-5">
		{#each model.sections as section (section.id)}
			<section class="surface-subtle raise-in rounded-2xl border border-[var(--line)] p-4 md:p-5">
				<header class="mb-3">
					<h2 class="text-xl font-semibold">{section.title}</h2>
					{#if section.description}
						<p class="subtle text-sm">{section.description}</p>
					{/if}
				</header>

				<div class="space-y-3">
					{#each section.blocks as block}
						<BlockRenderer {block} pageId={model.id} />
					{/each}
				</div>
			</section>
		{/each}
	</div>
</section>
