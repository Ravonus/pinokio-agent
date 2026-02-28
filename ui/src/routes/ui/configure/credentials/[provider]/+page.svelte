<script lang="ts">
	import { page } from '$app/state';
	import type { CredentialStatus, OAuthCliDetectionReport } from '$lib/ui/manager';
	import type { PageData } from './$types';
	import InputField from '$lib/components/InputField.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import { toast } from '$lib/components/Toast.svelte';

	type ProviderRoute = 'openai' | 'claude-api' | 'claude-code' | 'codex';
	type OAuthTool = 'claude' | 'codex';

	let { data } = $props<{ data: PageData }>();
	let status = $state<CredentialStatus[]>([]);
	let cliDetections = $state<OAuthCliDetectionReport | null>(null);
	let busy = $state(false);

	const providerParam = $derived(page.params.provider ?? 'openai');
	const providerIsValid = $derived(
		providerParam === 'openai' ||
			providerParam === 'claude-api' ||
			providerParam === 'claude-code' ||
			providerParam === 'codex'
	);
	const activeProvider = $derived<ProviderRoute>(
		providerParam === 'claude-api' ||
			providerParam === 'claude-code' ||
			providerParam === 'codex'
			? providerParam
			: 'openai'
	);

	$effect(() => {
		status = data.status;
		cliDetections = data.cliDetections;
	});

	async function refreshState() {
		const [statusRes, detectorsRes] = await Promise.all([
			fetch('/api/configure?view=status'),
			fetch('/api/configure?view=detectors')
		]);
		const [statusJson, detectorsJson] = await Promise.all([statusRes.json(), detectorsRes.json()]);
		if (!statusJson.ok) throw new Error(statusJson.error ?? 'failed to load status');
		if (!detectorsJson.ok) throw new Error(detectorsJson.error ?? 'failed to load runtime detectors');
		status = statusJson.data as CredentialStatus[];
		cliDetections = detectorsJson.data as OAuthCliDetectionReport;
	}

	async function submit(action: string, payload: Record<string, unknown>) {
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
			toast('Configuration updated', 'success');
			await refreshState();
		} catch (error) {
			toast(error instanceof Error ? error.message : String(error), 'danger');
		} finally {
			busy = false;
		}
	}

	function asString(fd: FormData, key: string): string {
		return String(fd.get(key) ?? '').trim();
	}

	async function onOpenAiSubmit(event: SubmitEvent) {
		event.preventDefault();
		const fd = new FormData(event.currentTarget as HTMLFormElement);
		await submit('openai', {
			apiKey: asString(fd, 'api_key'),
			credential: asString(fd, 'credential'),
			profile: asString(fd, 'profile'),
			layer: asString(fd, 'layer')
		});
	}

	async function onClaudeApiSubmit(event: SubmitEvent) {
		event.preventDefault();
		const fd = new FormData(event.currentTarget as HTMLFormElement);
		await submit('claude_api', {
			apiKey: asString(fd, 'api_key'),
			credential: asString(fd, 'credential'),
			profile: asString(fd, 'profile'),
			layer: asString(fd, 'layer')
		});
	}

	async function onClaudeCodeOAuthConnectSubmit(event: SubmitEvent) {
		event.preventDefault();
		const fd = new FormData(event.currentTarget as HTMLFormElement);
		await submit('claude_code_oauth_connect', {
			credential: asString(fd, 'credential'),
			profile: asString(fd, 'profile'),
			layer: asString(fd, 'layer'),
			oauthCommand: asString(fd, 'oauth_command')
		});
	}

	async function onClaudeCodeTokenSubmit(event: SubmitEvent) {
		event.preventDefault();
		const fd = new FormData(event.currentTarget as HTMLFormElement);
		const token = asString(fd, 'token');
		if (!token) {
			toast('Token is required', 'danger');
			return;
		}
		await submit('claude_code', {
			token,
			credential: asString(fd, 'credential') || 'claude_code_main',
			profile: asString(fd, 'profile') || 'claude_code',
			layer: asString(fd, 'layer') || 'claude_code'
		});
	}

	async function onCodexOAuthConnectSubmit(event: SubmitEvent) {
		event.preventDefault();
		const fd = new FormData(event.currentTarget as HTMLFormElement);
		await submit('codex_oauth_connect', {
			credential: asString(fd, 'credential'),
			profile: asString(fd, 'profile'),
			layer: asString(fd, 'layer'),
			oauthCommand: asString(fd, 'oauth_command')
		});
	}

	async function onCodexTokenSubmit(event: SubmitEvent) {
		event.preventDefault();
		const fd = new FormData(event.currentTarget as HTMLFormElement);
		const token = asString(fd, 'token');
		if (!token) {
			toast('Token is required', 'danger');
			return;
		}
		await submit('codex', {
			token,
			credential: asString(fd, 'credential') || 'codex_main',
			profile: asString(fd, 'profile') || 'codex',
			layer: asString(fd, 'layer') || 'openai_codex'
		});
	}

	async function onInstallCli(tool: OAuthTool) {
		await submit('install_cli', { tool });
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

	function providerTabClass(provider: ProviderRoute): string {
		return activeProvider === provider ? 'btn btn-soft' : 'btn btn-neutral';
	}

	function credentialName(provider: ProviderRoute): string {
		switch (provider) {
			case 'openai':
				return 'openai_main';
			case 'claude-api':
				return 'claude_api_main';
			case 'claude-code':
				return 'claude_code_main';
			case 'codex':
				return 'codex_main';
		}
	}

	const activeCredential = $derived(
		status.find((item) => item.name === credentialName(activeProvider)) ?? null
	);

	function tokenBadge(item: CredentialStatus | null): string {
		if (!item) return 'badge badge-neutral';
		return item.token_present || item.mode === 'oauth_cli' ? 'badge badge-ok' : 'badge badge-warn';
	}

	function tokenLabel(item: CredentialStatus | null): string {
		if (!item) return 'not configured';
		if (item.mode === 'oauth_cli') return 'oauth session';
		return item.token_present ? 'ready' : 'missing token';
	}

	function cliBadgeClass(available: boolean): string {
		return available ? 'badge badge-ok' : 'badge badge-danger';
	}

	function cliBadgeLabel(available: boolean, version: string | null | undefined): string {
		return available ? (version ?? 'installed') : 'not installed';
	}
</script>

<section class="surface p-5 md:p-6">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold">Provider Setup</h1>
			<p class="subtle mt-1 text-sm">
				Everything here runs in-app. No terminal steps required for users.
			</p>
		</div>
		<button class="btn btn-neutral" disabled={busy} onclick={() => refreshState()}>
			{#if busy}<LoadingSpinner size="sm" />{:else}Refresh{/if}
		</button>
	</div>

	<nav class="tab-row mt-4">
		<a class={providerTabClass('openai')} href="/ui/configure/credentials/openai">OpenAI</a>
		<a class={providerTabClass('claude-api')} href="/ui/configure/credentials/claude-api">
			Claude API
		</a>
		<a class={providerTabClass('claude-code')} href="/ui/configure/credentials/claude-code">
			Claude Code
		</a>
		<a class={providerTabClass('codex')} href="/ui/configure/credentials/codex">Codex</a>
	</nav>

	{#if busy}
		<div class="mt-4">
			<LoadingSpinner label="Processing..." />
		</div>
	{/if}
</section>

{#if !providerIsValid}
	<section class="surface mt-4 p-5">
		<h2 class="text-lg font-semibold">Unknown provider</h2>
		<p class="subtle mt-2 text-sm">Select a provider from the tabs above.</p>
		<a class="btn btn-primary mt-3" href="/ui/configure/credentials">Back to providers</a>
	</section>
{:else}
	<div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_1fr]">
		<article class="surface p-4 md:p-5">
			{#if activeProvider === 'openai'}
				<h2 class="text-lg font-semibold">OpenAI API Key</h2>
				<p class="subtle mt-1 text-sm">Required for OpenAI-compatible model profiles.</p>
				<form class="mt-4 space-y-4" onsubmit={onOpenAiSubmit}>
					<InputField
						name="api_key"
						label="API Key"
						type="password"
						placeholder="sk-..."
						required={true}
						help="Your OpenAI API key from platform.openai.com"
					/>
					<details class="surface-subtle rounded-lg border border-[var(--line)] p-3">
						<summary class="cursor-pointer text-sm font-medium">Advanced settings</summary>
						<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
							<InputField
								name="credential"
								label="Credential"
								value="openai_main"
								help="Internal credential ID"
							/>
							<InputField
								name="profile"
								label="Profile"
								value="default"
								help="LLM profile name"
							/>
							<InputField
								name="layer"
								label="API Layer"
								value="openai_codex"
								help="API layer target"
							/>
						</div>
					</details>
					<button class="btn btn-primary" disabled={busy}>Save OpenAI Key</button>
				</form>
			{:else if activeProvider === 'claude-api'}
				<h2 class="text-lg font-semibold">Claude API Key</h2>
				<p class="subtle mt-1 text-sm">Direct Anthropic API auth without runtime tools.</p>
				<form class="mt-4 space-y-4" onsubmit={onClaudeApiSubmit}>
					<InputField
						name="api_key"
						label="API Key"
						type="password"
						placeholder="sk-ant-..."
						required={true}
						help="Your Anthropic API key from console.anthropic.com"
					/>
					<details class="surface-subtle rounded-lg border border-[var(--line)] p-3">
						<summary class="cursor-pointer text-sm font-medium">Advanced settings</summary>
						<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
							<InputField
								name="credential"
								label="Credential"
								value="claude_api_main"
								help="Internal credential ID"
							/>
							<InputField
								name="profile"
								value="claude"
								label="Profile"
								help="LLM profile name"
							/>
							<InputField
								name="layer"
								label="API Layer"
								value="claude_api"
								help="API layer target"
							/>
						</div>
					</details>
					<button class="btn btn-primary" disabled={busy}>Save Claude API Key</button>
				</form>
			{:else if activeProvider === 'claude-code'}
				<h2 class="text-lg font-semibold">Claude Code</h2>
				<p class="subtle mt-1 text-sm">
					Use one click to install runtime tools (if missing), start login, and save credentials.
				</p>

				<div class="mt-4 rounded-xl border border-[var(--line)] p-3">
					<div class="flex flex-wrap items-center gap-2">
						<span class={cliBadgeClass(cliDetections?.claude.available ?? false)}>
							Runtime: {cliBadgeLabel(
								cliDetections?.claude.available ?? false,
								cliDetections?.claude.version
							)}
						</span>
						<span class={tokenBadge(activeCredential)}>{tokenLabel(activeCredential)}</span>
					</div>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn btn-neutral" disabled={busy} onclick={() => submit('detect_clis', {})}>
							Detect Runtime
						</button>
						<button class="btn btn-neutral" disabled={busy} onclick={() => onInstallCli('claude')}>
							Install Runtime
						</button>
						<button class="btn btn-primary" disabled={busy} onclick={() => onQuickConnectClaudeCode()}>
							Install + Connect
						</button>
					</div>
				</div>

				<details class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<summary class="cursor-pointer text-sm font-medium">Paste token manually</summary>
					<p class="subtle mt-2 text-sm">
						If the automatic OAuth flow doesn't work, run
						<code class="mono">claude auth token</code> in your terminal and paste the token here.
					</p>
					<form class="mt-3 space-y-3" onsubmit={onClaudeCodeTokenSubmit}>
						<InputField
							name="token"
							label="Token"
							type="password"
							placeholder="Paste your Claude Code token"
							required={true}
						/>
						<input type="hidden" name="credential" value="claude_code_main" />
						<input type="hidden" name="profile" value="claude_code" />
						<input type="hidden" name="layer" value="claude_code" />
						<button class="btn btn-primary" disabled={busy}>Save Token</button>
					</form>
				</details>

				<details class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<summary class="cursor-pointer text-sm font-medium">Advanced connection overrides</summary>
					<form class="mt-3 space-y-3" onsubmit={onClaudeCodeOAuthConnectSubmit}>
						<InputField name="credential" label="Credential" value="claude_code_main" />
						<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
							<InputField name="profile" label="Profile" value="claude_code" />
							<InputField name="layer" label="API Layer" value="claude_code" />
						</div>
						<InputField
							name="oauth_command"
							label="OAuth Command"
							value={cliDetections?.claude.oauth_command ?? 'claude auth token --json'}
						/>
						<button class="btn btn-neutral" disabled={busy}>Connect with Overrides</button>
					</form>
				</details>
			{:else}
				<h2 class="text-lg font-semibold">Codex</h2>
				<p class="subtle mt-1 text-sm">
					Use one click to install Codex (if missing), run device auth, and save credentials.
				</p>

				<div class="mt-4 rounded-xl border border-[var(--line)] p-3">
					<div class="flex flex-wrap items-center gap-2">
						<span class={cliBadgeClass(cliDetections?.codex.available ?? false)}>
							Runtime: {cliBadgeLabel(
								cliDetections?.codex.available ?? false,
								cliDetections?.codex.version
							)}
						</span>
						<span class={tokenBadge(activeCredential)}>{tokenLabel(activeCredential)}</span>
					</div>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn btn-neutral" disabled={busy} onclick={() => submit('detect_clis', {})}>
							Detect Runtime
						</button>
						<button class="btn btn-neutral" disabled={busy} onclick={() => onInstallCli('codex')}>
							Install Runtime
						</button>
						<button class="btn btn-primary" disabled={busy} onclick={() => onQuickConnectCodex()}>
							Install + Connect
						</button>
					</div>
				</div>

				<details class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<summary class="cursor-pointer text-sm font-medium">Paste token manually</summary>
					<p class="subtle mt-2 text-sm">
						If the automatic device auth doesn't work, paste your OpenAI API token here.
					</p>
					<form class="mt-3 space-y-3" onsubmit={onCodexTokenSubmit}>
						<InputField
							name="token"
							label="Token"
							type="password"
							placeholder="Paste your Codex / OpenAI token"
							required={true}
						/>
						<input type="hidden" name="credential" value="codex_main" />
						<input type="hidden" name="profile" value="codex" />
						<input type="hidden" name="layer" value="openai_codex" />
						<button class="btn btn-primary" disabled={busy}>Save Token</button>
					</form>
				</details>

				<details class="surface-subtle mt-4 rounded-xl border border-[var(--line)] p-3">
					<summary class="cursor-pointer text-sm font-medium">Advanced connection overrides</summary>
					<form class="mt-3 space-y-3" onsubmit={onCodexOAuthConnectSubmit}>
						<InputField name="credential" label="Credential" value="codex_main" />
						<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
							<InputField name="profile" label="Profile" value="codex" />
							<InputField name="layer" label="API Layer" value="openai_codex" />
						</div>
						<InputField
							name="oauth_command"
							label="OAuth Command"
							value={cliDetections?.codex.oauth_command ?? 'codex login --device-auth'}
						/>
						<button class="btn btn-neutral" disabled={busy}>Connect with Overrides</button>
					</form>
				</details>
			{/if}
		</article>

		<div class="space-y-4">
			<article class="surface p-4 md:p-5">
				<h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--text-soft)]">
					Credential Status
				</h2>
				{#if activeCredential}
					<div class="mt-3 space-y-2">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="font-semibold">{activeCredential.name}</p>
							<span class={tokenBadge(activeCredential)}>{tokenLabel(activeCredential)}</span>
						</div>
						<p class="mono subtle text-xs">
							{activeCredential.provider} &middot; {activeCredential.mode}
						</p>
						<p class="mono subtle text-xs">
							source: {activeCredential.source ?? 'no source'}
						</p>
					</div>
				{:else}
					<div class="mt-3 space-y-2">
						<p class="subtle text-sm">Not configured yet.</p>
						<span class={tokenBadge(null)}>{tokenLabel(null)}</span>
					</div>
				{/if}
			</article>
		</div>
	</div>
{/if}
