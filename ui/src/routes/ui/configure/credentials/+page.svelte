<script lang="ts">
	import type { CredentialStatus, OAuthCliDetectionReport } from '$lib/ui/manager';
	import type { PageData } from './$types';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { toast } from '$lib/components/Toast.svelte';

	interface ProviderCard {
		name: string;
		provider: string;
		detail: string;
		href: string;
		quickConnect?: () => Promise<void>;
	}

	let { data } = $props<{ data: PageData }>();
	let status = $state<CredentialStatus[]>([]);
	let cliDetections = $state<OAuthCliDetectionReport | null>(null);
	let busy = $state(false);
	let failoverExpanded = $state(false);

	$effect(() => {
		status = data.status;
		cliDetections = data.cliDetections;
	});

	const hasAnyReady = $derived(status.some((s) => isCredentialReady(s)));
	const readyItems = $derived(status.filter((s) => isCredentialReady(s)));
	const notReadyItems = $derived(status.filter((s) => !isCredentialReady(s)));

	async function refreshState() {
		try {
			const [statusRes, detectorsRes] = await Promise.all([
				fetch('/api/configure?view=status'),
				fetch('/api/configure?view=detectors')
			]);
			const [statusJson, detectorsJson] = await Promise.all([
				statusRes.json(),
				detectorsRes.json()
			]);
			if (!statusJson.ok) throw new Error(statusJson.error ?? 'failed to load status');
			if (!detectorsJson.ok)
				throw new Error(detectorsJson.error ?? 'failed to load cli detectors');
			status = statusJson.data as CredentialStatus[];
			cliDetections = detectorsJson.data as OAuthCliDetectionReport;
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		}
	}

	async function submit(action: string, payload: Record<string, unknown>): Promise<boolean> {
		busy = true;
		try {
			const response = await fetch('/api/configure', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, payload })
			});
			const body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error(body.error ?? `action failed (${response.status})`);
			}
			toast('Action completed successfully', 'success');
			await refreshState();
			return true;
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
			return false;
		} finally {
			busy = false;
		}
	}

	async function onQuickConnectClaudeCode() {
		await submit('claude_code_oauth_connect', {
			credential: 'claude_code_main',
			profile: 'claude_code',
			layer: 'claude_code'
		});
	}

	async function onQuickConnectCodex() {
		await submit('codex_oauth_connect', {
			credential: 'codex_main',
			profile: 'codex',
			layer: 'openai_codex'
		});
	}

	function isCredentialReady(item: CredentialStatus): boolean {
		return item.token_present || item.mode === 'oauth_cli';
	}

	function providerDisplayName(provider: string): string {
		switch (provider) {
			case 'openai':
				return 'OpenAI';
			case 'anthropic':
				return 'Anthropic';
			case 'claude_code':
				return 'Claude Code';
			case 'codex':
				return 'Codex';
			default:
				return provider;
		}
	}

	const providerCards: ProviderCard[] = [
		{
			name: 'OpenAI',
			provider: 'openai',
			detail: 'GPT-4.1, GPT-4o, and other OpenAI models via API key.',
			href: '/ui/configure/credentials/openai'
		},
		{
			name: 'Claude API',
			provider: 'anthropic',
			detail: 'Claude models via Anthropic API key.',
			href: '/ui/configure/credentials/claude-api'
		},
		{
			name: 'Claude Code',
			provider: 'claude_code',
			detail: 'One-click in-app connect (installs runtime if needed).',
			href: '/ui/configure/credentials/claude-code',
			quickConnect: onQuickConnectClaudeCode
		},
		{
			name: 'Codex',
			provider: 'codex',
			detail: 'One-click in-app connect (installs runtime if needed).',
			href: '/ui/configure/credentials/codex',
			quickConnect: onQuickConnectCodex
		}
	];

	function isProviderReady(provider: string): boolean {
		return status.some(
			(s) =>
				(s.provider === provider || s.name.includes(provider)) && isCredentialReady(s)
		);
	}
</script>

