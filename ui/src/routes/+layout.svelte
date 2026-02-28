<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Toast from '$lib/components/Toast.svelte';
	import AppSidebar from '$lib/components/AppSidebar.svelte';
	import '../app.css';

	type ThemeMode = 'light' | 'dark' | 'system';
	type NavigationExtension = {
		name: string;
		title: string;
		route: string;
		order: number;
	};

	let { children, data } = $props<{
		children: import('svelte').Snippet;
		data?: { navigationExtensions?: NavigationExtension[] };
	}>();
	let themeMode = $state<ThemeMode>('system');
	let sidebarCollapsed = $state(false);
	let mobileOpen = $state(false);
	const pathname = $derived(page.url.pathname);
	const navigationExtensions = $derived(data?.navigationExtensions ?? []);
	const isFullPage = $derived(pathname === '/ui/map' || pathname.startsWith('/ui/map/'));

	const THEME_KEY = 'pinokio.ui.theme-mode';
	const media =
		typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

	function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
		if (mode === 'system') {
			return media?.matches ? 'dark' : 'light';
		}
		return mode;
	}

	function applyTheme(mode: ThemeMode) {
		const next = resolveTheme(mode);
		const root = document.documentElement;
		root.dataset.theme = next;
		root.dataset.themeMode = mode;
	}

	function setTheme(mode: ThemeMode) {
		themeMode = mode;
		localStorage.setItem(THEME_KEY, mode);
		applyTheme(mode);
	}

	function cycleTheme() {
		const order: ThemeMode[] = ['light', 'dark', 'system'];
		const next = order[(order.indexOf(themeMode) + 1) % order.length];
		setTheme(next);
	}

	onMount(() => {
		const saved = localStorage.getItem(THEME_KEY);
		if (saved === 'light' || saved === 'dark' || saved === 'system') {
			themeMode = saved;
		}
		applyTheme(themeMode);
		const onChange = () => {
			if (themeMode === 'system') {
				applyTheme('system');
			}
		};
		media?.addEventListener('change', onChange);
		return () => media?.removeEventListener('change', onChange);
	});
</script>

<div class="app-shell flex min-h-screen">
	<AppSidebar {navigationExtensions} bind:collapsed={sidebarCollapsed} bind:mobileOpen />

	<div
		class="flex min-h-screen flex-1 flex-col transition-[margin] duration-200"
		class:md:ml-60={!sidebarCollapsed}
		class:md:ml-14={sidebarCollapsed}
	>
		<!-- Top bar -->
		<header
			class="surface-strong sticky top-0 z-30 flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5"
			class:hidden={isFullPage}
		>
			<div class="flex items-center gap-3">
				<!-- Mobile hamburger -->
				<button
					class="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--text)] md:hidden"
					onclick={() => (mobileOpen = true)}
					aria-label="Open navigation"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
					</svg>
				</button>
				<p class="mono text-xs font-medium uppercase tracking-[0.15em] text-[var(--text-soft)]">
					pinokio.ai
				</p>
			</div>

			<!-- Theme switcher -->
			<button
				class="flex h-9 items-center gap-2 rounded-lg border border-[var(--line)] px-3 text-sm text-[var(--text-soft)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--text)]"
				onclick={cycleTheme}
				title="Theme: {themeMode}"
			>
				{#if themeMode === 'light'}
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
					</svg>
					Light
				{:else if themeMode === 'dark'}
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
					</svg>
					Dark
				{:else}
					<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
					</svg>
					System
				{/if}
			</button>
		</header>

		<!-- Mobile hamburger floating (for full-page modes like map) -->
		{#if isFullPage}
			<button
				class="fixed left-3 top-3 z-40 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--surface-strong)] shadow-lg md:hidden"
				onclick={() => (mobileOpen = true)}
				aria-label="Open navigation"
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
		{/if}

		<main class={isFullPage ? 'flex-1' : 'flex-1 p-4 md:p-6'}>
			{@render children()}
		</main>
	</div>

	<Toast />
</div>
