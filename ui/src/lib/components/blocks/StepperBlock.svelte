<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'stepper' }> }>();
</script>

<div class="flex items-start gap-0">
	{#each block.steps as step, i}
		<div class="flex flex-1 flex-col items-center text-center">
			<div class="flex w-full items-center">
				{#if i > 0}
					<div
						class="h-0.5 flex-1 {step.status === 'completed' || step.status === 'active'
							? 'bg-[var(--accent)]'
							: 'bg-[var(--bg-3)]'}"
					></div>
				{:else}
					<div class="flex-1"></div>
				{/if}
				<div
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold
					{step.status === 'completed'
						? 'bg-[var(--accent)] text-white'
						: step.status === 'active'
							? 'border-2 border-[var(--accent)] text-[var(--accent)]'
							: 'border-2 border-[var(--bg-3)] text-[var(--text-soft)]'}"
				>
					{#if step.status === 'completed'}
						&#10003;
					{:else}
						{i + 1}
					{/if}
				</div>
				{#if i < block.steps.length - 1}
					<div
						class="h-0.5 flex-1 {step.status === 'completed'
							? 'bg-[var(--accent)]'
							: 'bg-[var(--bg-3)]'}"
					></div>
				{:else}
					<div class="flex-1"></div>
				{/if}
			</div>
			<p
				class="mt-1.5 text-xs font-medium {step.status === 'active'
					? 'text-[var(--accent)]'
					: ''}"
			>
				{step.label}
			</p>
			{#if step.description}
				<p class="mt-0.5 text-[10px] text-[var(--text-soft)]">{step.description}</p>
			{/if}
		</div>
	{/each}
</div>
