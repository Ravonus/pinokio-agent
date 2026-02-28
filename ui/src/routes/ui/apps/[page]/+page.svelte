<script lang="ts">
	import UiRenderer from '$lib/components/UiRenderer.svelte';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();

	function timeLabel(value: number): string {
		if (!value) {
			return 'unknown';
		}
		return new Date(value).toLocaleString();
	}
</script>

<section class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
	<div class="raise-in">
		<UiRenderer model={data.record.model} />
	</div>

	<aside class="surface raise-in delay-1 p-4 md:p-5">
		<h2 class="text-lg font-semibold">Page metadata</h2>
		<div class="mt-3 space-y-2">
			<p class="mono subtle text-xs">id: {data.record.id}</p>
			<p class="mono subtle text-xs">source: {data.record.sourceLabel}</p>
			<p class="mono subtle text-xs">created: {timeLabel(data.record.createdAtMs)}</p>
			<p class="mono subtle text-xs">updated: {timeLabel(data.record.updatedAtMs)}</p>
		</div>
		<div class="mt-4 flex flex-wrap gap-2">
			<a class="btn btn-primary" href="/ui/apps">All Pages</a>
			<a class="btn btn-neutral" href="/ui/configure">Configure</a>
		</div>
	</aside>
</section>
