<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	interface NavItem {
		label: string;
		href: string;
		icon: string;
		matchPrefix?: boolean;
	}

	interface NavigationExtension {
		name: string;
		title: string;
		route: string;
		order: number;
	}

	let {
		navigationExtensions = [],
		collapsed = $bindable(false),
		mobileOpen = $bindable(false)
	} = $props<{
		navigationExtensions?: NavigationExtension[];
		collapsed?: boolean;
		mobileOpen?: boolean;
	}>();

	const pathname = $derived(page.url.pathname);
	const COLLAPSED_KEY = 'pinokio.ui.sidebar-collapsed';

	const coreItems: NavItem[] = [
		{ label: 'Overview', href: '/', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1' },
		{ label: 'Configure', href: '/ui/configure', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z', matchPrefix: true },
		{ label: 'Map', href: '/ui/map', icon: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7' },
		{ label: 'System', href: '/ui', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
		{ label: 'Plugins', href: '/ui/plugins', icon: 'M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5', matchPrefix: true },
		{ label: 'Skills', href: '/ui/skills', icon: 'M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z', matchPrefix: true },
		{ label: 'Agent Pages', href: '/ui/apps', icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10', matchPrefix: true }
	];

	// Icon overrides for known extensions (so they get a proper icon instead of the generic puzzle piece)
	const extensionIcons: Record<string, string> = {
		chat: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z'
	};

	const defaultExtensionIcon = 'M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5';

	// Filter out dynamic extensions whose routes are already covered by core items
	const coreRoutes = new Set(coreItems.map(i => i.href));

	const filteredExtensions = $derived(
		navigationExtensions.filter(ext => !coreRoutes.has(ext.route))
	);

	function isActive(item: NavItem): boolean {
		if (item.href === '/') return pathname === '/';
		if (item.href === '/ui') return pathname === '/ui' || pathname === '/ui/';
		if (item.matchPrefix) return pathname === item.href || pathname.startsWith(item.href + '/');
		return pathname === item.href;
	}

	function handleNavClick() {
		mobileOpen = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') mobileOpen = false;
	}

	function toggleCollapse() {
		collapsed = !collapsed;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(COLLAPSED_KEY, String(collapsed));
		}
	}

	onMount(() => {
		const saved = localStorage.getItem(COLLAPSED_KEY);
		if (saved === 'true') collapsed = true;
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if mobileOpen}
	<div class="app-sidebar-backdrop md:hidden" onclick={() => (mobileOpen = false)} role="presentation"></div>
{/if}

<aside
	class="app-sidebar"
	class:app-sidebar-collapsed={collapsed}
	class:app-sidebar-open={mobileOpen}
>
	<!-- Brand -->
	<div class="flex items-center gap-2 border-b border-[var(--line)] px-3 py-3">
		<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
			<svg class="h-4 w-4 text-[var(--accent-strong)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
			</svg>
		</div>
		{#if !collapsed}
			<div class="overflow-hidden">
				<p class="text-sm font-bold leading-tight">Pinokio</p>
				<p class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-soft)]">Agent Control</p>
			</div>
		{/if}
	</div>

	<!-- Core nav -->
	<nav class="flex-1 space-y-0.5 px-2 py-3">
		<div class="app-sidebar-section-label">{collapsed ? '' : 'Navigation'}</div>
		{#each coreItems as item}
			<a
				class="app-sidebar-item"
				href={item.href}
				aria-current={isActive(item) ? 'page' : undefined}
				onclick={handleNavClick}
				title={collapsed ? item.label : undefined}
			>
				<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
				</svg>
				{#if !collapsed}
					<span>{item.label}</span>
				{/if}
			</a>
		{/each}

		<!-- Plugin/Apps section (driven by enabled extension surfaces) -->
		{#if filteredExtensions.length > 0}
			<div class="app-sidebar-section-label mt-4">{collapsed ? '' : 'Apps'}</div>
			{#each filteredExtensions as ext (ext.name)}
				<a
					class="app-sidebar-item"
					href={ext.route}
					aria-current={pathname === ext.route || pathname.startsWith(ext.route + '/') ? 'page' : undefined}
					onclick={handleNavClick}
					title={collapsed ? ext.title : undefined}
				>
					<svg class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d={extensionIcons[ext.name] ?? defaultExtensionIcon} />
					</svg>
					{#if !collapsed}
						<span>{ext.title}</span>
					{/if}
				</a>
			{/each}
		{/if}
	</nav>

	<!-- Collapse toggle (desktop only) -->
	<div class="hidden border-t border-[var(--line)] px-2 py-2 md:block">
		<button
			class="app-sidebar-item w-full"
			onclick={toggleCollapse}
			title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		>
			<svg class="h-5 w-5 shrink-0 transition-transform" class:rotate-180={collapsed} fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
			</svg>
			{#if !collapsed}
				<span>Collapse</span>
			{/if}
		</button>
	</div>
</aside>
