<script lang="ts">
	let {
		checked = $bindable(false),
		name = '',
		label = ''
	} = $props<{
		checked?: boolean;
		name?: string;
		label?: string;
	}>();
</script>

<label class="inline-flex cursor-pointer items-center gap-2">
	<input type="checkbox" class="sr-only" {name} bind:checked />
	<span class="toggle-track" data-active={checked}>
		<span class="toggle-thumb"></span>
	</span>
	{#if label}
		<span class="text-sm">{label}</span>
	{/if}
</label>
