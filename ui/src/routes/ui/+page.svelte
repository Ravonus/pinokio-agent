<script lang="ts">
	import UiRenderer from '$lib/components/UiRenderer.svelte';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();

	const model = $derived(
		data.view === 'config'
			? data.configModel
			: data.view === 'apps'
				? data.appsModel
				: data.view === 'configure'
					? data.configureModel
					: data.healthModel
	);
</script>

<section class="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
	<div class="raise-in">
		<UiRenderer model={model} />
	</div>

	<aside class="surface raise-in delay-1 p-4 md:p-5">
		<h2 class="text-lg font-semibold">Live snapshots</h2>
		<p class="subtle mt-1 text-sm">
			These small panels refresh in place, so users can monitor manager health without leaving their current view.
		</p>

		<div class="mt-4 space-y-3">
			<section class="surface-subtle rounded-xl border border-[var(--line)] p-3">
				<header class="mb-2 flex items-center justify-between">
					<h3 class="font-semibold">Health</h3>
					<span class="mono subtle text-xs">20s</span>
				</header>
				<div id="health-fragment" hx-get="/fragments/health" hx-trigger="load, every 20s" hx-swap="innerHTML">
					<p class="mono subtle text-xs">Loading health snapshot...</p>
				</div>
			</section>

			<section class="surface-subtle rounded-xl border border-[var(--line)] p-3">
				<header class="mb-2 flex items-center justify-between">
					<h3 class="font-semibold">Config</h3>
					<span class="mono subtle text-xs">30s</span>
				</header>
				<div id="config-fragment" hx-get="/fragments/config" hx-trigger="load, every 30s" hx-swap="innerHTML">
					<p class="mono subtle text-xs">Loading config snapshot...</p>
				</div>
			</section>
		</div>

		<div class="mt-4 flex flex-wrap gap-2">
			<a class="btn btn-primary" href="/ui/configure">Configure</a>
			<a class="btn btn-neutral" href="/ui/configure/database">Database</a>
			<a class="btn btn-soft" href="/ui/chat">Chat Agent</a>
			<a class="btn btn-neutral" href="/ui/skills">Skills</a>
			<a class="btn btn-neutral" href="/ui/apps">Agent Pages</a>
		</div>
	</aside>
</section>
