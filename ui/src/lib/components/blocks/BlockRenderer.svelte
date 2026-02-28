<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import NoticeBlock from './NoticeBlock.svelte';
	import StatsBlock from './StatsBlock.svelte';
	import KeyValuesBlock from './KeyValuesBlock.svelte';
	import TableBlock from './TableBlock.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import ActionsBlock from './ActionsBlock.svelte';
	import FormBlock from './FormBlock.svelte';
	import HeroBlock from './HeroBlock.svelte';
	import MarkdownBlock from './MarkdownBlock.svelte';
	import MediaBlock from './MediaBlock.svelte';
	import DividerBlock from './DividerBlock.svelte';
	import TabsBlock from './TabsBlock.svelte';
	import AccordionBlock from './AccordionBlock.svelte';
	import ColumnsBlock from './ColumnsBlock.svelte';
	import TimelineBlock from './TimelineBlock.svelte';
	import ChatMessagesBlock from './ChatMessagesBlock.svelte';
	import EmptyStateBlock from './EmptyStateBlock.svelte';
	import MetricCardsBlock from './MetricCardsBlock.svelte';
	import ProgressBlock from './ProgressBlock.svelte';
	import StepperBlock from './StepperBlock.svelte';
	import CalloutBlock from './CalloutBlock.svelte';

	let {
		block,
		pageId = ''
	} = $props<{
		block: UiBlock;
		pageId?: string;
	}>();

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const componentMap: Record<string, any> = {
		notice: NoticeBlock,
		stats: StatsBlock,
		key_values: KeyValuesBlock,
		table: TableBlock,
		code: CodeBlock,
		actions: ActionsBlock,
		form: FormBlock,
		hero: HeroBlock,
		markdown: MarkdownBlock,
		media: MediaBlock,
		divider: DividerBlock,
		tabs: TabsBlock,
		accordion: AccordionBlock,
		columns: ColumnsBlock,
		timeline: TimelineBlock,
		chat_messages: ChatMessagesBlock,
		empty_state: EmptyStateBlock,
		metric_cards: MetricCardsBlock,
		progress: ProgressBlock,
		stepper: StepperBlock,
		callout: CalloutBlock
	};

	const Component = $derived(componentMap[block.type]);
</script>

{#if Component}
	<Component {block} {pageId} />
{:else}
	<div class="surface-subtle rounded-xl border border-[var(--line)] p-3">
		<p class="subtle text-sm">Unsupported block type: {block.type}</p>
	</div>
{/if}
