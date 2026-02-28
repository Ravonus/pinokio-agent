<script lang="ts">
	import type { UiBlock, UiTone } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'actions' }> }>();

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

<div class="flex flex-wrap gap-2">
	{#each block.items as item}
		<a class={actionClass(item.tone)} href={item.href}>{item.label}</a>
	{/each}
</div>
