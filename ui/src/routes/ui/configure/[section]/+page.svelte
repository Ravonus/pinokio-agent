<script lang="ts">
	import { page } from '$app/state';
	import type {
		ConfigureDoctorReport,
		CredentialStatus,
		ManagerPolicyStatus,
		ManagedServiceStatus,
		PackageLedgerEventRecord,
		PackageLedgerScopeRecord,
		UiExtensionSurface
	} from '$lib/ui/manager';
	import type { PageData } from './$types';
	import InputField from '$lib/components/InputField.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { toast } from '$lib/components/Toast.svelte';

	type ConfigureSection = 'tasks' | 'extensions' | 'diagnostics' | 'database';

	let { data } = $props<{ data: PageData }>();
	let status = $state<CredentialStatus[]>([]);
	let doctor = $state<ConfigureDoctorReport>({ ok: false, credentials: [], profile_errors: [] });
	let managerPolicy = $state<ManagerPolicyStatus | null>(null);
	let surfaces = $state<UiExtensionSurface[]>([]);
	let services = $state<ManagedServiceStatus[]>([]);
	let busy = $state(false);
	let showExtensionModal = $state(false);
	let lastTaskResponse = $state('');
	let dbSql = $state(
		"SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"
	);
	let dbAction = $state<'read' | 'create' | 'update' | 'delete'>('read');
	let dbProfile = $state('codex');
	let dbConfirmWrite = $state(false);
	let dbTaskResponse = $state('');
	let memoryAction = $state<'read' | 'create' | 'update' | 'delete'>('create');
	let memoryProfile = $state('codex');
	let memoryTarget = $state(
		'{\n  "namespace": "namespace_plugin_chat_agent",\n  "key": "intro",\n  "content": "Chat agent initialized",\n  "tags": ["chat", "bootstrap"]\n}'
	);
	let memoryTaskResponse = $state('');
	let packageLedgerScopes = $state<PackageLedgerScopeRecord[]>([]);
	let packageLedgerEvents = $state<PackageLedgerEventRecord[]>([]);
	let packageLedgerSelectedScopeKey = $state('');
	let packageLedgerTaskResponse = $state('');

	const sectionParam = $derived(page.params.section ?? 'tasks');
	const activeSection = $derived<ConfigureSection>(
		sectionParam === 'extensions' ||
			sectionParam === 'diagnostics' ||
			sectionParam === 'database'
			? sectionParam
			: 'tasks'
	);
	const unsafeHostEnabled = $derived(
		managerPolicy?.policy.unsafe_host_communication_enabled === true
	);

	$effect(() => {
		status = data.status;
		doctor = data.doctor;
		managerPolicy = data.managerPolicy;
		surfaces = data.surfaces;
		services = data.services;
		packageLedgerScopes = Array.isArray(data.packageLedgerScopes)
			? (data.packageLedgerScopes as PackageLedgerScopeRecord[])
			: [];
	});

	async function refreshState() {
		const [statusRes, doctorRes, managerRes, surfacesRes, servicesRes, ledgerScopesRes] =
			await Promise.all([
			fetch('/api/configure?view=status'),
			fetch('/api/configure?view=doctor'),
			fetch('/api/configure?view=manager_policy'),
			fetch('/api/configure?view=surfaces'),
			fetch('/api/configure?view=services'),
			fetch('/api/configure?view=package_ledger_scopes')
		]);
		const [statusJson, doctorJson, managerJson, surfacesJson, servicesJson, ledgerScopesJson] =
			await Promise.all([
			statusRes.json(),
			doctorRes.json(),
			managerRes.json(),
			surfacesRes.json(),
			servicesRes.json(),
			ledgerScopesRes.json()
		]);
		if (!statusJson.ok) throw new Error(statusJson.error ?? 'failed to load status');
		if (!doctorJson.ok) throw new Error(doctorJson.error ?? 'failed to load doctor');
		if (!managerJson.ok) throw new Error(managerJson.error ?? 'failed to load manager policy');
		if (!surfacesJson.ok) throw new Error(surfacesJson.error ?? 'failed to load surfaces');
		if (!servicesJson.ok) throw new Error(servicesJson.error ?? 'failed to load services');
		if (!ledgerScopesJson.ok) {
			throw new Error(ledgerScopesJson.error ?? 'failed to load package ledger scopes');
		}
		status = statusJson.data as CredentialStatus[];
		doctor = doctorJson.data as ConfigureDoctorReport;
		managerPolicy = managerJson.data as ManagerPolicyStatus;
		surfaces = surfacesJson.data as UiExtensionSurface[];
		services = servicesJson.data as ManagedServiceStatus[];
		packageLedgerScopes = Array.isArray(ledgerScopesJson.data)
			? (ledgerScopesJson.data as PackageLedgerScopeRecord[])
			: [];
	}

	async function submit(action: string, payload: Record<string, unknown>) {
		busy = true;
		try {
			const response = await fetch('/api/configure', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, payload })
			});
			const body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `action failed (${response.status})`);
			}
			toast('Action completed', 'success');
			await refreshState();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			busy = false;
		}
	}

	function asString(fd: FormData, key: string): string {
		return String(fd.get(key) ?? '').trim();
	}

	async function onExtensionAddSubmit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const fd = new FormData(form);
		const orderValue = Number.parseInt(asString(fd, 'order'), 10);
		await submit('extension_add', {
			name: asString(fd, 'name'),
			kind: asString(fd, 'kind'),
			slot: asString(fd, 'slot'),
			title: asString(fd, 'title'),
			detail: asString(fd, 'detail'),
			route: asString(fd, 'route'),
			order: Number.isFinite(orderValue) ? orderValue : undefined,
			enabled: fd.get('enabled') !== null
		});
		form.reset();
		showExtensionModal = false;
	}

	async function removeExtension(extensionName: string) {
		await submit('extension_remove', { name: extensionName });
	}

	async function onTaskSubmit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const fd = new FormData(form);
		busy = true;
		try {
			const response = await fetch('/api/task', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						task: asString(fd, 'task'),
						resource: asString(fd, 'resource'),
						action: asString(fd, 'action').toLowerCase(),
						target: asString(fd, 'target'),
						runtime: asString(fd, 'runtime'),
						profile: asString(fd, 'profile'),
						image: asString(fd, 'image'),
						network: asString(fd, 'network')
					})
				});
			const body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `task failed (${response.status})`);
			}
			lastTaskResponse = JSON.stringify(body.report, null, 2);
			toast('Task completed', 'success');
			await refreshState();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			busy = false;
		}
	}

