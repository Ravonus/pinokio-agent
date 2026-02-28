<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'table' }> }>();
</script>

<div class="overflow-x-auto rounded-xl border border-[var(--line)]">
	<table class="min-w-full border-collapse">
		<thead>
			<tr class="surface-subtle border-b border-[var(--line)]">
				{#each block.columns as column}
					<th class="subtle px-3 py-2 text-left text-xs uppercase tracking-wide">{column}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#if block.rows.length === 0}
				<tr>
					<td class="subtle px-3 py-3" colspan={block.columns.length}>No rows.</td>
				</tr>
			{:else}
				{#each block.rows as row}
					<tr class="border-b border-[var(--line)] last:border-b-0">
						{#each block.columns as column}
							<td class="mono px-3 py-2 text-sm">{row[column] ?? ''}</td>
						{/each}
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
