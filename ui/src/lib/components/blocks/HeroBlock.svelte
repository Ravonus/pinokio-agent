<script lang="ts">
	import type { UiBlock, UiTone } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'hero' }> }>();

	const actionClass = (tone: UiTone | undefined): string => {
		switch (tone) {
			case 'success':
				return 'btn btn-primary';
			case 'warning':
				return 'btn btn-warn';
			case 'danger':
				return 'btn btn-danger';
			default:
				return 'btn btn-neutral';
		}
	};
</script>

<div
	class="rounded-2xl border border-[var(--line)] bg-gradient-to-br from-[var(--bg-1)] to-[var(--bg-2)] p-6 md:p-8"
>
	<div class="max-w-2xl">
		<h2 class="text-2xl font-bold md:text-3xl">{block.title}</h2>
		{#if block.subtitle}
			<p class="subtle mt-2 text-base">{block.subtitle}</p>
		{/if}
		{#if block.actions.length > 0}
			<div class="mt-5 flex flex-wrap gap-2">
				{#each block.actions as action}
					<a class={actionClass(action.tone)} href={action.href}>{action.label}</a>
				{/each}
			</div>
		{/if}
	</div>
	{#if block.image}
		<img src={block.image} alt="" class="mt-4 max-h-48 rounded-xl object-cover" />
	{/if}
</div>