async function onManagerPolicySubmit(event: SubmitEvent) {
	event.preventDefault();
	const form = event.currentTarget as HTMLFormElement;
	const fd = new FormData(form);
	const socketBusDepthRaw = Number.parseInt(asString(fd, 'socketBusMaxChannelMessages'), 10);
	await submit('manager_policy_set', {
		childSpawnEnabled: fd.get('childSpawnEnabled') !== null,
		childSpawnContainerOnly: fd.get('childSpawnContainerOnly') !== null,
		unsafeHostCommunicationEnabled: fd.get('unsafeHostCommunicationEnabled') !== null,
		socketBusEnabled: fd.get('socketBusEnabled') !== null,
		socketBusContainerOnly: fd.get('socketBusContainerOnly') !== null,
		socketBusMaxChannelMessages: Number.isFinite(socketBusDepthRaw)
			? socketBusDepthRaw
			: undefined,
		containerPackageInstallsEnabled:
			fd.get('containerPackageInstallsEnabled') !== null
	});
}

	async function ensureService(name?: string) {
		const names = name ? [name] : [];
		await submit('service_ensure', { names });
	}

	function isDatabaseService(service: ManagedServiceStatus): boolean {
		if (service.name.toLowerCase().includes('postgres')) {
			return true;
		}
		return service.aliases.some((alias) => alias.toLowerCase().includes('postgres'));
	}

	function surfaceSlot(surface: UiExtensionSurface): 'navigation' | 'settings' | 'page' {
		const slot = (surface.slot ?? 'settings').toLowerCase();
		return slot === 'navigation' || slot === 'page' ? slot : 'settings';
	}

	function useDatabaseTemplate(kind: 'list_tables' | 'create_notes' | 'list_notes') {
		if (kind === 'list_tables') {
			dbAction = 'read';
			dbConfirmWrite = false;
			dbSql =
				"SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;";
			return;
		}
		if (kind === 'create_notes') {
			dbAction = 'create';
			dbConfirmWrite = true;
			dbSql = 'CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, body TEXT NOT NULL);';
			return;
		}
		dbAction = 'read';
		dbConfirmWrite = false;
		dbSql = "SELECT * FROM notes ORDER BY id DESC LIMIT 50;";
	}

	async function runDatabaseTask(event: SubmitEvent) {
		event.preventDefault();
		const sql = dbSql.trim();
		if (!sql) {
			toast('SQL is required', 'danger');
			return;
		}
		if (dbAction !== 'read' && !dbConfirmWrite) {
			toast('Enable write confirmation for create/update/delete actions', 'danger');
			return;
		}

		const target =
			dbAction === 'read' ? sql : JSON.stringify({ confirm_write: true, sql });
		const routedTarget = JSON.stringify({
			delegate_resource: 'plugin:postgres_agent',
			delegate_target: target
		});

		busy = true;
		try {
			const response = await fetch('/api/task', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					task: `database ${dbAction} query`,
					resource: 'plugin:db_router_agent',
					action: dbAction,
					target: routedTarget,
					profile: dbProfile
				})
			});
			const body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `database task failed (${response.status})`);
			}
			dbTaskResponse = JSON.stringify(body.report, null, 2);
			toast('Database query executed', 'success');
			await refreshState();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			busy = false;
		}
	}

	function useMemoryTemplate(kind: 'remember' | 'search' | 'grant' | 'set_policy') {
		if (kind === 'remember') {
			memoryAction = 'create';
			memoryTarget =
				'{\n  "namespace": "namespace_plugin_chat_agent",\n  "key": "topic_rust_lifetimes",\n  "content": "User wants a simple explanation for Rust lifetimes.",\n  "metadata": { "source": "chat" },\n  "tags": ["rust", "lifetimes"]\n}';
			return;
		}
		if (kind === 'search') {
			memoryAction = 'read';
			memoryTarget =
				'{\n  "query": "rust lifetimes",\n  "limit": 20\n}';
			return;
		}
		if (kind === 'grant') {
			memoryAction = 'create';
			memoryTarget =
				'{\n  "namespace": "namespace_plugin_chat_agent",\n  "op": "grant",\n  "target_actor": "plugin:chat_agent",\n  "permissions": {\n    "read": true,\n    "create": false,\n    "update": false,\n    "delete": false,\n    "admin": false\n  }\n}';
			return;
		}
		memoryAction = 'update';
		memoryTarget =
			'{\n  "namespace": "namespace_plugin_chat_agent",\n  "op": "set_policy",\n  "read_policy": "all",\n  "write_policy": "owner"\n}';
	}

	async function runMemoryTask(event: SubmitEvent) {
		event.preventDefault();
		const payload = memoryTarget.trim();
		if (!payload) {
			toast('Memory target JSON is required', 'danger');
			return;
		}
		let parsedPayload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(payload);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('memory target must be a JSON object');
			}
			parsedPayload = parsed as Record<string, unknown>;
		} catch {
			toast('Memory target must be valid JSON', 'danger');
			return;
		}
		const routedTarget = JSON.stringify({
			delegate_resource: 'plugin:memory_agent',
			delegate_target: parsedPayload
		});

		busy = true;
		try {
			const response = await fetch('/api/task', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					task: `memory ${memoryAction} operation`,
					resource: 'plugin:db_router_agent',
					action: memoryAction,
					target: routedTarget,
					profile: memoryProfile
				})
			});
			const body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `memory task failed (${response.status})`);
			}
			memoryTaskResponse = JSON.stringify(body.report, null, 2);
			toast('Memory operation executed', 'success');
			await refreshState();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			busy = false;
		}
	}

	function formatPackages(packages: string[]): string {
		if (!Array.isArray(packages) || packages.length === 0) {
			return 'none';
		}
		if (packages.length <= 4) {
			return packages.join(', ');
		}
		return `${packages.slice(0, 4).join(', ')} +${packages.length - 4} more`;
	}

	async function loadPackageLedgerEvents(scopeKey?: string) {
		const payload: Record<string, unknown> = {
			limit: 80
		};
		if (scopeKey) {
			payload.scopeKey = scopeKey;
		}
		const response = await fetch('/api/configure', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				action: 'package_ledger_events',
				payload
			})
		});
		const body = await response.json();
		if (!response.ok || !body.ok) {
			throw new Error(body.error ?? `failed to load package ledger events (${response.status})`);
		}
		packageLedgerEvents = Array.isArray(body.data)
			? (body.data as PackageLedgerEventRecord[])
			: [];
		packageLedgerSelectedScopeKey = scopeKey ?? '';
	}

	function explorerPackageScriptTarget(scope: PackageLedgerScopeRecord, op: 'ensure_packages' | 'remove_packages') {
		return {
			scope_dir: scope.scope_dir,
			desired_action: 'update',
			operation: 'run_script',
			require_handoff_matches: false,
			script: {
				require_handoff_matches: false,
				steps: [
					{
						op,
						packages: scope.packages
					}
				]
			}
		};
	}

	async function runScopePackageAction(
		scope: PackageLedgerScopeRecord,
		op: 'ensure_packages' | 'remove_packages',
		label: string
	) {
		if (!scope.packages || scope.packages.length === 0) {
			toast('This scope has no tracked packages', 'danger');
			return;
		}
		busy = true;
		try {
			const response = await fetch('/api/task', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					task: `${label}: ${scope.scope_key}`,
					resource: 'plugin:explorer_agent',
					action: 'update',
					target: JSON.stringify(explorerPackageScriptTarget(scope, op)),
					profile: 'codex'
				})
			});
			const body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `package action failed (${response.status})`);
			}
			packageLedgerTaskResponse = JSON.stringify(body.report, null, 2);
			toast('Package action completed', 'success');
			await refreshState();
			await loadPackageLedgerEvents(scope.scope_key);
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			busy = false;
		}
	}

	async function restorePackagesForScope(scope: PackageLedgerScopeRecord) {
		await runScopePackageAction(scope, 'ensure_packages', 'restore packages');
	}

	async function removePackagesForScope(scope: PackageLedgerScopeRecord) {
		await runScopePackageAction(scope, 'remove_packages', 'remove packages');
	}
