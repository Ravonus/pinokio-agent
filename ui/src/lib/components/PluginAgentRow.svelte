<script lang="ts">
	import type { UiExtensionSurface } from '$lib/ui/manager';

	let {
		surface,
		busy = false,
		ontoggle
	} = $props<{
		surface: UiExtensionSurface;
		busy?: boolean;
		ontoggle?: (surface: UiExtensionSurface) => void;
	}>();

	const isEnabled = $derived(surface.enabled !== false);
</script>

<div
	class="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--bg-1)_70%,var(--surface))]"
	class:opacity-50={!isEnabled}
>
	<!-- Agent name + detail -->
	<div class="min-w-0 flex-1">
		<div class="flex items-center gap-2">
			<span class="text-xs font-medium">{surface.title || surface.name}</span>
			{#if surface.slot}
				<span class="rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,var(--bg-1))] px-1.5 py-0.5 text-[9px] font-medium text-[var(--accent)]">
					{surface.slot}
				</span>
			{/if}
			{#if surface.source}
				<span class="text-[9px] font-mono text-[var(--text-soft)] opacity-50">{surface.source}</span>
			{/if}
		</div>
		{#if surface.detail}
			<p class="mt-0.5 text-[10px] text-[var(--text-soft)] line-clamp-1">{surface.detail}</p>
		{/if}
	</div>

	<!-- Toggle -->
	{#if ontoggle}
		<label class="relative inline-flex shrink-0 cursor-pointer">
			<input
				type="checkbox"
				class="toggle-switch"
				checked={isEnabled}
				onchange={() => ontoggle?.(surface)}
				disabled={busy}
			/>
		</label>
	{/if}
</div>
