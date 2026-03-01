import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseUiModel, type UiModel, type UiTone } from './model';
import { listPublishedPages } from './published-pages';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5000;

interface ProbeResult {
	label: string;
	value: string;
	detail: string;
	tone: UiTone;
}

const CONFIG_SUMMARY_KEYS = [
	'auth.enabled',
	'auth.required',
	'orchestrator.backend',
	'orchestrator.enabled',
	'orchestrator.default_image',
	'playwright.managed_by_rust',
	'playwright.host_service_command',
	'manager.child_spawn_enabled',
	'manager.hook_extensions_enabled',
	'marketplace.enabled'
] as const;

export async function resolveWorkspaceRoot(): Promise<string> {
	const candidates = [process.cwd(), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')];
	for (const candidate of candidates) {
		if (await pathExists(join(candidate, 'config', 'agent.toml'))) {
			return candidate;
		}
	}
	return resolve(process.cwd(), '..');
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function firstLine(value: string): string {
	const line = value.trim().split('\n')[0] ?? '';
	if (line.length <= 140) {
		return line;
	}
	return `${line.slice(0, 137)}...`;
}

function formatExecError(error: unknown): string {
	if (!error || typeof error !== 'object') {
		return 'not available';
	}
	const maybeError = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
	if (typeof maybeError.stderr === 'string' && maybeError.stderr.trim().length > 0) {
		return firstLine(maybeError.stderr);
	}
	if (typeof maybeError.stdout === 'string' && maybeError.stdout.trim().length > 0) {
		return firstLine(maybeError.stdout);
	}
	if (typeof maybeError.code === 'string') {
		return maybeError.code;
	}
	if (typeof maybeError.message === 'string') {
		return firstLine(maybeError.message);
	}
	return 'not available';
}

async function probeCommand(label: string, command: string, args: string[]): Promise<ProbeResult> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { timeout: PROBE_TIMEOUT_MS });
		const output = firstLine(stdout || stderr || 'ok');
		return {
			label,
			value: 'ready',
			detail: output || 'ok',
			tone: 'success'
		};
	} catch (error) {
		return {
			label,
			value: 'check',
			detail: formatExecError(error),
			tone: 'warning'
		};
	}
}

async function probeFile(label: string, path: string, root: string): Promise<ProbeResult> {
	if (await pathExists(path)) {
		return {
			label,
			value: 'present',
			detail: relative(root, path),
			tone: 'success'
		};
	}
	return {
		label,
		value: 'missing',
		detail: relative(root, path),
		tone: 'warning'
	};
}

function parseTomlMap(content: string): Map<string, string> {
	const map = new Map<string, string>();
	let section = '';
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const sectionMatch = line.match(/^\[([^\]]+)\]$/);
		if (sectionMatch) {
			section = sectionMatch[1];
			continue;
		}
		const keyValueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
		if (!keyValueMatch) {
			continue;
		}
		const key = keyValueMatch[1];
		const value = normalizeTomlValue(keyValueMatch[2]);
		const compoundKey = section ? `${section}.${key}` : key;
		map.set(compoundKey, value);
	}
	return map;
}

function normalizeTomlValue(raw: string): string {
	const cleaned = raw.replace(/\s+#.*$/, '').trim();
	if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
		return cleaned.slice(1, -1);
	}
	return cleaned;
}

