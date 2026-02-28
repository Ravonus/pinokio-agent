<script lang="ts">
	interface Crumb {
		label: string;
		href?: string;
	}

	let { items } = $props<{ items: Crumb[] }>();
</script>

<nav class="breadcrumb">
	{#each items as crumb, i}
		{#if i > 0}
			<span class="breadcrumb-separator">/</span>
		{/if}
		{#if crumb.href && i < items.length - 1}
			<a href={crumb.href}>{crumb.label}</a>
		{:else}
			<span class:font-medium={i === items.length - 1}>{crumb.label}</span>
		{/if}
	{/each}
</nav>
