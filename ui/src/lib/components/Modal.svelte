<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title = '',
		wide = false,
		children
	} = $props<{
		open?: boolean;
		title?: string;
		wide?: boolean;
		children?: Snippet;
	}>();

	function onOverlayClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			open = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			open = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay" onclick={onOverlayClick}>
		<div class="{wide ? 'modal-panel-wide' : 'modal-panel'} p-5" role="dialog" aria-modal="true">
			{#if title}
				<div
					class="mb-4 flex items-center justify-between border-b border-[var(--line)] pb-3"
				>
					<h2 class="text-lg font-semibold">{title}</h2>
					<button class="btn btn-neutral" onclick={() => (open = false)}>Close</button>
				</div>
			{/if}
			{@render children?.()}
		</div>
	</div>
{/if}