async function readConfigContent(root: string): Promise<string> {
	const configPath = join(root, 'config', 'agent.toml');
	try {
		return await readFile(configPath, 'utf8');
	} catch {
		return '';
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function timeLabel(value: number): string {
	if (!value) {
		return 'unknown';
	}
	return new Date(value).toLocaleString();
}

export async function buildHealthModel(): Promise<UiModel> {
	const root = await resolveWorkspaceRoot();
	const configPath = join(root, 'config', 'agent.toml');
	const binaryPath = join(root, 'target', 'debug', 'pinokio-agent');
	const playwrightWorkerPath = join(root, 'workers', 'playwright-service.ts');

	const [cargoProbe, rustcProbe, nodeProbe, npmProbe, dockerProbe, configProbe, binaryProbe, playwrightProbe] =
		await Promise.all([
			probeCommand('Cargo', 'cargo', ['--version']),
			probeCommand('Rustc', 'rustc', ['--version']),
			probeCommand('Node.js', 'node', ['--version']),
			probeCommand('NPM', 'npm', ['--version']),
			probeCommand('Docker', 'docker', ['version', '--format', '{{.Server.Version}}']),
			probeFile('Config file', configPath, root),
			probeFile('Rust manager binary', binaryPath, root),
			probeFile('Playwright worker', playwrightWorkerPath, root)
		]);

	const model = {
		id: 'health',
		title: 'Pinokio Runtime Health',
		subtitle: 'Fast checks for manager, runtime, and browser worker readiness.',
		refreshedAt: nowIso(),
		sections: [
			{
				id: 'runtime',
				title: 'Runtime probes',
				description: 'These checks run locally from the UI server process.',
				blocks: [
					{
						type: 'stats',
						items: [
							cargoProbe,
							rustcProbe,
							nodeProbe,
							npmProbe,
							dockerProbe,
							configProbe,
							binaryProbe,
							playwrightProbe
						].map((probe) => ({
							label: probe.label,
							value: probe.value,
							detail: probe.detail,
							tone: probe.tone
						}))
					},
					{
						type: 'notice',
						tone: 'neutral',
						message: 'Health checks are read-only and safe to run repeatedly.',
						detail: 'Use fragment endpoints for live updates without full page reloads.'
					}
				]
			},
			{
				id: 'quick-actions',
				title: 'Quick actions',
				blocks: [
					{
						type: 'actions',
						items: [
							{
								label: 'View config model',
								href: '/api/ui-model?view=config',
								description: 'See parsed config summary as JSON.',
								method: 'GET',
								tone: 'neutral'
							},
							{
								label: 'Refresh health model',
								href: '/api/ui-model?view=health',
								description: 'Fetch latest health model payload.',
								method: 'GET',
								tone: 'success'
							}
						]
					}
				]
			}
		]
	};

	return parseUiModel(model);
}

export async function buildConfigModel(): Promise<UiModel> {
	const root = await resolveWorkspaceRoot();
	const configContent = await readConfigContent(root);
	const parsed = parseTomlMap(configContent);
	const summaryItems = CONFIG_SUMMARY_KEYS.map((key) => {
		const value = parsed.get(key);
		return {
			key,
			value: value ?? 'not set',
			tone: value ? 'neutral' : 'warning'
		};
	});

	const snippet = configContent
		.split('\n')
		.slice(0, 80)
		.join('\n')
		.trim();

	const model = {
		id: 'config',
		title: 'Pinokio Config View',
		subtitle: 'Curated config values that agents can reason about deterministically.',
		refreshedAt: nowIso(),
		sections: [
			{
				id: 'summary',
				title: 'Config summary',
				description: 'Parsed from config/agent.toml using a strict key allowlist.',
				blocks: [
					{
						type: 'key_values',
						items: summaryItems
					}
				]
			},
			{
				id: 'raw-snapshot',
				title: 'Raw snapshot',
				description: 'Lightweight preview to help debugging without opening files manually.',
				blocks: [
					{
						type: 'code',
						title: 'config/agent.toml (first 80 lines)',
						language: 'toml',
						code: snippet || '# config/agent.toml not found'
					}
				]
			},
			{
				id: 'actions',
				title: 'Actions',
				blocks: [
					{
						type: 'actions',
						items: [
							{
								label: 'Health JSON',
								href: '/api/ui-model?view=health',
								description: 'Compare runtime probes with config state.',
								method: 'GET',
								tone: 'neutral'
							},
							{
								label: 'Config JSON',
								href: '/api/ui-model?view=config',
								description: 'Download the structured config model.',
								method: 'GET',
								tone: 'success'
							}
						]
					}
				]
			}
		]
	};

	return parseUiModel(model);
}

export async function buildAppsModel(): Promise<UiModel> {
	const pages = await listPublishedPages();

	const model =
		pages.length === 0
			? {
					id: 'apps',
					title: 'Configuration Pages',
					subtitle:
						'Agents can publish full UI pages through manager output; this view lists what is currently available.',
					refreshedAt: nowIso(),
					sections: [
						{
							id: 'empty',
							title: 'No published pages',
							blocks: [
								{
									type: 'notice',
									tone: 'neutral',
									message:
										'No agent pages found yet. Run a task that returns `ui_page` or `ui_pages` in agent result JSON.'
								}
							]
						}
					]
				}
			: {
					id: 'apps',
					title: 'Configuration Pages',
					subtitle:
						'Published by agents/plugins/connections and rendered by the shared model-driven UI framework.',
					refreshedAt: nowIso(),
					sections: [
						{
							id: 'catalog',
							title: 'Published catalog',
							blocks: [
								{
									type: 'table',
									columns: ['id', 'title', 'source', 'updated', 'route'],
									rows: pages.map((page) => ({
										id: page.id,
										title: page.title,
										source: page.sourceLabel,
										updated: timeLabel(page.updatedAtMs),
										route: page.route
									}))
								}
							]
						},
						{
							id: 'open',
							title: 'Open pages',
							blocks: [
								{
									type: 'actions',
									items: pages.slice(0, 16).map((page) => ({
										label: page.title,
										href: page.route,
										description: `${page.id} (${page.sourceLabel})`,
										method: 'GET' as const,
										tone: 'neutral' as const
									}))
								}
							]
						}
					]
				};

	return parseUiModel(model);
}
