<script lang="ts">
	import type { SkillSummary } from '$lib/ui/manager';
	import type { PageData } from './$types';
	import Modal from '$lib/components/Modal.svelte';
	import { toast } from '$lib/components/Toast.svelte';

	let { data } = $props<{ data: PageData }>();
	let skills = $state<SkillSummary[]>([]);
	let pluginNames = $state<string[]>([]);
	let busy = $state(false);
	let showAddModal = $state(false);
	let modalError = $state('');

	let name = $state('');
	let description = $state('');
	let path = $state('');
	let installCommand = $state('');
	let pluginTargets = $state('');
	let resourceTargets = $state('');
	let agentTargets = $state('');
	let actionTargets = $state('');
	let tags = $state('');
	let enabled = $state(true);
	let runInstall = $state(false);

	$effect(() => {
		skills = data.skills ?? [];
		pluginNames = data.pluginNames ?? [];
	});

	function parseCsv(value: string): string[] {
		return value
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	function errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	function resetForm() {
		name = '';
		description = '';
		path = '';
		installCommand = '';
		pluginTargets = '';
		resourceTargets = '';
		agentTargets = '';
		actionTargets = '';
		tags = '';
		enabled = true;
		runInstall = false;
		modalError = '';
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

	async function refreshSkills() {
		busy = true;
		try {
			const response = await fetch('/api/configure?view=skills');
			const body = (await response.json()) as {
				ok?: boolean;
				data?: SkillSummary[];
				error?: string;
			};
			if (!response.ok || body.ok !== true || !body.data) {
				throw new Error(body.error ?? 'failed to load skills');
			}
			skills = body.data;
			toast('Skills refreshed', 'success');
		} catch (err) {
			toast(errorMessage(err), 'danger');
		} finally {
			busy = false;
		}
	}

	async function addSkill() {
		if (!name.trim()) {
			modalError = 'Skill name is required.';
			return;
		}
		busy = true;
		modalError = '';
		try {
			const savedName = name.trim();
			await postConfigure('skill_add', {
				name: savedName,
				description,
				path,
				installCommand,
				plugins: parseCsv(pluginTargets),
				resources: parseCsv(resourceTargets),
				agents: parseCsv(agentTargets),
				actions: parseCsv(actionTargets),
				tags: parseCsv(tags),
				enabled,
				runInstall
			});
			showAddModal = false;
			resetForm();
			toast(`Skill '${savedName}' saved`, 'success');
			// silent refresh
			const response = await fetch('/api/configure?view=skills');
			const body = (await response.json()) as { ok?: boolean; data?: SkillSummary[] };
			if (body.ok && body.data) skills = body.data;
		} catch (err) {
			modalError = errorMessage(err);
		} finally {
			busy = false;
		}
	}

	async function removeSkill(skillName: string) {
		busy = true;
		try {
			await postConfigure('skill_remove', { name: skillName });
			toast(`Removed skill '${skillName}'`, 'success');
			const response = await fetch('/api/configure?view=skills');
			const body = (await response.json()) as { ok?: boolean; data?: SkillSummary[] };
			if (body.ok && body.data) skills = body.data;
		} catch (err) {
			toast(errorMessage(err), 'danger');
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:open={showAddModal} title="Add Skill" wide>
	{#if modalError}
		<div class="mb-3 rounded-xl border border-[color-mix(in_srgb,var(--danger)_38%,transparent)] bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] px-3 py-2 text-sm text-[var(--danger)]">
			{modalError}
		</div>
	{/if}
	<div class="grid gap-3 lg:grid-cols-2">
		<label class="block space-y-1">
			<span>Name</span>
			<input class="field" bind:value={name} placeholder="memory.search" />
		</label>
		<label class="block space-y-1">
			<span>Path</span>
			<input class="field" bind:value={path} placeholder="plugins/skills/memory/search.md" />
		</label>
		<label class="block space-y-1 lg:col-span-2">
			<span>Description</span>
			<input class="field" bind:value={description} placeholder="Short skill summary" />
		</label>
		<label class="block space-y-1 lg:col-span-2">
			<span>Install Command (optional)</span>
			<input class="field" bind:value={installCommand} placeholder="npm --prefix plugins/memory install" />
		</label>
		<label class="block space-y-1">
			<span>Plugin Targets (comma)</span>
			<input class="field" bind:value={pluginTargets} placeholder={pluginNames.join(', ') || 'chat_agent, memory_agent'} />
		</label>
		<label class="block space-y-1">
			<span>Resource Targets (comma)</span>
			<input class="field" bind:value={resourceTargets} placeholder="plugin:memory_agent, filesystem" />
		</label>
		<label class="block space-y-1">
			<span>Agent Targets (comma)</span>
			<input class="field" bind:value={agentTargets} placeholder="plugin:chat_agent" />
		</label>
		<label class="block space-y-1">
			<span>Action Targets (comma)</span>
			<input class="field" bind:value={actionTargets} placeholder="read, update" />
		</label>
		<label class="block space-y-1">
			<span>Tags (comma)</span>
			<input class="field" bind:value={tags} placeholder="memory, retrieval" />
		</label>
		<div class="flex items-end gap-4">
			<label class="flex items-center gap-2 text-sm subtle">
				<input type="checkbox" bind:checked={enabled} />
				Enabled
			</label>
			<label class="flex items-center gap-2 text-sm subtle">
				<input type="checkbox" bind:checked={runInstall} />
				Run install
			</label>
		</div>
	</div>
	<div class="mt-4 flex justify-end gap-2">
		<button class="btn btn-neutral btn-sm" onclick={() => (showAddModal = false)} disabled={busy}>
			Cancel
		</button>
		<button class="btn btn-primary btn-sm" onclick={addSkill} disabled={busy}>
			{busy ? 'Saving...' : 'Save Skill'}
		</button>
	</div>
</Modal>

<div class="mx-auto max-w-6xl space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Skills</h1>
			<p class="mt-1 text-sm subtle">
				Create installable skills and target them to plugins, resources, agents, and actions.
			</p>
		</div>
		<div class="flex gap-2">
			<button class="btn btn-primary btn-sm" onclick={() => { resetForm(); showAddModal = true; }} disabled={busy}>
				+ Add Skill
			</button>
			<button class="btn btn-neutral btn-sm" onclick={refreshSkills} disabled={busy}>
				{busy ? 'Refreshing...' : 'Refresh'}
			</button>
		</div>
	</div>

	<section class="panel panel-strong p-4">
		<div class="mb-3 flex items-center justify-between gap-2">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--text-soft)]">Installed Skills</h2>
			<span class="badge badge-neutral">{skills.length}</span>
		</div>
		{#if skills.length === 0}
			<p class="text-sm subtle">No skills configured yet.</p>
		{:else}
			<div class="space-y-2">
				{#each skills as skill (skill.name)}
					<div class="rounded-xl border border-[var(--line)] bg-[var(--surface-subtle)] p-3">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div>
								<p class="text-sm font-semibold">{skill.name}</p>
								<p class="text-xs subtle">{skill.source}</p>
							</div>
							<div class="flex items-center gap-2">
								{#if skill.enabled}
									<span class="badge badge-ok text-[10px]">enabled</span>
								{:else}
									<span class="badge badge-neutral text-[10px]">disabled</span>
								{/if}
								<button
									class="btn btn-danger btn-sm"
									onclick={() => removeSkill(skill.name)}
									disabled={busy || skill.source.startsWith('manifest:')}
								>
									Remove
								</button>
							</div>
						</div>
						{#if skill.description}
							<p class="mt-2 text-xs subtle">{skill.description}</p>
						{/if}
						{#if skill.path}
							<p class="mono mt-2 text-[11px] subtle">{skill.path}</p>
						{/if}
						<div class="mt-2 grid gap-2 text-xs sm:grid-cols-2">
							<p><span class="subtle">Plugins:</span> {skill.targets.plugins.length > 0 ? skill.targets.plugins.join(', ') : 'any'}</p>
							<p><span class="subtle">Resources:</span> {skill.targets.resources.length > 0 ? skill.targets.resources.join(', ') : 'any'}</p>
							<p><span class="subtle">Agents:</span> {skill.targets.agents.length > 0 ? skill.targets.agents.join(', ') : 'any'}</p>
							<p><span class="subtle">Actions:</span> {skill.targets.actions.length > 0 ? skill.targets.actions.join(', ') : 'any'}</p>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>
