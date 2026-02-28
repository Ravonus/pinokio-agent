<script lang="ts">
	import type { SocketBusMessage } from '$lib/ui/socket-bus';

	let {
		messages = []
	} = $props<{
		messages: SocketBusMessage[];
	}>();

	let expanded = $state(false);

	const displayMessages = $derived(messages.slice(0, 8));

	function shortChannel(channel: string): string {
		// "plugin:pinokio.chat:meta" → "chat:meta"
		const match = channel.match(/^plugin:pinokio\.([^:]+):(.+)$/);
		if (match) return `${match[1]}:${match[2]}`;
		return channel;
	}

	function shortSender(sender: string): string {
		// "system:plugins" → "system"
		// "plugin:chat_agent" → "chat_agent"
		if (sender.startsWith('system:')) return 'system';
		if (sender.startsWith('plugin:')) return sender.replace('plugin:', '');
		return sender;
	}

	function shortSchema(schema: string): string {
		// "pinokio.plugins.announce/v1" → "announce"
		const match = schema.match(/\.([^./]+)\/v\d+$/);
		if (match) return match[1];
		if (schema.length > 20) return schema.slice(0, 20) + '...';
		return schema || 'msg';
	}
</script>

<div class="absolute left-3 z-10 md:left-4" style="bottom: 70px;">
	<button
		class="flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-2.5 py-1.5 text-[10px] font-medium shadow-sm transition-colors hover:bg-[var(--surface-subtle)]"
		onclick={() => (expanded = !expanded)}
	>
		<span class="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" style="animation: pulse 2s ease-in-out infinite;"></span>
		Activity ({messages.length})
		<svg class="h-3 w-3 transition-transform" class:rotate-180={expanded} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
		</svg>
	</button>

	{#if expanded}
		<div class="mt-1 max-h-48 w-64 overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] p-2 shadow-md">
			{#if displayMessages.length === 0}
				<p class="text-[10px] text-[var(--text-soft)]">No recent activity</p>
			{:else}
				<div class="space-y-1">
					{#each displayMessages as msg (msg.seq + ':' + msg.channel)}
						<div class="rounded-md bg-[var(--surface-subtle)] px-2 py-1.5 text-[10px]">
							<div class="flex items-center justify-between gap-1">
								<span class="font-semibold text-[var(--accent)]">{shortSender(msg.sender_resource)}</span>
								<span class="text-[9px] text-[var(--text-soft)]">seq:{msg.seq}</span>
							</div>
							<div class="mt-0.5 flex items-center gap-1 text-[var(--text-soft)]">
								<span class="font-mono">{shortChannel(msg.channel)}</span>
								<span class="opacity-50">&middot;</span>
								<span>{shortSchema(msg.schema)}</span>
							</div>
							{#if msg.summary && msg.summary !== msg.schema}
								<p class="mt-0.5 truncate text-[9px] text-[var(--text-soft)] opacity-70">{msg.summary}</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
</style>