<!-- Header -->
<section class="surface p-5 md:p-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="max-w-2xl">
			<h1 class="text-2xl font-bold">Credentials</h1>
			<p class="subtle mt-1 text-sm">
				Connect at least one AI provider to get started. Additional providers can be added
				as failovers.
			</p>
		</div>
		<button class="btn btn-neutral" disabled={busy} onclick={() => refreshState()}>
			{#if busy}<LoadingSpinner size="sm" />{:else}Refresh{/if}
		</button>
	</div>
	{#if busy}
		<div class="mt-4">
			<LoadingSpinner label="Processing..." />
		</div>
	{/if}
</section>

<!-- Status banner -->
{#if hasAnyReady}
	<div class="callout callout-tip mt-4">
		<div class="flex items-center gap-2">
			<svg
				class="h-5 w-5 shrink-0"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
			<p class="text-sm font-medium">
				Ready &mdash; {readyItems.length} provider{readyItems.length > 1 ? 's' : ''}
				connected
				({readyItems.map((s) => providerDisplayName(s.provider)).join(', ')})
			</p>
		</div>
	</div>
{:else if status.length > 0}
	<div class="callout callout-warning mt-4">
		<div class="flex items-center gap-2">
			<svg
				class="h-5 w-5 shrink-0"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.194-.833-2.964 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
				/>
			</svg>
			<p class="text-sm font-medium">
				No providers connected yet. Connect at least one to use the agent system.
			</p>
		</div>
	</div>
{/if}

<!-- Provider cards -->
<div class="mt-4 space-y-3">
	<h2 class="px-1 text-sm font-semibold uppercase tracking-wide text-[var(--text-soft)]">
		Providers
	</h2>
	<div class="card-grid">
		{#each providerCards as provider}
			{@const ready = isProviderReady(provider.provider)}
			<article
				class="surface rounded-xl p-4 transition-all"
				class:border-l-4={ready}
				class:border-l-[var(--accent)]={ready}
			>
				<div class="flex items-start justify-between gap-2">
					<div>
						<h3 class="font-semibold">{provider.name}</h3>
						<p class="subtle mt-1 text-sm">{provider.detail}</p>
					</div>
					{#if ready}
						<span class="badge badge-ok">Connected</span>
					{:else if hasAnyReady}
						<span class="badge badge-neutral">Optional</span>
					{:else}
						<span class="badge badge-warn">Not set up</span>
					{/if}
				</div>
				<div class="mt-3 flex flex-wrap gap-2">
					<a class="btn btn-neutral" href={provider.href}>
						{ready ? 'Manage' : 'Configure'}
					</a>
					{#if provider.quickConnect && !ready}
						<button
							class="btn btn-soft"
							disabled={busy}
							onclick={() => provider.quickConnect?.()}
						>
							Quick Connect
						</button>
					{/if}
				</div>
			</article>
		{/each}
	</div>
</div>

<!-- Failover configuration -->
<div class="mt-6 space-y-3">
	<button
		class="flex w-full items-center gap-2 px-1 text-left text-sm font-semibold uppercase tracking-wide text-[var(--text-soft)] transition-colors hover:text-[var(--text)]"
		onclick={() => (failoverExpanded = !failoverExpanded)}
	>
		<svg
			class="h-4 w-4 transition-transform"
			class:rotate-90={failoverExpanded}
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
		</svg>
		Failover & Priority
	</button>

	{#if failoverExpanded}
		<article class="surface rounded-xl p-4 md:p-5">
			<h3 class="font-semibold">LLM Failover Chain</h3>
			<p class="subtle mt-1 text-sm">
				When the primary LLM fails, the system automatically tries the next provider in
				the chain. The default configuration uses OpenAI as primary with Claude Code as
				fallback (and vice versa).
			</p>

			<div class="mt-4 space-y-2">
				{#if readyItems.length === 0}
					<div class="callout callout-info">
						<p class="text-sm">
							Connect at least one provider above to configure failover.
						</p>
					</div>
				{:else if readyItems.length === 1}
					<div class="flex items-center gap-3 rounded-lg border border-[var(--line)] px-4 py-3">
						<div
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-bold text-[var(--accent-strong)]"
						>
							1
						</div>
						<div class="flex-1">
							<p class="text-sm font-medium">
								{providerDisplayName(readyItems[0].provider)}
							</p>
							<p class="mono subtle text-xs">{readyItems[0].name}</p>
						</div>
						<span class="badge badge-ok">Primary</span>
					</div>
					<div class="callout callout-info">
						<p class="text-sm">
							Connect a second provider to enable automatic failover.
						</p>
					</div>
				{:else}
					{#each readyItems as item, i}
						<div
							class="flex items-center gap-3 rounded-lg border border-[var(--line)] px-4 py-3"
						>
							<div
								class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
								class:bg-[var(--accent-soft)]={i === 0}
								class:text-[var(--accent-strong)]={i === 0}
								class:bg-[var(--bg-2)]={i > 0}
								class:text-[var(--text-soft)]={i > 0}
							>
								{i + 1}
							</div>
							<div class="flex-1">
								<p class="text-sm font-medium">
									{providerDisplayName(item.provider)}
								</p>
								<p class="mono subtle text-xs">{item.name}</p>
							</div>
							<span class={i === 0 ? 'badge badge-ok' : 'badge badge-neutral'}>
								{i === 0 ? 'Primary' : 'Failover'}
							</span>
						</div>
						{#if i < readyItems.length - 1}
							<div class="flex justify-center">
								<svg
									class="h-4 w-4 text-[var(--text-soft)]"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									stroke-width="2"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										d="M19 14l-7 7m0 0l-7-7m7 7V3"
									/>
								</svg>
							</div>
						{/if}
					{/each}
				{/if}
			</div>

			{#if notReadyItems.length > 0 && readyItems.length > 0}
				<div class="divider-labeled mt-4">Available to add</div>
				<div class="mt-3 flex flex-wrap gap-2">
					{#each notReadyItems as item}
						<span class="badge badge-neutral">
							{providerDisplayName(item.provider)} &mdash; not connected
						</span>
					{/each}
				</div>
			{/if}
		</article>
	{/if}
</div>

<!-- Runtime Tools (collapsed by default, less prominent) -->
<div class="mt-4">
	<details class="surface rounded-xl">
		<summary
			class="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold"
		>
			Runtime Tools
			<div class="flex gap-2">
				<span class={cliDetections?.claude.available ? 'badge badge-ok' : 'badge badge-neutral'}>
					Claude {cliDetections?.claude.available ? cliDetections.claude.version ?? '' : ''}
				</span>
				<span class={cliDetections?.codex.available ? 'badge badge-ok' : 'badge badge-neutral'}>
					Codex {cliDetections?.codex.available ? cliDetections.codex.version ?? '' : ''}
				</span>
			</div>
		</summary>
		<div class="border-t border-[var(--line)] px-4 py-3">
			<p class="subtle text-sm">
				Quick Connect handles runtime install and login automatically. Use this section only
				for manual runtime checks.
			</p>
			<div class="mt-3 flex flex-wrap gap-2">
				<button
					class="btn btn-neutral"
					disabled={busy}
					onclick={() => submit('detect_clis', {})}
				>
					Check Runtime
				</button>
				<button
					class="btn btn-neutral"
					disabled={busy}
					onclick={() => submit('install_missing_clis', {})}
				>
					Install Missing Runtime
				</button>
			</div>
		</div>
	</details>
</div>
