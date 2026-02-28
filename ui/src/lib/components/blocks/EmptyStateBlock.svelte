<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import EmptyState from '../EmptyState.svelte';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'empty_state' }> }>();
</script>

<EmptyState
	title={block.title}
	detail={block.detail}
	actionLabel={block.actionLabel}
	actionHref={block.actionHref}
/>
