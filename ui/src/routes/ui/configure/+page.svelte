<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	onMount(() => {
		goto('/ui/configure/credentials', { replaceState: true });
	});
</script>

<section class="surface p-6 md:p-8">
	<h1 class="text-2xl font-semibold">Redirecting...</h1>
	<p class="subtle mt-2 text-sm">Taking you to the credentials setup page.</p>
	<a class="btn btn-primary mt-4" href="/ui/configure/credentials">Continue</a>
</section>
