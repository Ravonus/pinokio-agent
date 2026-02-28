<script lang="ts">
	import type {
		PluginCatalogReport,
		PluginInstallPreview,
		PluginInstallResult,
		PluginManifestSummary,
		PluginPermissionSummary,
		PluginRemoveResult
	} from '$lib/ui/manager';
	import type { PageData } from './$types';

	type PluginFilter = 'all' | 'installed' | 'available';
	type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

	const EMPTY_CATALOG: PluginCatalogReport = {
		manifest_dirs: [],
		manifests: [],
		parse_errors: [],
		installed_manifests: [],
		configured_plugins: []
	};

	let { data } = $props<{ data: PageData }>();
	let catalog = $state<PluginCatalogReport>(EMPTY_CATALOG);
	let selectedManifestId = $state<string>('');
	let searchTerm = $state('');
	let filter = $state<PluginFilter>('all');
	let preview = $state<PluginInstallPreview | null>(null);
	let previewError = $state('');
	let actionError = $state('');
	let actionMessage = $state('');
	let allowMissingDependencies = $state(false);
	let adoptExisting = $state(false);
	let runInstallCommands = $state(true);
	let busyRefresh = $state(false);
	let busyPreview = $state(false);
	let busyInstall = $state(false);
	let busyRemove = $state(false);

	const selectedManifest = $derived(
		catalog.manifests.find((manifest) => manifest.id === selectedManifestId) ?? null
	);

	$effect(() => {
		catalog = ((data as { catalog?: PluginCatalogReport }).catalog ?? EMPTY_CATALOG) as PluginCatalogReport;
	});

	$effect(() => {
		const visible = filteredManifests();
		if (visible.length === 0) {
			selectedManifestId = '';
			preview = null;
			previewError = '';
			return;
		}
		if (!selectedManifestId || !visible.some((manifest) => manifest.id === selectedManifestId)) {
			selectedManifestId = visible[0].id;
		}
	});

	$effect(() => {
		const current = selectedManifestId;
		if (!current) {
			preview = null;
			previewError = '';
			return;
		}
		void loadPreview(current);
	});

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function toneBadgeClass(tone: Tone): string {
		if (tone === 'ok') return 'badge-ok';
		if (tone === 'warn') return 'badge-warn';
		if (tone === 'danger') return 'badge-danger';
		return 'badge-neutral';
	}

	function normalizeLabel(value: string): string {
		return value.replaceAll('_', ' ');
	}

	function countResources(manifest: PluginManifestSummary): string {
		return `${manifest.plugin_count} plugin(s) · ${manifest.ui_extension_count} UI extension(s) · ${manifest.service_count} service(s) · ${manifest.skill_count} skill(s)`;
	}

	function dependencyCount(manifest: PluginManifestSummary): number {
		return (
			manifest.requires.manifests.length +
			manifest.requires.plugins.length +
			manifest.requires.services.length
		);
	}

	function filteredManifests(): PluginManifestSummary[] {
		const term = searchTerm.trim().toLowerCase();
		return catalog.manifests.filter((manifest) => {
			if (filter === 'installed' && !manifest.installed) {
				return false;
			}
			if (filter === 'available' && manifest.installed) {
				return false;
			}
			if (!term) {
				return true;
			}
			const haystack = `${manifest.name}\n${manifest.id}\n${manifest.description}`.toLowerCase();
			return haystack.includes(term);
		});
	}

	function quickSafety(manifest: PluginManifestSummary): {
		title: string;
		detail: string;
		tone: Tone;
	} {
		if (manifest.runtime.unsafe_host_access) {
			return {
				title: 'Host access requested',
				detail: 'This plugin package requests unsafe host access.',
				tone: 'danger'
			};
		}
		if (manifest.runtime.requires_container) {
			return {
				title: 'Container sandbox',
				detail: 'Runs in a container sandbox by default.',
				tone: 'ok'
			};
		}
		if (manifest.runtime.mode.toLowerCase() === 'host') {
			return {
				title: 'Host runtime',
				detail: 'Runs on host runtime. Review before installing.',
				tone: 'warn'
			};
		}
		return {
			title: 'Standard runtime',
			detail: 'Uses standard plugin runtime settings.',
			tone: 'neutral'
		};
	}

	function selectedSafetySummary(
		manifest: PluginManifestSummary,
		previewValue: PluginInstallPreview | null
	): {
		title: string;
		detail: string;
		tone: Tone;
	} {
		if (previewValue?.blocking_conflicts.length) {
			return {
				title: 'Blocked right now',
				detail: 'There are conflicts that must be resolved before install.',
				tone: 'danger'
			};
		}
		if (manifest.runtime.unsafe_host_access) {
			return {
				title: 'Elevated access requested',
				detail: 'This package may run with unsafe host access.',
				tone: 'danger'
			};
		}
		if (previewValue?.warnings.length) {
			return {
				title: 'Needs review',
				detail: `Review ${previewValue.warnings.length} warning(s) before install.`,
				tone: 'warn'
			};
		}
		if (manifest.runtime.requires_container) {
			return {
				title: 'Sandbox-first',
				detail: 'Package is configured to run in a container sandbox.',
				tone: 'ok'
			};
		}
		return {
			title: 'Standard safety profile',
			detail: 'No elevated runtime request in package metadata.',
			tone: 'neutral'
		};
	}

	function enabledPermissions(plugin: PluginPermissionSummary): string[] {
		const entries = Object.entries(plugin.resolved_permissions);
		return entries
			.filter((entry): entry is [string, true] => entry[1] === true)
			.map(([name]) => name);
	}

	function installBlockers(): string[] {
		if (!preview) {
			return ['Loading install preview...'];
		}
		const blockers: string[] = [];
		if (preview.blocking_conflicts.length > 0) {
			blockers.push('Blocking conflicts exist.');
		}
		if (!adoptExisting && preview.conflicts.length > 0) {
			blockers.push('Conflicts exist with current config entries.');
		}
		if (preview.missing_dependencies.length > 0 && !allowMissingDependencies) {
			blockers.push('Required dependencies are missing.');
		}
		return blockers;
	}

	function canInstallNow(): boolean {
		return (
			!busyInstall &&
			!busyPreview &&
			!!preview &&
			installBlockers().length === 0
		);
	}

	function visibleManifestCountLabel(): string {
		const visible = filteredManifests();
		if (visible.length === catalog.manifests.length) {
			return `${catalog.manifests.length}`;
		}
		return `${visible.length} / ${catalog.manifests.length}`;
	}

	async function postConfigure(action: string, payload: Record<string, unknown>): Promise<unknown> {
		const response = await fetch('/api/configure', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action, payload })
		});
		const body = (await response.json()) as {
			ok?: boolean;
			data?: unknown;
			error?: string;
		};
		if (!response.ok || body.ok !== true) {
			throw new Error(body.error ?? `configure action '${action}' failed`);
		}
		return body.data;
	}

	async function refreshCatalog(showMessage: boolean = true) {
		busyRefresh = true;
		actionError = '';
		try {
			const response = await fetch('/api/configure?view=plugins');
			const body = (await response.json()) as {
				ok?: boolean;
				data?: PluginCatalogReport;
				error?: string;
			};
			if (!response.ok || body.ok !== true || !body.data) {
				throw new Error(body.error ?? 'failed to load plugin catalog');
			}
			catalog = body.data;
			if (showMessage) {
				actionMessage = 'Plugin catalog refreshed.';
			}
		} catch (error) {
			actionError = errorMessage(error);
		} finally {
			busyRefresh = false;
		}
	}

	async function loadPreview(manifestId: string) {
		busyPreview = true;
		previewError = '';
		try {
			const result = await postConfigure('plugin_preview', { plugin: manifestId });
			preview = result as PluginInstallPreview;
		} catch (error) {
			preview = null;
			previewError = errorMessage(error);
		} finally {
			busyPreview = false;
		}
	}

	async function installSelected() {
		const manifest = selectedManifest;
		if (!manifest) {
			return;
		}
		busyInstall = true;
		actionError = '';
		actionMessage = '';
		try {
			const result = (await postConfigure('plugin_install', {
				plugin: manifest.id,
				allowMissingDependencies,
				adoptExisting,
				skipInstallCommands: !runInstallCommands
			})) as PluginInstallResult;
			actionMessage = `Installed ${result.result.manifest_name}.`;
			await refreshCatalog(false);
			await loadPreview(manifest.id);
		} catch (error) {
			actionError = errorMessage(error);
		} finally {
			busyInstall = false;
		}
	}

	async function removeSelected() {
		const manifest = selectedManifest;
		if (!manifest) {
			return;
		}
		busyRemove = true;
		actionError = '';
		actionMessage = '';
		try {
			const result = (await postConfigure('plugin_remove', {
				plugin: manifest.id
			})) as PluginRemoveResult;
			actionMessage = `Removed ${result.result.manifest_id}.`;
			await refreshCatalog(false);
			if (selectedManifestId) {
				await loadPreview(selectedManifestId);
			}
		} catch (error) {
			actionError = errorMessage(error);
		} finally {
			busyRemove = false;
		}
	}
