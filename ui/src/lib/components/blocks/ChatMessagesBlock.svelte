<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';

	let { block } = $props<{ block: Extract<UiBlock, { type: 'chat_messages' }> }>();
</script>

<div class="space-y-3">
	{#each block.messages as msg}
		<div class={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
			<div
				class="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm {msg.role === 'user'
					? 'rounded-br-sm bg-[var(--accent)] text-white'
					: msg.role === 'system'
						? 'surface-subtle border border-[var(--line)] italic'
						: 'surface-subtle rounded-bl-sm border border-[var(--line)]'}"
			>
				{#if msg.name}
					<p class="mb-0.5 text-xs font-semibold opacity-70">{msg.name}</p>
				{/if}
				<p class="whitespace-pre-wrap">{msg.content}</p>
				{#if msg.timestamp}
					<p class="mt-1 text-[10px] opacity-50">{msg.timestamp}</p>
				{/if}
			</div>
		</div>
	{/each}
</div>
