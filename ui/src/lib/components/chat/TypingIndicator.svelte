<script lang="ts">
	let { label = 'Agent is thinking' } = $props<{ label?: string }>();
</script>

<div class="flex items-start gap-3">
	<div class="chat-bubble-assistant inline-flex items-center gap-2">
		<div class="flex items-center gap-1">
			<span class="typing-dot" style="animation-delay: 0ms"></span>
			<span class="typing-dot" style="animation-delay: 200ms"></span>
			<span class="typing-dot" style="animation-delay: 400ms"></span>
		</div>
		<span class="text-xs text-[var(--text-soft)]">{label}</span>
	</div>
</div>
