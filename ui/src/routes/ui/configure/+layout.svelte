<script lang="ts">
	import { page } from '$app/state';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';

	type SettingsExtension = {
		name: string;
		title: string;
		route: string;
		order: number;
	};

	let { children, data } = $props<{
		children: import('svelte').Snippet;
		data?: { settingsExtensions?: SettingsExtension[] };
	}>();
	const pathname = $derived(page.url.pathname);
	const staticRoutes = ['/ui/configure/credentials', '/ui/configure/tasks', '/ui/configure/database', '/ui/configure/extensions', '/ui/configure/diagnostics'];
	const settingsExtensions = $derived(
		(data?.settingsExtensions ?? []).filter(
			(extension: SettingsExtension) =>
				!staticRoutes.includes(extension.route) &&
				!extension.route.startsWith('/ui/configure/credentials/')
		)
	);

	function navClass(active: boolean): string {
		return active ? 'btn btn-soft' : 'btn btn-neutral';
	}

	const breadcrumbs = $derived.by(() => {
		const crumbs: { label: string; href?: string }[] = [
			{ label: 'Configure', href: '/ui/configure' }
		];
		if (pathname.includes('/credentials')) {
			crumbs.push({ label: 'Credentials', href: '/ui/configure/credentials' });
			const provider = page.params.provider;
			if (provider) {
				const name =
					provider === 'claude-api'
						? 'Claude API'
						: provider === 'claude-code'
							? 'Claude Code'
							: provider.charAt(0).toUpperCase() + provider.slice(1);
				crumbs.push({ label: name });
			}
		} else if (page.params.section) {
			const section = page.params.section;
			crumbs.push({ label: section.charAt(0).toUpperCase() + section.slice(1) });
		}
		return crumbs;
	});
</script>

<div class="surface surface-strong mb-4 p-4 md:p-5">
	<Breadcrumb items={breadcrumbs} />
	<nav class="tab-row mt-3">
		<a
			class={navClass(pathname.startsWith('/ui/configure/credentials') || pathname === '/ui/configure')}
			href="/ui/configure/credentials"
		>
			Credentials
		</a>
		<a class={navClass(pathname === '/ui/configure/tasks')} href="/ui/configure/tasks">
			Task Runner
		</a>
		<a class={navClass(pathname === '/ui/configure/database')} href="/ui/configure/database">
			Database
		</a>
		<a class={navClass(pathname === '/ui/configure/extensions')} href="/ui/configure/extensions">
			Extensions
		</a>
		<a
			class={navClass(pathname === '/ui/configure/diagnostics')}
			href="/ui/configure/diagnostics"
		>
			Diagnostics
		</a>
		{#each settingsExtensions as extension (extension.name)}
			<a
				class={navClass(pathname === extension.route || pathname.startsWith(`${extension.route}/`))}
				href={extension.route}
			>
				{extension.title}
			</a>
		{/each}
	</nav>
</div>

{@render children()}
