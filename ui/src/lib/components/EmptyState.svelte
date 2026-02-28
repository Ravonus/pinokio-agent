<script lang="ts">
	let {
		title = 'Nothing here yet',
		detail = '',
		actionLabel = '',
		actionHref = ''
	} = $props<{
		title?: string;
		detail?: string;
		actionLabel?: string;
		actionHref?: string;
	}>();
</script>

<div class="flex flex-col items-center justify-center py-12 text-center">
	<div class="mb-4 rounded-full bg-[var(--bg-2)] p-4">
		<svg
			class="h-8 w-8 text-[var(--text-soft)]"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="1.5"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M20 13V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7m16 0v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5m16 0h-2.586a1 1 0 0 0-.707.293l-2.414 2.414a1 1 0 0 1-.707.293h-3.172a1 1 0 0 1-.707-.293l-2.414-2.414A1 1 0 0 0 6.586 13H4"
			/>
		</svg>
	</div>
	<h3 class="text-lg font-semibold">{title}</h3>
	{#if detail}
		<p class="subtle mt-1 max-w-md text-sm">{detail}</p>
	{/if}
	{#if actionLabel && actionHref}
		<a class="btn btn-primary mt-4" href={actionHref}>{actionLabel}</a>
	{/if}
</div>
