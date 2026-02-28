<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		name,
		label,
		type = 'text',
		value = $bindable(''),
		placeholder = '',
		required = false,
		disabled = false,
		error = '',
		help = '',
		icon,
		children
	} = $props<{
		name: string;
		label: string;
		type?: string;
		value?: string;
		placeholder?: string;
		required?: boolean;
		disabled?: boolean;
		error?: string;
		help?: string;
		icon?: Snippet;
		children?: Snippet;
	}>();

	const fieldClass = $derived(error ? 'field field-error' : 'field');
</script>

<label class="block space-y-1.5">
	<span class="flex items-center gap-1.5">
		<span class="text-sm font-medium">{label}</span>
		{#if required}
			<span class="text-xs text-[var(--danger)]">*</span>
		{/if}
	</span>
	<div class="relative">
		{#if icon}
			<span
				class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-soft)]"
			>
				{@render icon()}
			</span>
		{/if}
		<input
			class={fieldClass}
			class:pl-9={icon}
			{name}
			{type}
			{placeholder}
			{required}
			{disabled}
			bind:value
		/>
	</div>
	{#if error}
		<p class="text-xs text-[var(--danger)]">{error}</p>
	{:else if help}
		<p class="text-xs text-[var(--text-soft)]">{help}</p>
	{/if}
</label>
