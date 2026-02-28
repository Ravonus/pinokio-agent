<script lang="ts" module>
	interface ToastItem {
		id: number;
		message: string;
		tone: 'success' | 'danger' | 'warning' | 'neutral';
		dismissing: boolean;
	}

	let _id = 0;
	let items = $state<ToastItem[]>([]);

	export function toast(
		message: string,
		tone: ToastItem['tone'] = 'neutral',
		durationMs = 4000
	) {
		const item: ToastItem = { id: ++_id, message, tone, dismissing: false };
		items = [...items, item];
		setTimeout(() => dismiss(item.id), durationMs);
	}

	function dismiss(id: number) {
		items = items.map((t) => (t.id === id ? { ...t, dismissing: true } : t));
		setTimeout(() => {
			items = items.filter((t) => t.id !== id);
		}, 280);
	}
</script>

<div class="toast-container">
	{#each items as item (item.id)}
		<div
			class={`toast toast-${item.tone}`}
			style={item.dismissing ? 'animation: toast-out 280ms ease both' : ''}
		>
			<p>{item.message}</p>
		</div>
	{/each}
</div>
