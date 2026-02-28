<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { UiTone } from '$lib/ui/model';

	let { tone = 'neutral', children } = $props<{ tone?: UiTone; children?: Snippet }>();

	const toneClass = (currentTone: UiTone): string => {
		switch (currentTone) {
			case 'success':
				return 'badge badge-ok';
			case 'warning':
				return 'badge badge-warn';
			case 'danger':
				return 'badge badge-danger';
			default:
				return 'badge badge-neutral';
		}
	};
</script>

<span class={toneClass(tone)}>
	{@render children?.()}
</span>