</script>

<div class="mx-auto max-w-6xl space-y-5">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Plugins</h1>
			<p class="mt-1 max-w-3xl text-sm subtle">
				Pick a plugin package, review its safety summary, and install it. Advanced technical
				details are available, but hidden by default.
			</p>
		</div>
		<button class="btn btn-neutral btn-sm" onclick={refreshCatalog} disabled={busyRefresh}>
			{busyRefresh ? 'Refreshing...' : 'Refresh'}
		</button>
	</div>

	{#if actionMessage}
		<div class="rounded-xl border border-[color-mix(in_srgb,var(--accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--accent-soft)_86%,transparent)] px-3 py-2 text-sm">
			{actionMessage}
		</div>
	{/if}
	{#if actionError}
		<div class="rounded-xl border border-[color-mix(in_srgb,var(--danger)_38%,transparent)] bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] px-3 py-2 text-sm text-[var(--danger)]">
			{actionError}
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-[1.05fr_1.6fr]">
		<section class="panel panel-strong p-4">
			<div class="space-y-3">
				<div class="flex items-center justify-between gap-2">
					<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--text-soft)]">
						Plugin Catalog
					</h2>
					<span class="badge badge-neutral">{visibleManifestCountLabel()}</span>
				</div>

				<input
					class="field"
					placeholder="Search plugins by name, id, or description"
					bind:value={searchTerm}
				/>

				<div class="tab-row">
					<button
						type="button"
						class="tab-btn"
						aria-current={filter === 'all' ? 'page' : undefined}
						onclick={() => (filter = 'all')}
					>
						All
					</button>
					<button
						type="button"
						class="tab-btn"
						aria-current={filter === 'available' ? 'page' : undefined}
						onclick={() => (filter = 'available')}
					>
						Not Installed
					</button>
					<button
						type="button"
						class="tab-btn"
						aria-current={filter === 'installed' ? 'page' : undefined}
						onclick={() => (filter = 'installed')}
					>
						Installed
					</button>
				</div>

				{#if filteredManifests().length === 0}
					<div class="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm subtle">
						No plugin packages match your filter.
					</div>
				{:else}
					<div class="space-y-2">
						{#each filteredManifests() as manifest (manifest.id)}
							{@const safety = quickSafety(manifest)}
							<button
								type="button"
								class={`w-full rounded-xl border p-3 text-left transition-colors ${
									selectedManifestId === manifest.id
										? 'border-[color-mix(in_srgb,var(--accent)_38%,var(--line))] bg-[color-mix(in_srgb,var(--accent-soft)_76%,transparent)]'
										: 'border-[var(--line)] bg-[color-mix(in_srgb,var(--surface-strong)_90%,transparent)]'
								}`}
								onclick={() => {
									selectedManifestId = manifest.id;
									actionMessage = '';
									actionError = '';
								}}
							>
								<div class="flex items-center justify-between gap-2">
									<p class="truncate text-sm font-semibold">{manifest.name}</p>
									<div class="flex shrink-0 items-center gap-1">
										<span class={`badge ${toneBadgeClass(safety.tone)} text-[10px]`}>{safety.title}</span>
										{#if manifest.installed}
											<span class="badge badge-ok text-[10px]">installed</span>
										{/if}
									</div>
								</div>
								<p class="mt-1 line-clamp-2 text-xs subtle">
									{manifest.description || 'No description provided.'}
								</p>
								<p class="mt-2 text-[11px] subtle">{countResources(manifest)}</p>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</section>

		<section class="panel panel-strong p-4">
			{#if !selectedManifest}
				<div class="rounded-lg border border-dashed border-[var(--line)] p-4 text-sm subtle">
					Select a plugin package from the left list.
				</div>
			{:else}
				{@const safety = selectedSafetySummary(selectedManifest, preview)}
				<div class="space-y-4">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div>
							<h2 class="text-xl font-semibold">{selectedManifest.name}</h2>
							<p class="mt-1 text-sm subtle">
								{selectedManifest.description || 'No description provided.'}
							</p>
							<p class="mono mt-2 text-xs subtle">{selectedManifest.id}</p>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<span class={`badge ${toneBadgeClass(safety.tone)}`}>{safety.title}</span>
							{#if selectedManifest.installed}
								<span class="badge badge-ok">Installed</span>
							{:else}
								<span class="badge badge-neutral">Not Installed</span>
							{/if}
						</div>
					</div>

					<div class="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-3">
						<p class="text-xs font-semibold uppercase tracking-wide subtle">Safety Summary</p>
						<p class="mt-1 text-sm">{safety.detail}</p>
						{#if preview && preview.warnings.length > 0}
							<p class="mt-2 text-xs tone-warning">Warnings: {preview.warnings.length}</p>
						{/if}
					</div>

					<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
						<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-2 text-xs">
							<div class="subtle">Plugin Units</div>
							<div class="mt-1 text-base font-semibold">{selectedManifest.plugin_count}</div>
						</div>
						<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-2 text-xs">
							<div class="subtle">Skills</div>
							<div class="mt-1 text-base font-semibold">{selectedManifest.skill_count}</div>
						</div>
						<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-2 text-xs">
							<div class="subtle">Services</div>
							<div class="mt-1 text-base font-semibold">{selectedManifest.service_count}</div>
						</div>
						<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-2 text-xs">
							<div class="subtle">Dependencies</div>
							<div class="mt-1 text-base font-semibold">{dependencyCount(selectedManifest)}</div>
						</div>
					</div>

					<div class="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-3">
						<p class="text-xs font-semibold uppercase tracking-wide subtle">Install</p>
						<p class="mt-1 text-sm subtle">
							Default install keeps dependency checks on and does not claim legacy entries unless you
							enable it.
						</p>
						<div class="mt-3 flex flex-wrap items-center gap-2">
							<button class="btn btn-primary btn-sm" onclick={installSelected} disabled={!canInstallNow()}>
								{busyInstall ? 'Installing...' : 'Install Plugin'}
							</button>
							<button
								class="btn btn-danger btn-sm"
								onclick={removeSelected}
								disabled={busyRemove || !selectedManifest.installed}
							>
								{busyRemove ? 'Removing...' : 'Remove Plugin'}
							</button>
						</div>
						{#if installBlockers().length > 0}
							<ul class="mt-3 space-y-1 text-xs tone-warning">
								{#each installBlockers() as item (item)}
									<li>{item}</li>
								{/each}
							</ul>
						{/if}

						<details class="mt-3 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3">
							<summary class="cursor-pointer text-sm font-medium">Advanced install options</summary>
							<div class="mt-3 space-y-2 text-sm">
								<label class="flex items-center gap-2 subtle">
									<input type="checkbox" bind:checked={allowMissingDependencies} />
									Allow missing dependencies
								</label>
								<label class="flex items-center gap-2 subtle">
									<input type="checkbox" bind:checked={adoptExisting} />
									Adopt legacy config entries
								</label>
								<label class="flex items-center gap-2 subtle">
									<input type="checkbox" bind:checked={runInstallCommands} />
									Run install commands
								</label>
							</div>
						</details>
					</div>

					{#if busyPreview}
						<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-3 text-sm subtle">
							Loading install preview...
						</div>
					{:else if previewError}
						<div class="rounded-lg border border-[color-mix(in_srgb,var(--danger)_38%,transparent)] bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] p-3 text-sm text-[var(--danger)]">
							{previewError}
						</div>
					{:else if preview}
						<details class="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-3">
							<summary class="cursor-pointer text-sm font-medium">Technical details (for builders and agents)</summary>
							<div class="mt-3 space-y-3 text-sm">
								{#if preview.warnings.length > 0}
									<div class="rounded-lg border border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] p-3">
										<p class="text-xs font-semibold uppercase tracking-wide text-[var(--warn)]">Warnings</p>
										<ul class="mt-1 space-y-1 text-xs">
											{#each preview.warnings as item (item)}
												<li>{item}</li>
											{/each}
										</ul>
									</div>
								{/if}

								{#if preview.blocking_conflicts.length > 0 || preview.adoptable_conflicts.length > 0}
									<div class="grid gap-2 sm:grid-cols-2">
										<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3">
											<p class="text-xs font-semibold uppercase tracking-wide subtle">Blocking Conflicts</p>
											{#if preview.blocking_conflicts.length === 0}
												<p class="mt-1 text-xs subtle">None</p>
											{:else}
												<ul class="mt-1 space-y-1 text-xs">
													{#each preview.blocking_conflicts as item (item)}
														<li>{item}</li>
													{/each}
												</ul>
											{/if}
										</div>
										<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3">
											<p class="text-xs font-semibold uppercase tracking-wide subtle">Adoptable Conflicts</p>
											{#if preview.adoptable_conflicts.length === 0}
												<p class="mt-1 text-xs subtle">None</p>
											{:else}
												<ul class="mt-1 space-y-1 text-xs">
													{#each preview.adoptable_conflicts as item (item)}
														<li>{item}</li>
													{/each}
												</ul>
											{/if}
										</div>
									</div>
								{/if}

								<div class="grid gap-2 sm:grid-cols-2">
									<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3">
										<p class="text-xs font-semibold uppercase tracking-wide subtle">Dependencies</p>
										<div class="mt-2 space-y-2 text-xs">
											<div>
												<p class="font-semibold subtle">Plugin Packages</p>
												<p>{selectedManifest.requires.manifests.length ? selectedManifest.requires.manifests.join(', ') : 'None'}</p>
											</div>
											<div>
												<p class="font-semibold subtle">Plugins</p>
												<p>{selectedManifest.requires.plugins.length ? selectedManifest.requires.plugins.join(', ') : 'None'}</p>
											</div>
											<div>
												<p class="font-semibold subtle">Services</p>
												<p>{selectedManifest.requires.services.length ? selectedManifest.requires.services.join(', ') : 'None'}</p>
											</div>
										</div>
									</div>

									<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3">
										<p class="text-xs font-semibold uppercase tracking-wide subtle">Install Commands</p>
										{#if preview.install_commands.length === 0}
											<p class="mt-1 text-xs subtle">None</p>
										{:else}
											<ul class="mt-2 space-y-1 text-xs">
												{#each preview.install_commands as cmd, idx (`${cmd.id}-${idx}`)}
													<li class="rounded border border-[var(--line)] bg-[var(--surface-subtle)] px-2 py-1">
														<div class="flex items-center gap-1">
															<span class="badge badge-neutral text-[10px]">{cmd.scope}</span>
															{#if cmd.dangerous}
																<span class="badge badge-danger text-[10px]">dangerous</span>
															{/if}
														</div>
														<p class="mono mt-1">{cmd.command}</p>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
								</div>

								<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-3">
									<div class="mb-2 flex items-center justify-between gap-2">
										<p class="text-xs font-semibold uppercase tracking-wide subtle">Plugin Permissions</p>
										<span class="badge badge-neutral">{preview.plugins.length}</span>
									</div>
									{#if preview.plugins.length === 0}
										<p class="text-xs subtle">No plugin entries in this package.</p>
									{:else}
										<div class="space-y-2">
											{#each preview.plugins as plugin (plugin.name)}
												<div class="rounded border border-[var(--line)] bg-[var(--surface-subtle)] p-2">
													<div class="flex flex-wrap items-center justify-between gap-2">
														<p class="text-sm font-semibold">{plugin.name}</p>
														<div class="flex flex-wrap gap-1">
															{#if plugin.host_only}
																<span class="badge badge-danger text-[10px]">host only</span>
															{/if}
															{#if plugin.managed_only}
																<span class="badge badge-neutral text-[10px]">managed only</span>
															{/if}
															{#each plugin.risk_flags as risk (risk)}
																<span class="badge badge-warn text-[10px]">{normalizeLabel(risk)}</span>
															{/each}
														</div>
													</div>
													<p class="mt-1 text-xs subtle">
														Permissions: {enabledPermissions(plugin).map(normalizeLabel).join(', ') || 'None'}
													</p>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							</div>
						</details>
					{/if}
				</div>
			{/if}
		</section>
	</div>

	<details class="panel p-4" open={catalog.parse_errors.length > 0}>
		<summary class="cursor-pointer text-sm font-semibold uppercase tracking-wide text-[var(--text-soft)]">
			System Details
		</summary>
		<div class="mt-3 space-y-4">
			<section>
				<h3 class="text-sm font-semibold">Catalog Parse Errors</h3>
				{#if catalog.parse_errors.length === 0}
					<p class="mt-1 text-xs subtle">No parse errors.</p>
				{:else}
					<ul class="mt-2 space-y-1 text-xs text-[var(--danger)]">
						{#each catalog.parse_errors as item (item)}
							<li>{item}</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section>
				<h3 class="text-sm font-semibold">Configured Plugins</h3>
				{#if catalog.configured_plugins.length === 0}
					<p class="mt-1 text-xs subtle">No active plugins are currently loaded.</p>
				{:else}
					<div class="mt-2 space-y-2">
						{#each catalog.configured_plugins as plugin (plugin.name)}
							<div class="rounded-lg border border-[var(--line)] bg-[var(--surface-subtle)] p-2">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<p class="text-sm font-semibold">{plugin.name}</p>
									<div class="flex flex-wrap gap-1">
										{#if plugin.manifest_owner}
											<span class="badge badge-ok text-[10px]">package:{plugin.manifest_owner}</span>
										{:else}
											<span class="badge badge-warn text-[10px]">legacy-config</span>
										{/if}
									</div>
								</div>
								<p class="mono mt-1 text-[11px] subtle">{plugin.command}</p>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section>
				<h3 class="text-sm font-semibold">Manifest Search Paths</h3>
				<ul class="mt-2 space-y-1">
					{#each catalog.manifest_dirs as dir (dir)}
						<li class="mono text-xs subtle">{dir}</li>
					{/each}
				</ul>
			</section>
		</div>
	</details>
</div>
