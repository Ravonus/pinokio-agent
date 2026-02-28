<script lang="ts">
	import type { PageData } from './$types';
	import EmptyState from '$lib/components/EmptyState.svelte';

	let { data } = $props<{ data: PageData }>();

	function timeLabel(value: number): string {
		if (!value) return 'unknown';
		return new Date(value).toLocaleString();
	}
</script>

<section class="surface surface-strong p-5 md:p-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="max-w-2xl">
			<h1 class="text-2xl font-bold">Agent Pages</h1>
			<p class="subtle mt-1 text-sm">
				Pages published by agents and plugins through manager-approved task outputs.
			</p>
		</div>
		<a class="btn btn-neutral" href="/ui/configure">Configure</a>
	</div>
</section>

{#if data.extensionPages.length > 0}
	<section class="surface mt-4 p-4 md:p-5">
		<h2 class="text-lg font-semibold">Extension Pages</h2>
		<p class="subtle mt-1 text-sm">Custom pages registered by plugins and systems.</p>
		<div class="card-grid mt-3">
			{#each data.extensionPages as extension}
				<article class="surface-subtle rounded-xl border border-[var(--line)] p-4">
					<p class="mono subtle text-xs uppercase tracking-[0.1em]">extension:{extension.name}</p>
					<h3 class="mt-1 text-lg font-semibold">{extension.title}</h3>
					<p class="subtle mt-1 text-sm">{extension.detail}</p>
					<a class="btn btn-primary mt-4" href={extension.route}>Open</a>
				</article>
			{/each}
		</div>
	</section>
{/if}

{#if data.pages.length === 0}
	<section class="surface mt-4 p-6">
		<EmptyState
			title="No pages published yet"
			detail="When a task returns ui_page or ui_pages data, it will appear here automatically."
			actionLabel="Run a Task"
			actionHref="/ui/configure/tasks"
		/>
	</section>
{:else}
	<div class="card-grid mt-4">
		{#each data.pages as pg}
			<article class="surface raise-in rounded-xl p-4">
				<div class="flex items-start justify-between gap-2">
					<div>
						<p class="mono subtle text-xs uppercase tracking-[0.1em]">{pg.sourceLabel}</p>
						<h2 class="mt-1 text-lg font-semibold">{pg.title}</h2>
					</div>
					<span class="badge badge-neutral">{pg.sourceLabel.split(':')[0] ?? 'agent'}</span>
				</div>
				<p class="mono subtle mt-2 text-xs">updated: {timeLabel(pg.updatedAtMs)}</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<a class="btn btn-primary" href={pg.route}>Open</a>
					<a class="btn btn-neutral" href={`/ui/apps/${pg.id}`}>Details</a>
				</div>
			</article>
		{/each}
	</div>
{/if}
