<script lang="ts">
	import { tick } from 'svelte';

	let {
		value = $bindable(''),
		busy = false,
		onsubmit,
		onattach
	} = $props<{
		value?: string;
		busy?: boolean;
		onsubmit: (text: string, files: File[]) => void;
		onattach?: (files: File[]) => void;
	}>();

	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let pendingFiles = $state<File[]>([]);

	function autoResize() {
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		const max = 5 * 24;
		textareaEl.style.height = Math.min(textareaEl.scrollHeight, max) + 'px';
	}

	$effect(() => {
		value;
		tick().then(autoResize);
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			doSend();
		}
	}

	function doSend() {
		const text = value.trim();
		if (!text || busy) return;
		onsubmit(text, pendingFiles);
		value = '';
		pendingFiles = [];
		tick().then(autoResize);
	}

	function handleFileChange() {
		if (!fileInput?.files) return;
		const newFiles = Array.from(fileInput.files);
		pendingFiles = [...pendingFiles, ...newFiles];
		onattach?.(newFiles);
		fileInput.value = '';
	}

	function removeFile(index: number) {
		pendingFiles = pendingFiles.filter((_, i) => i !== index);
	}
</script>

{#if pendingFiles.length > 0}
	<div class="flex flex-wrap gap-2 border-t border-[var(--line)] bg-[var(--bg-1)] px-4 py-2">
		{#each pendingFiles as file, i}
			<span class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--bg-2)] px-2.5 py-1 text-xs">
				<svg class="h-3.5 w-3.5 text-[var(--text-soft)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
				</svg>
				<span class="max-w-[120px] truncate">{file.name}</span>
				<button
					class="ml-0.5 rounded p-0.5 text-[var(--text-soft)] hover:bg-[var(--bg-3)] hover:text-[var(--text)]"
					onclick={() => removeFile(i)}
					aria-label="Remove {file.name}"
				>
					<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</span>
		{/each}
	</div>
{/if}

<div class="chat-input-bar">
	<input
		bind:this={fileInput}
		type="file"
		multiple
		class="hidden"
		onchange={handleFileChange}
	/>
	<button
		class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--text)]"
		onclick={() => fileInput?.click()}
		disabled={busy}
		title="Attach files"
		type="button"
	>
		<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
		</svg>
	</button>

	<textarea
		bind:this={textareaEl}
		class="field max-h-[120px] min-h-[40px] flex-1 resize-none py-2"
		placeholder="Type a message..."
		bind:value
		onkeydown={handleKeydown}
		oninput={autoResize}
		disabled={busy}
		rows="1"
	></textarea>

	<button
		class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-white transition-all hover:bg-[var(--accent-strong)] disabled:opacity-40"
		onclick={doSend}
		disabled={busy || value.trim().length === 0}
		title="Send message"
		type="button"
	>
		{#if busy}
			<svg class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
			</svg>
		{:else}
			<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-7 7m7-7l7 7" />
			</svg>
		{/if}
	</button>
</div>
