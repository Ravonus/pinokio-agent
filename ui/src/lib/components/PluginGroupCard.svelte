<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { UiExtensionSurface } from '$lib/ui/manager';
	import type { PluginGroup } from '$lib/ui/plugin-groups';
	import PluginAgentRow from './PluginAgentRow.svelte';
	import PluginServiceRow from './PluginServiceRow.svelte';

	let {
		group,
		busy = false,
		ontoggle,
		ontoggleall,
		onremovegroup,
		configSlot
	} = $props<{
		group: PluginGroup;
		busy?: boolean;
		ontoggle?: (surface: UiExtensionSurface) => void;
		ontoggleall?: (group: PluginGroup, enabled: boolean) => void;
		onremovegroup?: (group: PluginGroup) => void;
		configSlot?: Snippet;
	}>();

	let expanded = $state(false);
	let confirmRemove = $state(false);

	const statusText = $derived.by(() => {
		const agentCount = group.surfaces.length;
		const serviceCount = group.services.length;
		const parts: string[] = [];
		if (agentCount > 0) parts.push(`${agentCount} agent${agentCount !== 1 ? 's' : ''}`);
		if (serviceCount > 0) parts.push(`${serviceCount} service${serviceCount !== 1 ? 's' : ''}`);

		if (group.allEnabled) {
			parts.push('all on');
		} else if (group.someEnabled) {
			parts.push(`${group.enabledCount} of ${agentCount} on`);
		} else {
			parts.push('all off');
		}
		return parts.join(' · ');
	});

	function handleMasterToggle() {
		// If any are enabled, disable all; if all off, enable all
		ontoggleall?.(group, !group.someEnabled);
	}
</script>

<div class="rounded-xl border border-[var(--line)] bg-[var(--surface)] transition-shadow hover:shadow-sm">
	<!-- Header (always visible) -->
	<button
		class="flex w-full items-center gap-3 px-4 py-3 text-left"
		onclick={() => (expanded = !expanded)}
	>
		<!-- Group icon -->
		<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_12%,var(--bg-1))]">
			<svg class="h-4.5 w-4.5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d={group.def.icon} />
			</svg>
		</div>

		<!-- Label + status -->
		<div class="min-w-0 flex-1">
			<h3 class="text-sm font-semibold">{group.def.label}</h3>
			<p class="text-[11px] text-[var(--text-soft)]">{statusText}</p>
		</div>

		<!-- Expand chevron -->
		<svg
			class="h-4 w-4 shrink-0 text-[var(--text-soft)] transition-transform duration-200"
			class:rotate-90={expanded}
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
		</svg>

		<!-- Master toggle (stop propagation so click doesn't expand) -->
		<span
			class="relative inline-flex shrink-0"
			role="presentation"
			onclick={(e: MouseEvent) => e.stopPropagation()}
			onkeydown={(e: KeyboardEvent) => e.stopPropagation()}
		>
			<input
				type="checkbox"
				class="toggle-switch"
				checked={group.someEnabled}
				onchange={handleMasterToggle}
				disabled={busy}
			/>
		</span>
	</button>

	<!-- Expanded content -->
	{#if expanded}
		<div class="border-t border-[var(--line)] px-4 pb-4 pt-3 space-y-4">
			<!-- Description -->
			{#if group.def.description}
				<p class="text-xs text-[var(--text-soft)]">{group.def.description}</p>
			{/if}

			<!-- Services section -->
			{#if group.services.length > 0}
				<div>
					<h4 class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-soft)]">Services</h4>
					<div class="space-y-1.5">
						{#each group.services as service (service.name)}
							<PluginServiceRow {service} />
						{/each}
					</div>
				</div>
			{/if}

			<!-- Agents section -->
			{#if group.surfaces.length > 0}
				<div>
					<h4 class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-soft)]">Agents</h4>
					<div class="-mx-3 divide-y divide-[var(--line)]">
						{#each group.surfaces as surface (surface.name)}
							<PluginAgentRow {surface} {busy} {ontoggle} />
						{/each}
					</div>
				</div>
			{/if}

			<!-- Extensible config slot -->
			{#if configSlot}
				<div class="border-t border-[var(--line)] pt-3">
					<h4 class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-soft)]">Configuration</h4>
					{@render configSlot()}
				</div>
			{/if}

			<!-- Remove (only for non-builtIn / user-installed plugins) -->
			{#if !group.def.builtIn && onremovegroup}
				<div class="border-t border-[var(--line)] pt-3 flex items-center gap-2">
					{#if confirmRemove}
						<span class="text-xs text-[var(--danger, #ef4444)]">Remove all surfaces in this group?</span>
						<button
							class="btn text-xs px-2 py-1 bg-[var(--danger,#ef4444)] text-white hover:opacity-90"
							onclick={() => { onremovegroup?.(group); confirmRemove = false; }}
							disabled={busy}
						>
							Confirm
						</button>
						<button
							class="btn btn-ghost text-xs px-2 py-1"
							onclick={() => (confirmRemove = false)}
						>
							Cancel
						</button>
					{:else}
						<button
							class="btn btn-ghost text-xs px-2 py-1 text-[var(--danger,#ef4444)] hover:bg-[color-mix(in_srgb,var(--danger,#ef4444)_10%,var(--bg-1))]"
							onclick={() => (confirmRemove = true)}
							disabled={busy}
						>
							Remove Plugin
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
