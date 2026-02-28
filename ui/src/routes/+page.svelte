<section class="surface surface-strong raise-in p-6 md:p-8">
	<div class="max-w-3xl">
		<p class="mono subtle text-xs uppercase tracking-[0.18em]">pinokio.ai</p>
		<h1 class="headline mt-2">Agent Control Center</h1>
		<p class="subtle mt-3 text-sm md:text-base">
			Configure credentials, run tasks, and browse agent-generated pages in one place.
			Agents can publish rich UI experiences with forms, dashboards, wizards, and more.
		</p>
	</div>

	<div class="card-grid mt-6">
		<article class="surface-subtle raise-in delay-1 rounded-xl border border-[var(--line)] p-4">
			<div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold">Configure</h2>
			<p class="subtle mt-1 text-sm">Set up credentials, register extensions, and run tasks.</p>
			<a class="btn btn-primary mt-4" href="/ui/configure">Open</a>
		</article>

		<article class="surface-subtle raise-in delay-2 rounded-xl border border-[var(--line)] p-4">
			<div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2zm0 0V9a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v10m-6 0a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2m0 0V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold">System</h2>
			<p class="subtle mt-1 text-sm">Live health, manager config, and database control.</p>
			<div class="mt-4 flex flex-wrap gap-2">
				<a class="btn btn-neutral" href="/ui?view=health">Health</a>
				<a class="btn btn-neutral" href="/ui?view=config">Config</a>
				<a class="btn btn-neutral" href="/ui/configure/database">Database</a>
			</div>
		</article>

		<article class="surface-subtle raise-in delay-3 rounded-xl border border-[var(--line)] p-4">
			<div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold">Agent Pages</h2>
			<p class="subtle mt-1 text-sm">
				Browse rich UI pages published by agents - forms, dashboards, wizards, and more.
			</p>
			<a class="btn btn-neutral mt-4" href="/ui/apps">Browse</a>
		</article>

		<article class="surface-subtle raise-in delay-3 rounded-xl border border-[var(--line)] p-4">
			<div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-strong)]">
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M8 10h8m-8 4h5m5 6l-3.92-3.13A2 2 0 0 0 12.84 16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-.5" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold">Chat Agent</h2>
			<p class="subtle mt-1 text-sm">
				Quick interactive chat powered by <span class="mono">plugin:chat_agent</span>.
			</p>
			<a class="btn btn-primary mt-4" href="/ui/chat">Open Chat</a>
		</article>
	</div>
</section>