</script>

<section class="surface p-5 md:p-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold">
				{activeSection === 'tasks'
					? 'Task Runner'
					: activeSection === 'extensions'
						? 'Extensions'
						: activeSection === 'database'
							? 'Database'
							: 'Diagnostics'}
			</h1>
			<p class="subtle mt-1 text-sm">
				{activeSection === 'tasks'
					? 'Send tasks directly to the manager and inspect results.'
					: activeSection === 'extensions'
						? 'Register and manage extension surfaces.'
					: activeSection === 'database'
						? 'Start services, run PostgreSQL queries, and manage memory namespaces from the app.'
						: 'Validate profiles and inspect credential inventory.'}
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<button class="btn btn-neutral" disabled={busy} onclick={() => refreshState()}>
				{#if busy}<LoadingSpinner size="sm" />{:else}Refresh{/if}
			</button>
			{#if activeSection === 'database'}
				<button
					class="btn btn-neutral"
					disabled={busy}
					onclick={() => ensureService()}
				>
					Ensure Services
				</button>
			{/if}
			{#if activeSection === 'diagnostics'}
				<button
					class="btn btn-soft"
					disabled={busy}
					onclick={() => submit('doctor', {})}
				>
					Run Doctor
				</button>
			{/if}
		</div>
	</div>
	{#if busy}
		<div class="mt-4">
			<LoadingSpinner label="Processing..." />
		</div>
	{/if}
</section>

{#if activeSection === 'tasks'}
	<div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_1fr]">
		<div class="space-y-4">
			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">Manager Security Policy</h2>
				<p class="subtle mt-1 text-sm">
					Unsafe host access is disabled by default and must be explicitly enabled here.
				</p>
				<form class="mt-4 space-y-3" onsubmit={onManagerPolicySubmit}>
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name="childSpawnEnabled"
							checked={managerPolicy?.policy.child_spawn_enabled === true}
						/>
						Child spawn enabled
					</label>
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name="childSpawnContainerOnly"
							checked={managerPolicy?.policy.child_spawn_container_only === true}
						/>
						Container-only child spawning (recommended)
					</label>
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name="unsafeHostCommunicationEnabled"
							checked={managerPolicy?.policy.unsafe_host_communication_enabled === true}
						/>
						Allow container-to-unsafe-host communication
					</label>
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name="socketBusEnabled"
							checked={managerPolicy?.policy.socket_bus_enabled !== false}
						/>
						Enable manager socket bus
					</label>
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name="socketBusContainerOnly"
							checked={managerPolicy?.policy.socket_bus_container_only !== false}
						/>
						Socket bus container-only (recommended)
					</label>
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name="containerPackageInstallsEnabled"
							checked={managerPolicy?.policy.container_package_installs_enabled === true}
						/>
						Allow container package installs (apt/apk/dnf/yum)
					</label>
					<label class="block space-y-1.5">
						<span class="text-sm font-medium">Socket channel max messages</span>
						<input
							class="field"
							type="number"
							name="socketBusMaxChannelMessages"
							min="16"
							max="4096"
							value={managerPolicy?.policy.socket_bus_max_channel_messages ?? 256}
						/>
					</label>
					<p class="subtle text-xs">
						Config file: <span class="mono">{managerPolicy?.config_path ?? 'unknown'}</span>
					</p>
					<button class="btn btn-primary" disabled={busy}>Save Policy</button>
				</form>
			</article>

			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">Run Task</h2>
				<p class="subtle mt-1 text-sm">Send a task to the manager API and inspect the report.</p>

				<form class="mt-4 space-y-4" onsubmit={onTaskSubmit}>
					<InputField
						name="task"
						label="Task summary"
						placeholder="Generate a configuration page for API keys"
						required={true}
						help="Describe what the agent should do"
					/>

					<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
						<InputField
							name="resource"
							label="Resource"
							placeholder="plugin:chat_agent | web | filesystem"
							required={true}
							help="Target resource type"
						/>
						<label class="block space-y-1.5">
							<span class="flex items-center gap-1.5">
								<span class="text-sm font-medium">Action</span>
							</span>
							<select class="field" name="action">
								<option value="read">read</option>
								<option value="create">create</option>
								<option value="update">update</option>
								<option value="delete">delete</option>
							</select>
						</label>
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Runtime</span>
							<select class="field" name="runtime">
								<option value="container" selected>container (sandbox)</option>
								{#if unsafeHostEnabled}
									<option value="unsafe_host">unsafe_host (dangerous)</option>
								{/if}
							</select>
							<p class="subtle text-xs">
								{#if unsafeHostEnabled}
									Host runtime is dangerous. Use it only when container runtime is blocked.
								{:else}
									Unsafe host runtime is currently disabled by manager policy.
								{/if}
							</p>
						</label>
						<InputField
							name="target"
							label="Target"
							placeholder="path, endpoint, id"
							help="Optional target identifier"
						/>
						<InputField
							name="profile"
							label="LLM Profile"
							placeholder="default"
							help="Optional profile override"
						/>
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Container Network</span>
							<select class="field" name="network">
								<option value="managed" selected>managed</option>
								<option value="host">host</option>
								<option value="bridge">bridge</option>
							</select>
							<p class="subtle text-xs">
								Use host only if managed network has outbound issues in Docker.
							</p>
						</label>
					</div>

					<InputField
						name="image"
						label="Container image"
						placeholder="ghcr.io/..."
						help="Optional container image for isolated execution"
					/>

					<div class="flex flex-wrap gap-2">
						<button class="btn btn-primary" disabled={busy}>Run Task</button>
						<a class="btn btn-neutral" href="/ui/apps">View Published Pages</a>
					</div>
				</form>
			</article>
		</div>

		<div class="space-y-4">
			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">Task Output</h2>
				{#if lastTaskResponse}
					<div class="code-shell mt-3">
						<pre
							class="mono overflow-x-auto p-3 text-xs leading-relaxed"><code>{lastTaskResponse}</code></pre>
					</div>
				{:else}
					<p class="subtle mt-3 text-sm">Run a task to see the output here.</p>
				{/if}
			</article>

			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">Tips</h2>
				<ul class="subtle mt-3 list-disc space-y-1 pl-5 text-sm">
					<li>
						Use <span class="mono">plugin:chat_agent</span> +
						<span class="mono">read</span> for one-shot chat replies.
					</li>
					<li>
						Use <span class="mono">plugin:chat_agent</span> +
						<span class="mono">create</span> to spawn a chat worker.
					</li>
					<li>Keep task summaries explicit about expected output format.</li>
					<li>
						Use <span class="mono">plugin:db_router_agent</span> to route DB and memory
						actions through role-scoped agents.
					</li>
					<li>
						Generated pages appear in <a href="/ui/apps">Agent Pages</a> after create/update
						tasks.
					</li>
				</ul>
			</article>
		</div>
	</div>
{/if}

{#if activeSection === 'extensions'}
	{@const navSurfaces = surfaces.filter((surface) => surfaceSlot(surface) === 'navigation')}
	{@const settingsSurfaces = surfaces.filter((surface) => surfaceSlot(surface) === 'settings')}
	{@const pageSurfaces = surfaces.filter((surface) => surfaceSlot(surface) === 'page')}

	<Modal bind:open={showExtensionModal} title="Add Extension">
		<p class="subtle mb-3 text-sm">
			Register routes that extend navigation, configure settings, or custom pages.
		</p>
		<form class="space-y-3" onsubmit={onExtensionAddSubmit}>
			<InputField name="name" label="Name" placeholder="my-extension" required={true} />
			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Kind</span>
				<select class="field" name="kind">
					<option value="core">core</option>
					<option value="plugins">plugins</option>
					<option value="agents">agents</option>
					<option value="systems" selected>systems</option>
				</select>
			</label>
			<label class="block space-y-1.5">
				<span class="text-sm font-medium">Slot</span>
				<select class="field" name="slot">
					<option value="settings" selected>settings</option>
					<option value="navigation">navigation</option>
					<option value="page">page</option>
				</select>
			</label>
			<InputField name="title" label="Title" placeholder="Optional display title" />
			<InputField name="detail" label="Detail" placeholder="Optional description" />
			<InputField
				name="route"
				label="Route"
				value="/ui/configure"
				help="Absolute app path (example: /ui/chat)"
			/>
			<InputField
				name="order"
				label="Order"
				value="100"
				help="Lower numbers appear first"
			/>
			<label
				class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
			>
				<input type="checkbox" name="enabled" checked />
				Enabled
			</label>
			<div class="flex justify-end gap-2">
				<button type="button" class="btn btn-neutral" onclick={() => (showExtensionModal = false)}>Cancel</button>
				<button class="btn btn-primary" disabled={busy}>Register</button>
			</div>
		</form>
	</Modal>

	<div class="mt-4">
		<div class="mb-4 flex items-center justify-between gap-2">
			<div></div>
			<button class="btn btn-primary btn-sm" onclick={() => (showExtensionModal = true)} disabled={busy}>
				+ Add Extension
			</button>
		</div>

		<article class="surface p-4 md:p-5">
			<h2 class="text-lg font-semibold">Registered Surfaces</h2>
			<p class="subtle mt-1 text-sm">
				Extensions are grouped by where they appear in the app UI.
			</p>

			<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
				<section class="surface-subtle rounded-xl border border-[var(--line)] p-3">
					<header class="mb-2 flex items-center justify-between gap-2">
						<h3 class="font-semibold">Navigation</h3>
						<span class="badge badge-neutral">{navSurfaces.length}</span>
					</header>
					{#if navSurfaces.length === 0}
						<p class="subtle text-sm">No navigation extensions.</p>
					{:else}
						<div class="space-y-2">
							{#each navSurfaces as surface}
								<div class="rounded-lg border border-[var(--line)] p-2">
									<p class="text-sm font-medium">{surface.title ?? surface.name}</p>
									<p class="mono subtle mt-1 text-xs">{surface.route ?? 'no route'}</p>
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<section class="surface-subtle rounded-xl border border-[var(--line)] p-3">
					<header class="mb-2 flex items-center justify-between gap-2">
						<h3 class="font-semibold">Settings</h3>
						<span class="badge badge-neutral">{settingsSurfaces.length}</span>
					</header>
					{#if settingsSurfaces.length === 0}
						<p class="subtle text-sm">No settings extensions.</p>
					{:else}
						<div class="space-y-2">
							{#each settingsSurfaces as surface}
								<div class="rounded-lg border border-[var(--line)] p-2">
									<p class="text-sm font-medium">{surface.title ?? surface.name}</p>
									<p class="mono subtle mt-1 text-xs">{surface.route ?? 'no route'}</p>
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<section class="surface-subtle rounded-xl border border-[var(--line)] p-3">
					<header class="mb-2 flex items-center justify-between gap-2">
						<h3 class="font-semibold">Pages</h3>
						<span class="badge badge-neutral">{pageSurfaces.length}</span>
					</header>
					{#if pageSurfaces.length === 0}
						<p class="subtle text-sm">No page extensions.</p>
					{:else}
						<div class="space-y-2">
							{#each pageSurfaces as surface}
								<div class="rounded-lg border border-[var(--line)] p-2">
									<p class="text-sm font-medium">{surface.title ?? surface.name}</p>
									<p class="mono subtle mt-1 text-xs">{surface.route ?? 'no route'}</p>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			</div>

			<div class="mt-4 space-y-2">
				{#if surfaces.length === 0}
					<EmptyState
						title="No extension surfaces"
						detail="Register an extension to see it listed here."
					/>
				{:else}
					{#each surfaces as surface}
						<div class="surface-subtle rounded-lg border border-[var(--line)] p-3">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="font-semibold">{surface.title ?? surface.name}</p>
								<div class="flex flex-wrap items-center gap-1">
									<span class="badge badge-neutral">{surfaceSlot(surface)}</span>
									<span class="badge badge-neutral">
										{surface.enabled === false ? 'disabled' : 'enabled'}
									</span>
								</div>
							</div>
							<p class="mono subtle mt-1 text-xs">
								{surface.kind} &middot; order={surface.order ?? 100} &middot; {surface.source ?? 'unknown'}
							</p>
							<p class="subtle mt-1 text-sm">{surface.detail}</p>
							<div class="mt-2 flex flex-wrap items-center gap-2">
								<p class="mono subtle text-xs">route: {surface.route ?? 'not set'}</p>
								{#if surface.route}
									<a class="btn btn-neutral btn-sm" href={surface.route}>Open</a>
								{/if}
								<button
									class="btn btn-danger btn-sm"
									onclick={() => removeExtension(surface.name)}
									disabled={busy}
								>
									Remove
								</button>
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</article>
	</div>
{/if}

{#if activeSection === 'database'}
	{@const dbServices = services.filter(isDatabaseService)}
	<div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[420px_1fr]">
		<article class="surface p-4 md:p-5">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h2 class="text-lg font-semibold">Postgres Service</h2>
				<button class="btn btn-neutral btn-sm" disabled={busy} onclick={() => ensureService()}>
					Ensure
				</button>
			</div>
				<p class="subtle mt-1 text-sm">
					The database service runs as a managed container and is exposed to
					<span class="mono">plugin:db_router_agent</span> plus underlying DB plugins.
				</p>

			<div class="mt-3 space-y-2">
				{#if dbServices.length === 0}
					<EmptyState
						title="No database services"
						detail="Add a postgres service under orchestrator.services in your manager config."
					/>
				{:else}
					{#each dbServices as service}
						<div class="surface-subtle rounded-lg border border-[var(--line)] p-3">
							<div class="flex items-center justify-between gap-2">
								<p class="mono text-sm">{service.name}</p>
								<span class="badge badge-neutral">
									{service.running ? 'running' : service.exists ? 'stopped' : 'missing'}
								</span>
							</div>
							<p class="mono subtle mt-1 text-xs">{service.image}</p>
							<p class="subtle mt-1 text-xs">
								{service.host_ports.join(', ') || 'no published host port'}
							</p>
							<div class="mt-2">
								<button
									class="btn btn-neutral btn-sm"
									disabled={busy || service.enabled === false}
									onclick={() => ensureService(service.name)}
								>
									Ensure {service.name}
								</button>
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</article>

		<div class="space-y-4">
			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">SQL Runner</h2>
				<p class="subtle mt-1 text-sm">
					Queries route through <span class="mono">plugin:db_router_agent</span> to
					<span class="mono">plugin:db_read_agent</span> /
					<span class="mono">plugin:db_write_agent</span>, then delegate to
					<span class="mono">plugin:postgres_agent</span>.
				</p>

				<form class="mt-4 space-y-3" onsubmit={runDatabaseTask}>
					<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Action</span>
							<select class="field" bind:value={dbAction}>
								<option value="read">read</option>
								<option value="create">create</option>
								<option value="update">update</option>
								<option value="delete">delete</option>
							</select>
						</label>
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Profile</span>
							<input class="field" bind:value={dbProfile} placeholder="codex" />
						</label>
					</div>

					<label class="block space-y-1.5">
						<span class="text-sm font-medium">SQL</span>
						<textarea class="field min-h-44 w-full" bind:value={dbSql} required></textarea>
					</label>

					{#if dbAction !== 'read'}
						<label
							class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
						>
							<input type="checkbox" bind:checked={dbConfirmWrite} />
							I confirm this write query can mutate data.
						</label>
					{/if}

					<div class="flex flex-wrap gap-2">
						<button
							class="btn btn-primary"
							disabled={busy || (dbAction !== 'read' && !dbConfirmWrite)}
						>
							Run SQL
						</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useDatabaseTemplate('list_tables')}
						>
							List Tables
						</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useDatabaseTemplate('create_notes')}
						>
							Create Notes Table
						</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useDatabaseTemplate('list_notes')}
						>
							Read Notes
						</button>
					</div>
				</form>

				<article class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<h3 class="text-sm font-semibold">Result</h3>
					{#if dbTaskResponse}
						<div class="code-shell mt-2">
							<pre
								class="mono overflow-x-auto p-3 text-xs leading-relaxed"><code>{dbTaskResponse}</code></pre>
						</div>
					{:else}
						<p class="subtle mt-2 text-sm">Run a query to inspect the task report here.</p>
					{/if}
				</article>
			</article>

			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">Memory Runner</h2>
				<p class="subtle mt-1 text-sm">
					Permissioned memory namespace operations via
					<span class="mono">plugin:db_router_agent</span> delegated to
					<span class="mono">plugin:memory_agent</span>.
				</p>

				<form class="mt-4 space-y-3" onsubmit={runMemoryTask}>
					<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Action</span>
							<select class="field" bind:value={memoryAction}>
								<option value="create">create</option>
								<option value="read">read</option>
								<option value="update">update</option>
								<option value="delete">delete</option>
							</select>
						</label>
						<label class="block space-y-1.5">
							<span class="text-sm font-medium">Profile</span>
							<input class="field" bind:value={memoryProfile} placeholder="codex" />
						</label>
					</div>

					<label class="block space-y-1.5">
						<span class="text-sm font-medium">Target JSON</span>
						<textarea class="field min-h-44 w-full" bind:value={memoryTarget} required></textarea>
					</label>

					<div class="flex flex-wrap gap-2">
						<button class="btn btn-primary" disabled={busy}>Run Memory Operation</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useMemoryTemplate('remember')}
						>
							Template: Remember
						</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useMemoryTemplate('search')}
						>
							Template: Search
						</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useMemoryTemplate('grant')}
						>
							Template: Grant
						</button>
						<button
							type="button"
							class="btn btn-neutral"
							disabled={busy}
							onclick={() => useMemoryTemplate('set_policy')}
						>
							Template: Policy
						</button>
					</div>
				</form>

				<article class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<h3 class="text-sm font-semibold">Result</h3>
					{#if memoryTaskResponse}
						<div class="code-shell mt-2">
							<pre
								class="mono overflow-x-auto p-3 text-xs leading-relaxed"><code>{memoryTaskResponse}</code></pre>
						</div>
					{:else}
						<p class="subtle mt-2 text-sm">Run a memory operation to inspect output.</p>
					{/if}
				</article>
			</article>

			<article class="surface p-4 md:p-5">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-lg font-semibold">Package Ledger (Postgres)</h2>
					<div class="flex gap-2">
						<button
							class="btn btn-neutral btn-sm"
							disabled={busy}
							onclick={() => loadPackageLedgerEvents()}
						>
							View Recent Events
						</button>
					</div>
				</div>
				<p class="subtle mt-1 text-sm">
					Automatic package install/remove tracking per scope, backed by Postgres.
				</p>

				{#if packageLedgerScopes.length === 0}
					<div class="callout callout-tip mt-3">
						<p class="text-sm">
							No package ledger scopes yet. Run package install/remove script steps first.
						</p>
					</div>
				{:else}
					<div class="mt-3 space-y-2">
						{#each packageLedgerScopes.slice(0, 20) as scope}
							<div class="surface-subtle rounded-lg border border-[var(--line)] p-3">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<p class="mono text-xs">{scope.scope_key}</p>
									<span class="badge badge-neutral">{scope.last_action}</span>
								</div>
								<p class="mono subtle mt-1 text-xs">{scope.scope_dir}</p>
								<p class="subtle mt-1 text-xs">packages: {formatPackages(scope.packages)}</p>
								<p class="subtle mt-1 text-xs">
									updated: {scope.updated_at} &middot; manager: {scope.manager}
								</p>
								<div class="mt-2 flex flex-wrap gap-2">
									<button
										class="btn btn-primary btn-sm"
										disabled={busy || scope.packages.length === 0}
										onclick={() => restorePackagesForScope(scope)}
									>
										Restore Scope Packages
									</button>
									<button
										class="btn btn-danger btn-sm"
										disabled={busy || scope.packages.length === 0}
										onclick={() => removePackagesForScope(scope)}
									>
										Remove Scope Packages
									</button>
									<button
										class="btn btn-neutral btn-sm"
										disabled={busy}
										onclick={() => loadPackageLedgerEvents(scope.scope_key)}
									>
										View Events
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<article class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<h3 class="text-sm font-semibold">Ledger Events</h3>
					{#if packageLedgerEvents.length > 0}
						<div class="mt-2 space-y-2">
							{#if packageLedgerSelectedScopeKey}
								<p class="mono subtle text-xs">
									filter: {packageLedgerSelectedScopeKey}
								</p>
							{/if}
							{#each packageLedgerEvents.slice(0, 25) as evt}
								<div class="rounded-lg border border-[var(--line)] p-2">
									<p class="subtle text-xs">
										{evt.created_at} &middot; {evt.action} &middot; {evt.applied ? 'applied' : 'dry run'}
									</p>
									<p class="mono mt-1 text-xs">{evt.scope_key}</p>
									<p class="subtle mt-1 text-xs">{formatPackages(evt.packages)}</p>
								</div>
							{/each}
						</div>
					{:else}
						<p class="subtle mt-2 text-sm">No package ledger events loaded.</p>
					{/if}
				</article>

				<article class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<h3 class="text-sm font-semibold">Last Package Task Report</h3>
					{#if packageLedgerTaskResponse}
						<div class="code-shell mt-2">
							<pre
								class="mono overflow-x-auto p-3 text-xs leading-relaxed"><code>{packageLedgerTaskResponse}</code></pre>
						</div>
					{:else}
						<p class="subtle mt-2 text-sm">Run restore/remove to inspect report output.</p>
					{/if}
				</article>
			</article>
		</div>
	</div>
{/if}

{#if activeSection === 'diagnostics'}
	{@const hasWorkingCredential = status.some((s) => s.token_present || s.mode === 'oauth_cli')}
	{@const totalProfiles = (doctor.credentials?.length ?? 0) + doctor.profile_errors.length}
	{@const workingProfiles = totalProfiles - doctor.profile_errors.length}
	<div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
		<article class="surface p-4 md:p-5">
			<h2 class="text-lg font-semibold">Doctor Findings</h2>
			<p class="subtle mt-1 text-sm">
				Profiles validated against credentials and API layers.
			</p>
			{#if doctor.profile_errors.length === 0}
				<div class="callout callout-tip mt-3">
					<p class="text-sm">All profiles are healthy. Everything looks good.</p>
				</div>
			{:else if hasWorkingCredential}
				<div class="callout callout-tip mt-3">
					<p class="text-sm font-medium">
						System is operational &mdash; at least one LLM provider is working.
					</p>
					<p class="mt-1 text-sm opacity-80">
						The issues below are for additional providers that aren't configured yet.
						These are optional unless you want failover support.
					</p>
				</div>
				<div class="mt-3 space-y-2">
					{#each doctor.profile_errors as finding}
						<div class="callout callout-warning">
							<p class="text-sm">{finding}</p>
						</div>
					{/each}
				</div>
			{:else}
				<div class="callout callout-danger mt-3">
					<p class="text-sm font-medium">
						No working LLM providers found. Connect at least one provider in Credentials.
					</p>
				</div>
				<div class="mt-3 space-y-2">
					{#each doctor.profile_errors as finding}
						<div class="callout callout-danger">
							<p class="text-sm">{finding}</p>
						</div>
					{/each}
				</div>
			{/if}
		</article>

			<article class="surface p-4 md:p-5">
				<h2 class="text-lg font-semibold">Credential Inventory</h2>
				<div class="mt-3 overflow-x-auto rounded-xl border border-[var(--line)]">
					<table class="min-w-full border-collapse">
						<thead>
							<tr class="surface-subtle border-b border-[var(--line)]">
								<th class="subtle px-3 py-2 text-left text-xs uppercase tracking-wide">
									Name
								</th>
								<th class="subtle px-3 py-2 text-left text-xs uppercase tracking-wide">
									Provider
								</th>
								<th class="subtle px-3 py-2 text-left text-xs uppercase tracking-wide">
									Mode
								</th>
								<th class="subtle px-3 py-2 text-left text-xs uppercase tracking-wide">
									Token
								</th>
							</tr>
						</thead>
						<tbody>
							{#if status.length === 0}
								<tr>
									<td class="subtle px-3 py-3" colspan="4">No credentials found.</td>
								</tr>
							{:else}
								{#each status as item}
									<tr class="border-b border-[var(--line)] last:border-b-0">
										<td class="mono px-3 py-2 text-sm">{item.name}</td>
										<td class="px-3 py-2 text-sm">{item.provider}</td>
										<td class="px-3 py-2 text-sm">{item.mode}</td>
										<td class="px-3 py-2 text-sm">
											{item.token_present ? 'present' : 'missing'}
										</td>
									</tr>
								{/each}
							{/if}
						</tbody>
					</table>
				</div>
			</article>

		</div>
{/if}
