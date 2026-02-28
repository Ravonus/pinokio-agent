<script lang="ts">
	import type { UiBlock, UiTone } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'timeline' }> }>();

	const dotColor = (tone: UiTone | undefined): string => {
		switch (tone) {
			case 'success':
				return 'bg-[var(--accent)]';
			case 'warning':
				return 'bg-[var(--warn)]';
			case 'danger':
				return 'bg-[var(--danger)]';
			default:
				return 'bg-[var(--bg-3)]';
		}
	};
</script>

<div class="space-y-0">
	{#each block.events as event, i}
		<div class="flex gap-3">
			<div class="flex flex-col items-center">
				<div class={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dotColor(event.tone)}`}></div>
				{#if i < block.events.length - 1}
					<div class="w-px flex-1 bg-[var(--line)]"></div>
				{/if}
			</div>
			<div class="pb-4">
				<p class="text-sm font-semibold">{event.title}</p>
				{#if event.timestamp}
					<p class="mono subtle mt-0.5 text-xs">{event.timestamp}</p>
				{/if}
				{#if event.description}
					<p class="subtle mt-1 text-sm">{event.description}</p>
				{/if}
			</div>
		</div>
	{/each}
</div>
