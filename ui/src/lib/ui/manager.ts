import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveWorkspaceRoot } from '$lib/ui/runtime';

const COMMAND_TIMEOUT_MS = 120_000;
const TASK_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 900_000;
const LOGIN_TIMEOUT_MS = 300_000;

type ConfigureAction =
	| 'openai'
	| 'claude_api'
	| 'claude_code'
	| 'codex'
	| 'login'
	| 'skills'
	| 'skill_add'
	| 'skill_remove'
	| 'detect_clis'
	| 'install_cli'
	| 'install_missing_clis'
	| 'claude_code_oauth_connect'
	| 'codex_oauth_connect'
	| 'doctor'
	| 'status'
	| 'manager_policy_status'
	| 'manager_policy_set'
	| 'services'
	| 'service_ensure'
	| 'package_ledger_scopes'
	| 'package_ledger_events'
	| 'plugin_catalog'
	| 'plugin_preview'
	| 'plugin_install'
	| 'plugin_remove'
	| 'extensions'
	| 'extension_add'
	| 'extension_remove';

interface CommandPlan {
	command: string;
	prefixArgs: string[];
	root: string;
}

export interface UiExtensionSurface {
	kind: 'core' | 'plugins' | 'agents' | 'systems';
	name: string;
	slot?: 'navigation' | 'settings' | 'page';
	title?: string;
	detail: string;
	route?: string | null;
	order?: number;
	source?: string;
	enabled?: boolean;
}

export interface CredentialStatus {
	name: string;
	provider: string;
	mode: string;
	configured: boolean;
	token_present: boolean;
	source: string | null;
	session_path: string;
	login_supported: boolean;
}

export interface ConfigureDoctorReport {
	ok: boolean;
	credentials: CredentialStatus[];
	profile_errors: string[];
}

export interface ManagedServiceStatus {
	name: string;
	enabled: boolean;
	image: string;
	container_name: string;
	exists: boolean;
	running: boolean;
	health: string | null;
	host_ports: string[];
	internal_port: number | null;
	networks: string[];
	aliases: string[];
}

export interface OAuthCliStatus {
	name: 'claude' | 'codex';
	command: string;
	available: boolean;
	version: string | null;
	path: string | null;
	oauth_command: string;
	install_command: string;
	last_error: string | null;
}

export interface OAuthCliDetectionReport {
	checked_at: string;
	claude: OAuthCliStatus;
	codex: OAuthCliStatus;
}

export interface ManagerPolicyStatus {
	ok: boolean;
	config_path: string;
	changed: boolean;
	policy: {
		child_spawn_enabled: boolean;
		child_spawn_container_only: boolean;
		unsafe_host_communication_enabled: boolean;
		hook_extensions_enabled: boolean;
		hook_extensions_container_only: boolean;
		socket_bus_enabled?: boolean;
		socket_bus_container_only?: boolean;
		socket_bus_max_channel_messages?: number;
		container_package_installs_enabled?: boolean;
	};
}

export interface PackageLedgerScopeRecord {
	scope_key: string;
	scope_dir: string;
	resource: string;
	agent_id: string;
	manager: string;
	packages: string[];
	updated_at: string;
	last_action: string;
}

export interface PackageLedgerEventRecord {
	id: number;
	created_at: string;
	task_id: string;
	task_summary: string;
	action: string;
	manager: string;
	packages: string[];
	scope_key: string;
	scope_dir: string;
	resource: string;
	agent_id: string;
	applied: boolean;
	details: Record<string, unknown>;
}

export interface PluginManifestRequires {
	manifests: string[];
	plugins: string[];
	services: string[];
}

export interface PluginManifestRuntime {
	mode: string;
	requires_container: boolean;
	unsafe_host_access: boolean;
}

export interface PluginInstallCommandSummary {
	id: string;
	scope: string;
	command: string;
	description: string;
	dangerous: boolean;
}

export interface PluginManifestInstallPlan {
	summary: string;
	commands: PluginInstallCommandSummary[];
}

export interface PluginManifestSummary {
	id: string;
	name: string;
	version: string;
	description: string;
	readme?: string | null;
	manifest_path: string;
	manifest_format: string;
	requires: PluginManifestRequires;
	runtime: PluginManifestRuntime;
	extends: {
		agents: string[];
		containers: string[];
		navigation: string[];
		settings: string[];
		pages: string[];
		resources: string[];
		hooks: string[];
	};
	plugin_count: number;
	ui_extension_count: number;
	service_count: number;
	skill_count: number;
	resource_network_count: number;
	hook_extension_count: number;
	install: PluginManifestInstallPlan;
	installed: boolean;
}

export interface PluginPermissionSummary {
	name: string;
	host_only: boolean;
	managed_only: boolean;
	allowed_actions: string[];
	dependencies: string[];
	resolved_permissions: {
		create: boolean;
		read: boolean;
		update: boolean;
		delete: boolean;
		spawn_child: boolean;
		hook_extensions: boolean;
		network: boolean;
		filesystem_read: boolean;
		filesystem_write: boolean;
		exec: boolean;
		memory_read: boolean;
		memory_write: boolean;
		playwright: boolean;
	};
	risk_flags: string[];
}

export interface PluginInstallPreview {
	manifest: PluginManifestSummary;
	plugins: PluginPermissionSummary[];
	ui_extensions: string[];
	services: string[];
	skills: {
		name: string;
		description: string;
		path: string;
		install_command: string | null;
		targets: SkillTarget;
		tags: string[];
		enabled: boolean;
	}[];
	resource_networks: string[];
	hook_extensions: string[];
	install_commands: PluginInstallCommandSummary[];
	missing_dependencies: string[];
	conflicts: string[];
	adoptable_conflicts: string[];
	blocking_conflicts: string[];
	warnings: string[];
	can_install: boolean;
}

export interface PluginCatalogReport {
	manifest_dirs: string[];
	manifests: PluginManifestSummary[];
	parse_errors: string[];
	installed_manifests: string[];
	configured_plugins: ConfiguredPluginSummary[];
}

export interface ConfiguredPluginSummary {
	name: string;
	command: string;
	host_only: boolean;
	managed_only: boolean;
	allowed_actions: string[];
	dependencies: string[];
	resolved_permissions: PluginPermissionSummary['resolved_permissions'];
	risk_flags: string[];
	manifest_owner: string | null;
}

export interface PluginInstallResult {
	ok: boolean;
	config_path: string;
	result: {
		ok: boolean;
		manifest_id: string;
		manifest_name: string;
		installed_plugins: string[];
		installed_ui_extensions: string[];
		installed_services: string[];
		installed_skills: string[];
		installed_resource_networks: string[];
		installed_hook_extensions: string[];
		install_command_results: {
			id: string;
			scope: string;
			command: string;
			ok: boolean;
			output: string;
		}[];
		preview: PluginInstallPreview;
	};
}

export interface PluginRemoveResult {
	ok: boolean;
	config_path: string;
	result: {
		ok: boolean;
		manifest_id: string;
		removed_plugins: string[];
		removed_ui_extensions: string[];
		removed_services: string[];
		removed_skills: string[];
		removed_resource_networks: string[];
		removed_hook_extensions: string[];
	};
}

export interface SkillTarget {
	plugins: string[];
	resources: string[];
	agents: string[];
	actions: string[];
}

export interface SkillSummary {
	name: string;
	description: string;
	path: string;
	install_command: string | null;
	targets: SkillTarget;
	tags: string[];
	enabled: boolean;
	source: string;
}

type CliToolName = 'claude' | 'codex';

interface CliInstallPlan {
	tool: CliToolName;
	command: string;
	args: string[];
	displayCommand: string;
}

interface OAuthCliToolDefinition {
	tool: CliToolName;
	commandName: string;
	defaultOauthCommand: string;
	oauthCommandWithPath: (quotedPath: string) => string;
	loginCommandWithPath: (quotedPath: string) => string;
	fallbackPaths: (ctx: { home: string; userProfile: string }) => string[];
	installPlan: (platform: NodeJS.Platform) => CliInstallPlan;
	windowsInstallFallbackPlan?: CliInstallPlan;
}

const OAUTH_CLI_TOOL_DEFS: Record<CliToolName, OAuthCliToolDefinition> = {
	codex: {
		tool: 'codex',
		commandName: 'codex',
		defaultOauthCommand: 'codex login --device-auth',
		oauthCommandWithPath: (quotedPath) => `${quotedPath} login --device-auth`,
		loginCommandWithPath: (quotedPath) => `${quotedPath} login --device-auth`,
		fallbackPaths: ({ home, userProfile }) => [
			join(home, '.local', 'bin', 'codex'),
			join(home, 'bin', 'codex'),
			'/usr/local/bin/codex',
			'/opt/homebrew/bin/codex',
			'/usr/bin/codex',
			'/Applications/Codex.app/Contents/Resources/codex',
			join(userProfile, 'AppData', 'Roaming', 'npm', 'codex.cmd')
		],
		installPlan: () => ({
			tool: 'codex',
			command: 'npm',
			args: ['install', '-g', '@openai/codex@latest'],
			displayCommand: 'npm install -g @openai/codex@latest'
		})
	},
	claude: {
		tool: 'claude',
		commandName: 'claude',
		defaultOauthCommand: 'claude auth token --json',
		oauthCommandWithPath: (quotedPath) => `${quotedPath} auth token --json`,
		loginCommandWithPath: (quotedPath) => `${quotedPath} auth login`,
		fallbackPaths: ({ home, userProfile }) => [
			join(home, '.local', 'bin', 'claude'),
			join(home, 'bin', 'claude'),
			'/usr/local/bin/claude',
			'/opt/homebrew/bin/claude',
			'/usr/bin/claude',
			join(userProfile, 'AppData', 'Roaming', 'npm', 'claude.cmd')
		],
		installPlan: (platform) =>
			platform === 'win32'
				? {
						tool: 'claude',
						command: 'powershell',
						args: [
							'-NoProfile',
							'-ExecutionPolicy',
							'Bypass',
							'-Command',
							'irm https://claude.ai/install.ps1 | iex'
						],
						displayCommand: 'irm https://claude.ai/install.ps1 | iex'
					}
				: {
						tool: 'claude',
						command: 'sh',
						args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'],
						displayCommand: 'curl -fsSL https://claude.ai/install.sh | bash'
					},
		windowsInstallFallbackPlan: {
			tool: 'claude',
			command: 'cmd',
			args: ['/c', 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd'],
			displayCommand: 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd'
		}
	}
};

export interface OAuthCliInstallResult {
	tool: CliToolName;
	platform: NodeJS.Platform;
	already_available: boolean;
	attempted_install: boolean;
	install_command: string;
	post_install_available: boolean;
	post_install_version: string | null;
	path: string | null;
	output: string;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveCommandPlan(): Promise<CommandPlan> {
	const root = await resolveWorkspaceRoot();
	const explicit = process.env.PINOKIO_APP_COMMAND?.trim();
	if (explicit) {
		return { command: explicit, prefixArgs: [], root };
	}

	const debugBinary = join(root, 'target', 'debug', 'pinokio-agent');
	if (await pathExists(debugBinary)) {
		return { command: debugBinary, prefixArgs: [], root };
	}

	return { command: 'cargo', prefixArgs: ['run', '--'], root };
}

function extractJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error('no output from configure command');
	}
	const firstObject = trimmed.indexOf('{');
	const firstArray = trimmed.indexOf('[');

	let start = -1;
	if (firstObject === -1) {
		start = firstArray;
	} else if (firstArray === -1) {
		start = firstObject;
	} else {
		start = Math.min(firstObject, firstArray);
	}

	if (start < 0) {
		throw new Error(`configure command did not return JSON: ${trimmed.slice(0, 160)}`);
	}
	return JSON.parse(trimmed.slice(start));
}

async function runCommand(args: string[], stdinInput?: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<unknown> {
	const plan = await resolveCommandPlan();
	const fullArgs = [...plan.prefixArgs, ...args];

	return new Promise<unknown>((resolve, reject) => {
		const child = spawn(plan.command, fullArgs, {
			cwd: plan.root,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: process.env
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | null = null;
		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = null;
			}
			reject(error);
		};
		const finishResolve = (value: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = null;
			}
			resolve(value);
		};
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
			forceKillTimer = setTimeout(() => {
				if (!settled) {
					child.kill('SIGKILL');
				}
			}, 3_000);
			const detail = stderr.trim() || stdout.trim();
			const suffix = detail ? `: ${detail.slice(0, 240)}` : '';
			finishReject(new Error(`manager command timed out after ${timeoutMs}ms${suffix}`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			finishReject(error instanceof Error ? error : new Error(String(error)));
		});
		child.on('close', (code) => {
			if (settled) return;
			if (code !== 0) {
				finishReject(
					new Error(
						`manager command failed (${code}): ${stderr.trim() || stdout.trim() || 'unknown'}`
					)
				);
				return;
			}

			try {
				const parsed = extractJson(stdout);
				finishResolve(parsed);
			} catch (error) {
				finishReject(error instanceof Error ? error : new Error(String(error)));
			}
		});

		if (stdinInput !== undefined) {
			child.stdin.write(stdinInput);
		}
		child.stdin.end();
	});
}

interface RawCommandResult {
	started: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	error: string | null;
}

async function runRawCommand(command: string, args: string[], timeoutMs: number = 12_000): Promise<RawCommandResult> {
	return new Promise<RawCommandResult>((resolve) => {
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env
		});

		let stdout = '';
		let stderr = '';
		let started = true;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | null = null;
		const finish = (result: RawCommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = null;
			}
			resolve(result);
		};
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
			forceKillTimer = setTimeout(() => {
				if (!settled) {
					child.kill('SIGKILL');
				}
			}, 3_000);
			finish({
				started,
				code: null,
				stdout,
				stderr,
				error: `timed out after ${timeoutMs}ms`
			});
		}, timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				started = false;
			}
			finish({
				started,
				code: null,
				stdout,
				stderr,
				error: error.message
			});
		});
		child.on('close', (code) => {
			finish({
				started,
				code,
				stdout,
				stderr,
				error: null
			});
		});
	});
}

async function runShellCommand(command: string, timeoutMs: number = COMMAND_TIMEOUT_MS): Promise<RawCommandResult> {
	if (process.platform === 'win32') {
		return runRawCommand('cmd', ['/d', '/s', '/c', command], timeoutMs);
	}
	return runRawCommand('sh', ['-lc', command], timeoutMs);
}

function firstNonEmptyLine(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUrls(text: string): string[] {
	const matches = text.match(/https?:\/\/[^\s"'<>`]+/g) ?? [];
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of matches) {
		if (!seen.has(match)) {
			seen.add(match);
			urls.push(match);
		}
	}
	return urls;
}

function parseOAuthToken(stdout: string): string | null {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return null;
	}

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const firstObject = trimmed.indexOf('{');
		const lastObject = trimmed.lastIndexOf('}');
		if (firstObject >= 0 && lastObject > firstObject) {
			try {
				parsed = JSON.parse(trimmed.slice(firstObject, lastObject + 1));
			} catch {
				parsed = null;
			}
		}
	}

	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		const obj = parsed as Record<string, unknown>;
		const tokenValue =
			typeof obj.token === 'string'
				? obj.token
				: typeof obj.access_token === 'string'
					? obj.access_token
					: typeof obj.accessToken === 'string'
						? obj.accessToken
						: typeof obj.api_key === 'string'
							? obj.api_key
							: typeof obj.apiKey === 'string'
								? obj.apiKey
								: null;
		if (tokenValue && tokenValue.trim().length > 0) {
			return tokenValue.trim();
		}
	}

	const firstLine = firstNonEmptyLine(trimmed);
	if (firstLine && !firstLine.includes(' ') && !firstLine.startsWith('{')) {
		return firstLine.trim();
	}
	return null;
}

function commandFromPath(path: string | null, tool: CliToolName): string {
	const def = OAUTH_CLI_TOOL_DEFS[tool];
	if (!path) {
		return def.commandName;
	}
	return shellQuote(path);
}

function oauthLoginCommandFromPath(path: string | null, tool: CliToolName): string {
	const def = OAUTH_CLI_TOOL_DEFS[tool];
	return def.loginCommandWithPath(commandFromPath(path, tool));
}

async function openUrlInBrowser(url: string): Promise<{
	attempted: boolean;
	ok: boolean;
	command: string;
	output: string;
}> {
	let command = '';
	let result: RawCommandResult;

	if (process.platform === 'darwin') {
		command = `open ${url}`;
		result = await runRawCommand('open', [url], 10_000);
	} else if (process.platform === 'win32') {
		command = `powershell Start-Process ${url}`;
		result = await runRawCommand(
			'powershell',
			['-NoProfile', '-Command', `Start-Process '${url.replaceAll("'", "''")}'`],
			10_000
		);
	} else {
		command = `xdg-open ${url}`;
		result = await runRawCommand('xdg-open', [url], 10_000);
	}

	return {
		attempted: true,
		ok: result.started && result.code === 0,
		command,
		output: summarizeRawOutput(result) || result.error || ''
	};
}

function shellQuote(value: string): string {
	if (process.platform === 'win32') {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function oauthCommandFromPath(path: string | null, tool: CliToolName): string {
	const def = OAUTH_CLI_TOOL_DEFS[tool];
	if (!path) {
		return def.defaultOauthCommand;
	}
	return def.oauthCommandWithPath(shellQuote(path));
}

function buildCliInstallPlan(tool: CliToolName): CliInstallPlan {
	return OAUTH_CLI_TOOL_DEFS[tool].installPlan(process.platform);
}

async function findFallbackCliPath(tool: CliToolName): Promise<string | null> {
	const def = OAUTH_CLI_TOOL_DEFS[tool];
	const home = process.env.HOME ?? '';
	const userProfile = process.env.USERPROFILE ?? '';
	const candidates = def
		.fallbackPaths({ home, userProfile })
		.map((value) => value.trim())
		.filter((value) => value.length > 0);

	for (const candidate of candidates) {
		if (!isAbsolute(candidate)) {
			continue;
		}
		if (await pathExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
	if (process.platform === 'win32') {
		const result = await runRawCommand('where', [command], 4_000);
		if (!result.started || result.code !== 0) {
			return null;
		}
		return firstNonEmptyLine(result.stdout);
	}

	const result = await runRawCommand('sh', ['-lc', `command -v ${command}`], 4_000);
	if (!result.started || result.code !== 0) {
		return null;
	}
	return firstNonEmptyLine(result.stdout);
}

async function detectOAuthCliTool(
	tool: CliToolName
): Promise<OAuthCliStatus> {
	const def = OAUTH_CLI_TOOL_DEFS[tool];
	const command = def.commandName;
	let versionAttempt = await runRawCommand(command, ['--version']);
	let available = versionAttempt.started;
	let combined = `${versionAttempt.stdout}\n${versionAttempt.stderr}`;
	let versionLine = firstNonEmptyLine(combined);
	let path = available ? await resolveCommandPath(command) : null;

	if (!path) {
		const fallbackPath = await findFallbackCliPath(tool);
		if (fallbackPath) {
			const fallbackAttempt = await runRawCommand(fallbackPath, ['--version']);
			if (fallbackAttempt.started && fallbackAttempt.code === 0) {
				available = true;
				versionAttempt = fallbackAttempt;
				combined = `${fallbackAttempt.stdout}\n${fallbackAttempt.stderr}`;
				versionLine = firstNonEmptyLine(combined);
				path = fallbackPath;
			}
		}
	}

	const installPlan = buildCliInstallPlan(tool);

	return {
		name: tool,
		command,
		available,
		version: versionLine,
		path,
		oauth_command: oauthCommandFromPath(path, tool) || def.defaultOauthCommand,
		install_command: installPlan.displayCommand,
		last_error: versionAttempt.error
	};
}

function summarizeRawOutput(result: RawCommandResult): string {
	const merged = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
	if (!merged) {
		return '';
	}
	const MAX_OUTPUT = 2_000;
	return merged.length > MAX_OUTPUT ? `${merged.slice(0, MAX_OUTPUT)}\n...` : merged;
}

async function detectSingleOAuthCli(tool: CliToolName): Promise<OAuthCliStatus> {
	return detectOAuthCliTool(tool);
}

function trimOrUndefined(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shouldRetryWithLegacyManifestFlag(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("unexpected argument '--plugin'");
}

export async function configureStatus(): Promise<CredentialStatus[]> {
	return (await runCommand(['configure', 'status'])) as CredentialStatus[];
}

export async function configureServices(): Promise<ManagedServiceStatus[]> {
	return (await runCommand(['configure', 'services'])) as ManagedServiceStatus[];
}

export async function configureEnsureServices(input?: {
	names?: string[];
}): Promise<ManagedServiceStatus[]> {
	const args = ['configure', 'service-ensure'];
	for (const name of input?.names ?? []) {
		const trimmed = trimOrUndefined(name);
		if (!trimmed) {
			continue;
		}
		args.push('--name', trimmed);
	}
	return (await runCommand(args)) as ManagedServiceStatus[];
}

export async function configurePackageLedgerScopes(input?: {
	limit?: number;
}): Promise<PackageLedgerScopeRecord[]> {
	const args = ['configure', 'package-ledger-scopes'];
	if (typeof input?.limit === 'number' && Number.isFinite(input.limit)) {
		args.push('--limit', String(Math.trunc(input.limit)));
	}
	return (await runCommand(args)) as PackageLedgerScopeRecord[];
}

export async function configurePackageLedgerEvents(input?: {
	scopeKey?: string;
	limit?: number;
}): Promise<PackageLedgerEventRecord[]> {
	const args = ['configure', 'package-ledger-events'];
	const scopeKey = trimOrUndefined(input?.scopeKey);
	if (scopeKey) {
		args.push('--scope-key', scopeKey);
	}
	if (typeof input?.limit === 'number' && Number.isFinite(input.limit)) {
		args.push('--limit', String(Math.trunc(input.limit)));
	}
	return (await runCommand(args)) as PackageLedgerEventRecord[];
}

export async function configureSkills(): Promise<SkillSummary[]> {
	return (await runCommand(['configure', 'skills'])) as SkillSummary[];
}

export async function configureSkillAdd(input: {
	name: string;
	description?: string;
	path?: string;
	installCommand?: string;
	plugins?: string[];
	resources?: string[];
	agents?: string[];
	actions?: string[];
	tags?: string[];
	enabled?: boolean;
	runInstall?: boolean;
}): Promise<unknown> {
	const name = trimOrUndefined(input.name);
	if (!name) {
		throw new Error('skill name is required');
	}
	const args = ['configure', 'skill-add', '--name', name];
	const description = trimOrUndefined(input.description);
	const path = trimOrUndefined(input.path);
	const installCommand = trimOrUndefined(input.installCommand);
	if (description !== undefined) {
		args.push('--description', description);
	}
	if (path !== undefined) {
		args.push('--path', path);
	}
	if (installCommand !== undefined) {
		args.push('--install-command', installCommand);
	}
	for (const plugin of input.plugins ?? []) {
		const value = trimOrUndefined(plugin);
		if (value) args.push('--plugin', value);
	}
	for (const resource of input.resources ?? []) {
		const value = trimOrUndefined(resource);
		if (value) args.push('--resource', value);
	}
	for (const agent of input.agents ?? []) {
		const value = trimOrUndefined(agent);
		if (value) args.push('--agent', value);
	}
	for (const action of input.actions ?? []) {
		const value = trimOrUndefined(action);
		if (value) args.push('--action', value);
	}
	for (const tag of input.tags ?? []) {
		const value = trimOrUndefined(tag);
		if (value) args.push('--tag', value);
	}
	if (typeof input.enabled === 'boolean') {
		args.push('--enabled', String(input.enabled));
	}
	if (input.runInstall === true) {
		args.push('--run-install');
	}
	return runCommand(args);
}

export async function configureSkillRemove(input: { name: string }): Promise<unknown> {
	const name = trimOrUndefined(input.name);
	if (!name) {
		throw new Error('skill name is required');
	}
	return runCommand(['configure', 'skill-remove', '--name', name]);
}

export async function configurePluginCatalog(): Promise<PluginCatalogReport> {
	return (await runCommand(['configure', 'plugin-catalog'])) as PluginCatalogReport;
}

export async function configurePluginPreview(input: {
	plugin?: string;
	manifest?: string;
}): Promise<PluginInstallPreview> {
	const plugin = trimOrUndefined(input.plugin ?? input.manifest);
	if (!plugin) {
		throw new Error('plugin is required');
	}
	try {
		return (await runCommand([
			'configure',
			'plugin-preview',
			'--plugin',
			plugin
		])) as PluginInstallPreview;
	} catch (error) {
		if (!shouldRetryWithLegacyManifestFlag(error)) {
			throw error;
		}
		return (await runCommand([
			'configure',
			'plugin-preview',
			'--manifest',
			plugin
		])) as PluginInstallPreview;
	}
}

export async function configurePluginInstall(input: {
	plugin?: string;
	manifest?: string;
	allowMissingDependencies?: boolean;
	adoptExisting?: boolean;
	skipInstallCommands?: boolean;
}): Promise<PluginInstallResult> {
	const plugin = trimOrUndefined(input.plugin ?? input.manifest);
	if (!plugin) {
		throw new Error('plugin is required');
	}
	const installArgs = ['configure', 'plugin-install', '--plugin', plugin];
	if (input.allowMissingDependencies === true) {
		installArgs.push('--allow-missing-dependencies');
	}
	if (input.adoptExisting === true) {
		installArgs.push('--adopt-existing');
	}
	if (input.skipInstallCommands === true) {
		installArgs.push('--skip-install-commands');
	}
	try {
		return (await runCommand(installArgs)) as PluginInstallResult;
	} catch (error) {
		if (!shouldRetryWithLegacyManifestFlag(error)) {
			throw error;
		}
		const legacyArgs = ['configure', 'plugin-install', '--manifest', plugin];
		if (input.allowMissingDependencies === true) {
			legacyArgs.push('--allow-missing-dependencies');
		}
		if (input.adoptExisting === true) {
			legacyArgs.push('--adopt-existing');
		}
		if (input.skipInstallCommands === true) {
			legacyArgs.push('--skip-install-commands');
		}
		return (await runCommand(legacyArgs)) as PluginInstallResult;
	}
}

export async function configurePluginRemove(input: {
	plugin?: string;
	manifest?: string;
}): Promise<PluginRemoveResult> {
	const plugin = trimOrUndefined(input.plugin ?? input.manifest);
	if (!plugin) {
		throw new Error('plugin is required');
	}
	try {
		return (await runCommand([
			'configure',
			'plugin-remove',
			'--plugin',
			plugin
		])) as PluginRemoveResult;
	} catch (error) {
		if (!shouldRetryWithLegacyManifestFlag(error)) {
			throw error;
		}
		return (await runCommand([
			'configure',
			'plugin-remove',
			'--manifest',
			plugin
		])) as PluginRemoveResult;
	}
}

export async function configureDoctor(): Promise<ConfigureDoctorReport> {
	return (await runCommand(['configure', 'doctor'])) as ConfigureDoctorReport;
}

export async function configureManagerPolicyStatus(): Promise<ManagerPolicyStatus> {
	return (await runCommand(['configure', 'manager-policy'])) as ManagerPolicyStatus;
}

export async function configureManagerPolicySet(input: {
	childSpawnEnabled?: boolean;
	childSpawnContainerOnly?: boolean;
	unsafeHostCommunicationEnabled?: boolean;
	socketBusEnabled?: boolean;
	socketBusContainerOnly?: boolean;
	socketBusMaxChannelMessages?: number;
	containerPackageInstallsEnabled?: boolean;
}): Promise<ManagerPolicyStatus> {
	const args = ['configure', 'manager-policy'];
	if (typeof input.childSpawnEnabled === 'boolean') {
		args.push('--child-spawn-enabled', String(input.childSpawnEnabled));
	}
	if (typeof input.childSpawnContainerOnly === 'boolean') {
		args.push('--child-spawn-container-only', String(input.childSpawnContainerOnly));
	}
	if (typeof input.unsafeHostCommunicationEnabled === 'boolean') {
		args.push(
			'--unsafe-host-communication-enabled',
			String(input.unsafeHostCommunicationEnabled)
		);
	}
	if (typeof input.socketBusEnabled === 'boolean') {
		args.push('--socket-bus-enabled', String(input.socketBusEnabled));
	}
	if (typeof input.socketBusContainerOnly === 'boolean') {
		args.push('--socket-bus-container-only', String(input.socketBusContainerOnly));
	}
	if (
		typeof input.socketBusMaxChannelMessages === 'number' &&
		Number.isFinite(input.socketBusMaxChannelMessages)
	) {
		args.push(
			'--socket-bus-max-channel-messages',
			String(Math.trunc(input.socketBusMaxChannelMessages))
		);
	}
	if (typeof input.containerPackageInstallsEnabled === 'boolean') {
		args.push(
			'--container-package-installs-enabled',
			String(input.containerPackageInstallsEnabled)
		);
	}
	return (await runCommand(args)) as ManagerPolicyStatus;
}

export async function configureOpenAi(input: {
	apiKey: string;
	credential?: string;
	profile?: string;
	layer?: string;
}): Promise<unknown> {
	const args = ['configure', 'openai'];
	const credential = trimOrUndefined(input.credential);
	const profile = trimOrUndefined(input.profile);
	const layer = trimOrUndefined(input.layer);
	if (credential) {
		args.push('--credential', credential);
	}
	if (profile) {
		args.push('--profile', profile);
	}
	if (layer) {
		args.push('--layer', layer);
	}
	const apiKey = input.apiKey.trim();
	if (!apiKey) {
		throw new Error('OpenAI API key is required');
	}
	return runCommand(args, `${apiKey}\n`);
}

export async function configureClaudeApi(input: {
	apiKey: string;
	credential?: string;
	profile?: string;
	layer?: string;
}): Promise<unknown> {
	const args = ['configure', 'claude-api'];
	const credential = trimOrUndefined(input.credential);
	const profile = trimOrUndefined(input.profile);
	const layer = trimOrUndefined(input.layer);
	if (credential) {
		args.push('--credential', credential);
	}
	if (profile) {
		args.push('--profile', profile);
	}
	if (layer) {
		args.push('--layer', layer);
	}
	const apiKey = input.apiKey.trim();
	if (!apiKey) {
		throw new Error('Claude API key is required');
	}
	return runCommand(args, `${apiKey}\n`);
}

export async function configureClaudeCode(input: {
	token?: string;
	oauthCommand?: string;
	credential?: string;
	profile?: string;
	layer?: string;
}): Promise<unknown> {
	const args = ['configure', 'claude-code'];
	const credential = trimOrUndefined(input.credential);
	const profile = trimOrUndefined(input.profile);
	const layer = trimOrUndefined(input.layer);
	const token = trimOrUndefined(input.token);
	const oauthCommand = trimOrUndefined(input.oauthCommand);

	if (credential) {
		args.push('--credential', credential);
	}
	if (profile) {
		args.push('--profile', profile);
	}
	if (layer) {
		args.push('--layer', layer);
	}
	if (token) {
		args.push('--token', token);
	}
	if (oauthCommand) {
		args.push('--oauth-command', oauthCommand);
	}

	return runCommand(args);
}

export async function configureCodex(input: {
	token?: string;
	oauthCommand?: string;
	credential?: string;
	profile?: string;
	layer?: string;
}): Promise<unknown> {
	const args = ['configure', 'codex'];
	const credential = trimOrUndefined(input.credential);
	const profile = trimOrUndefined(input.profile);
	const layer = trimOrUndefined(input.layer);
	const token = trimOrUndefined(input.token);
	const oauthCommand = trimOrUndefined(input.oauthCommand);

	if (credential) {
		args.push('--credential', credential);
	}
	if (profile) {
		args.push('--profile', profile);
	}
	if (layer) {
		args.push('--layer', layer);
	}
	if (token) {
		args.push('--token', token);
	}
	if (oauthCommand) {
		args.push('--oauth-command', oauthCommand);
	}

	return runCommand(args);
}

export async function configureLogin(input: { credential: string }): Promise<unknown> {
	const credential = trimOrUndefined(input.credential);
	if (!credential) {
		throw new Error('credential is required');
	}
	return runCommand(['configure', 'login', '--credential', credential]);
}

export async function detectOAuthCliTools(): Promise<OAuthCliDetectionReport> {
	const [claude, codex] = await Promise.all([
		detectSingleOAuthCli('claude'),
		detectSingleOAuthCli('codex')
	]);
	return {
		checked_at: new Date().toISOString(),
		claude,
		codex
	};
}

export async function installOAuthCli(input: {
	tool: CliToolName;
	force?: boolean;
}): Promise<OAuthCliInstallResult> {
	const before = await detectSingleOAuthCli(input.tool);
	const plan = buildCliInstallPlan(input.tool);

	let attemptedInstall = false;
	let output = '';

	if (!before.available || input.force === true) {
		attemptedInstall = true;
		let result = await runRawCommand(plan.command, plan.args, INSTALL_TIMEOUT_MS);
		output = summarizeRawOutput(result);

		const fallbackPlan = OAUTH_CLI_TOOL_DEFS[input.tool].windowsInstallFallbackPlan;
		if (process.platform === 'win32' && fallbackPlan && (!result.started || result.code !== 0)) {
			const cmdFallback = await runRawCommand(
				fallbackPlan.command,
				fallbackPlan.args,
				INSTALL_TIMEOUT_MS
			);
			const fallbackOutput = summarizeRawOutput(cmdFallback);
			result = cmdFallback;
			output = fallbackOutput || output;
		}

		if (!result.started) {
			throw new Error(
				`failed to start ${input.tool} install command (${plan.command}). ${result.error ?? ''}`.trim()
			);
		}
		if (result.code !== 0) {
			throw new Error(
				`${input.tool} install command failed: ${output || result.error || `exit code ${String(result.code)}`}`
			);
		}
	}

	const after = await detectSingleOAuthCli(input.tool);
	if (!after.available) {
		throw new Error(
			`${input.tool} install finished but runtime is still not callable in the current app shell. Reopen the app and run Detect Runtime again.`
		);
	}

	return {
		tool: input.tool,
		platform: process.platform,
		already_available: before.available,
		attempted_install: attemptedInstall,
		install_command: plan.displayCommand,
		post_install_available: after.available,
		post_install_version: after.version,
		path: after.path,
		output
	};
}

export async function installMissingOAuthCliTools(): Promise<{
	ok: true;
	platform: NodeJS.Platform;
	installed: OAuthCliInstallResult[];
	skipped: CliToolName[];
}> {
	const report = await detectOAuthCliTools();
	const missing: CliToolName[] = [];
	const skipped: CliToolName[] = [];

	if (report.claude.available) {
		skipped.push('claude');
	} else {
		missing.push('claude');
	}

	if (report.codex.available) {
		skipped.push('codex');
	} else {
		missing.push('codex');
	}

	const installed: OAuthCliInstallResult[] = [];
	for (const tool of missing) {
		installed.push(await installOAuthCli({ tool }));
	}

	return {
		ok: true,
		platform: process.platform,
		installed,
		skipped
	};
}

async function ensureOAuthCliAvailable(tool: CliToolName): Promise<OAuthCliStatus> {
	const detected = await detectSingleOAuthCli(tool);
	if (detected.available) {
		return detected;
	}
	await installOAuthCli({ tool });
	return detectSingleOAuthCli(tool);
}

export async function connectClaudeCodeOAuth(input: {
	credential?: string;
	profile?: string;
	layer?: string;
	oauthCommand?: string;
}): Promise<unknown> {
	const credential = trimOrUndefined(input.credential) ?? 'claude_code_main';
	const profile = trimOrUndefined(input.profile) ?? 'claude_code';
	const layer = trimOrUndefined(input.layer) ?? 'claude_code';
	const cli = await ensureOAuthCliAvailable('claude');
	const oauthCommand = trimOrUndefined(input.oauthCommand) ?? cli.oauth_command;
	const loginCommand = oauthLoginCommandFromPath(cli.path, 'claude');

	const tokenAttempt = await runShellCommand(oauthCommand, 20_000);
	let tokenOutput = summarizeRawOutput(tokenAttempt);
	let token = tokenAttempt.code === 0 ? parseOAuthToken(tokenAttempt.stdout) : null;
	let loginOutput = '';
	let loginUrls: string[] = [];
	let openedBrowser: Awaited<ReturnType<typeof openUrlInBrowser>> | null = null;
	if (!token) {
		const loginAttempt = await runShellCommand(loginCommand, LOGIN_TIMEOUT_MS);
		loginOutput = summarizeRawOutput(loginAttempt);
		loginUrls = extractUrls(`${loginAttempt.stdout}\n${loginAttempt.stderr}`);
		if (loginUrls.length > 0) {
			openedBrowser = await openUrlInBrowser(loginUrls[0]);
		}

		if (!loginAttempt.started || loginAttempt.code !== 0) {
			throw new Error(
				`claude auth login failed: ${loginOutput || loginAttempt.error || `exit code ${String(loginAttempt.code)}`}`
			);
		}

		// Give local credential/session writes a moment before requesting token.
		await sleep(1200);
		const secondTokenAttempt = await runShellCommand(oauthCommand, 20_000);
		tokenOutput = [tokenOutput, loginOutput, summarizeRawOutput(secondTokenAttempt)]
			.filter(Boolean)
			.join('\n');
		token = secondTokenAttempt.code === 0 ? parseOAuthToken(secondTokenAttempt.stdout) : null;

		if (!token) {
			const browserDetail = openedBrowser?.ok
				? 'browser opened'
				: openedBrowser
					? `browser open failed (${openedBrowser.output || 'unknown'})`
					: 'no auth URL detected in output';
			throw new Error(
				`claude token retrieval failed after login. ${browserDetail}. ${tokenOutput || 'No output from claude auth commands.'}`
			);
		}
	}

	const configured = await configureClaudeCode({
		credential,
		profile,
		layer,
		oauthCommand,
		token
	});
	const detectedAfter = await detectSingleOAuthCli('claude');

	return {
		ok: true,
		provider: 'claude_code',
		credential,
		profile,
		layer,
		oauthCommand,
		loginCommand,
		cli: detectedAfter,
		configured,
		tokenRetrieved: Boolean(token),
		tokenOutput,
		loginOutput,
		loginUrls,
		openedBrowser
	};
}

export async function connectCodexOAuth(input: {
	credential?: string;
	profile?: string;
	layer?: string;
	oauthCommand?: string;
	token?: string;
}): Promise<unknown> {
	const credential = trimOrUndefined(input.credential) ?? 'codex_main';
	const profile = trimOrUndefined(input.profile) ?? 'codex';
	const layer = trimOrUndefined(input.layer) ?? 'openai_codex';
	const cli = await ensureOAuthCliAvailable('codex');
	const oauthCommand = trimOrUndefined(input.oauthCommand) ?? cli.oauth_command;
	const token = trimOrUndefined(input.token);
	const codexBin = cli.path ?? 'codex';
	const loginCommand = oauthLoginCommandFromPath(cli.path, 'codex');

	async function codexLoginStatus(): Promise<{ loggedIn: boolean; output: string }> {
		const result = await runRawCommand(codexBin, ['login', 'status'], 20_000);
		const output = summarizeRawOutput(result);
		if (!result.started || result.code !== 0) {
			return { loggedIn: false, output };
		}
		const text = `${result.stdout}\n${result.stderr}`;
		return {
			loggedIn: /logged in/i.test(text),
			output
		};
	}

	async function waitForCodexLogin(
		maxWaitMs: number = 30_000
	): Promise<{ loggedIn: boolean; output: string; checks: number }> {
		const startedAt = Date.now();
		let checks = 0;
		let lastOutput = '';
		while (Date.now() - startedAt < maxWaitMs) {
			const status = await codexLoginStatus();
			checks += 1;
			lastOutput = status.output;
			if (status.loggedIn) {
				return { loggedIn: true, output: status.output, checks };
			}
			await sleep(1_250);
		}
		return { loggedIn: false, output: lastOutput, checks };
	}

	let loginAttemptOutput = '';
	let loginUrls: string[] = [];
	let openedBrowser: Awaited<ReturnType<typeof openUrlInBrowser>> | null = null;
	let loginStatus = await codexLoginStatus();
	if (!token && !loginStatus.loggedIn) {
		const deviceAuth = await runShellCommand(loginCommand, LOGIN_TIMEOUT_MS);
		loginAttemptOutput = summarizeRawOutput(deviceAuth);
		loginUrls = extractUrls(`${deviceAuth.stdout}\n${deviceAuth.stderr}`);
		if (loginUrls.length > 0) {
			openedBrowser = await openUrlInBrowser(loginUrls[0]);
		}
		if (!deviceAuth.started || deviceAuth.code !== 0) {
			throw new Error(
				`codex login failed: ${loginAttemptOutput || deviceAuth.error || `exit code ${String(deviceAuth.code)}`}`
			);
		}
		loginStatus = await codexLoginStatus();
		if (!loginStatus.loggedIn) {
			const waited = await waitForCodexLogin();
			loginStatus = { loggedIn: waited.loggedIn, output: waited.output };
		}
		if (!loginStatus.loggedIn) {
			throw new Error(
				`codex login did not complete. ${
					loginStatus.output ||
					loginAttemptOutput ||
					'Complete the device-auth prompt in your browser, then press Connect again.'
				}`
			);
		}
	}

	const configured = await configureCodex({
		credential,
		profile,
		layer,
		oauthCommand,
		token
	});
	const detectedAfter = await detectSingleOAuthCli('codex');

	return {
		ok: true,
		provider: 'codex',
		credential,
		profile,
		layer,
		oauthCommand,
		loginCommand,
		cli: detectedAfter,
		loginStatus,
		loginAttemptOutput,
		loginUrls,
		openedBrowser,
		configured,
		login: token ? null : loginStatus
	};
}

export async function configureExtensions(): Promise<UiExtensionSurface[]> {
	return (await runCommand(['configure', 'extensions'])) as UiExtensionSurface[];
}

export async function configureExtensionAdd(input: {
	name: string;
	kind?: string;
	slot?: string;
	title?: string;
	detail?: string;
	route?: string;
	order?: number;
	enabled?: boolean;
}): Promise<unknown> {
	const name = trimOrUndefined(input.name);
	if (!name) {
		throw new Error('extension name is required');
	}

	const args = ['configure', 'extension-add', '--name', name];
	const kind = trimOrUndefined(input.kind);
	const slot = trimOrUndefined(input.slot);
	const title = trimOrUndefined(input.title);
	const detail = trimOrUndefined(input.detail);
	const route = trimOrUndefined(input.route);

	if (kind) {
		args.push('--kind', kind);
	}
	if (slot) {
		args.push('--slot', slot);
	}
	if (title) {
		args.push('--title', title);
	}
	if (detail) {
		args.push('--detail', detail);
	}
	if (route) {
		args.push('--route', route);
	}
	if (typeof input.order === 'number' && Number.isFinite(input.order)) {
		args.push('--order', String(Math.trunc(input.order)));
	}
	if (input.enabled === false) {
		args.push('--enabled', 'false');
	} else if (input.enabled === true) {
		args.push('--enabled', 'true');
	}

	return runCommand(args);
}

export async function configureExtensionRemove(input: { name: string }): Promise<unknown> {
	const name = trimOrUndefined(input.name);
	if (!name) {
		throw new Error('extension name is required');
	}
	return runCommand(['configure', 'extension-remove', '--name', name]);
}

export async function runConfigureAction(action: ConfigureAction, payload: Record<string, unknown>): Promise<unknown> {
	switch (action) {
		case 'status':
			return configureStatus();
		case 'doctor':
			return configureDoctor();
		case 'manager_policy_status':
			return configureManagerPolicyStatus();
		case 'manager_policy_set':
			return configureManagerPolicySet({
				childSpawnEnabled:
					typeof payload.childSpawnEnabled === 'boolean'
						? payload.childSpawnEnabled
						: undefined,
				childSpawnContainerOnly:
					typeof payload.childSpawnContainerOnly === 'boolean'
						? payload.childSpawnContainerOnly
						: undefined,
				unsafeHostCommunicationEnabled:
					typeof payload.unsafeHostCommunicationEnabled === 'boolean'
						? payload.unsafeHostCommunicationEnabled
						: undefined,
				socketBusEnabled:
					typeof payload.socketBusEnabled === 'boolean'
						? payload.socketBusEnabled
						: undefined,
				socketBusContainerOnly:
					typeof payload.socketBusContainerOnly === 'boolean'
						? payload.socketBusContainerOnly
						: undefined,
				socketBusMaxChannelMessages:
					typeof payload.socketBusMaxChannelMessages === 'number'
						? payload.socketBusMaxChannelMessages
						: undefined,
				containerPackageInstallsEnabled:
					typeof payload.containerPackageInstallsEnabled === 'boolean'
						? payload.containerPackageInstallsEnabled
						: undefined
			});
		case 'services':
			return configureServices();
		case 'service_ensure':
			return configureEnsureServices({
				names: Array.isArray(payload.names)
					? payload.names.filter((item): item is string => typeof item === 'string')
					: []
			});
		case 'package_ledger_scopes':
			return configurePackageLedgerScopes({
				limit: typeof payload.limit === 'number' ? payload.limit : undefined
			});
		case 'package_ledger_events':
			return configurePackageLedgerEvents({
				scopeKey: typeof payload.scopeKey === 'string' ? payload.scopeKey : undefined,
				limit: typeof payload.limit === 'number' ? payload.limit : undefined
			});
		case 'skills':
			return configureSkills();
		case 'skill_add':
			return configureSkillAdd({
				name: String(payload.name ?? ''),
				description: typeof payload.description === 'string' ? payload.description : undefined,
				path: typeof payload.path === 'string' ? payload.path : undefined,
				installCommand:
					typeof payload.installCommand === 'string' ? payload.installCommand : undefined,
				plugins: Array.isArray(payload.plugins)
					? payload.plugins.filter((item): item is string => typeof item === 'string')
					: [],
				resources: Array.isArray(payload.resources)
					? payload.resources.filter((item): item is string => typeof item === 'string')
					: [],
				agents: Array.isArray(payload.agents)
					? payload.agents.filter((item): item is string => typeof item === 'string')
					: [],
				actions: Array.isArray(payload.actions)
					? payload.actions.filter((item): item is string => typeof item === 'string')
					: [],
				tags: Array.isArray(payload.tags)
					? payload.tags.filter((item): item is string => typeof item === 'string')
					: [],
				enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
				runInstall: payload.runInstall === true
			});
		case 'skill_remove':
			return configureSkillRemove({
				name: String(payload.name ?? '')
			});
		case 'plugin_catalog':
			return configurePluginCatalog();
		case 'plugin_preview':
			return configurePluginPreview({
				plugin:
					typeof payload.plugin === 'string'
						? payload.plugin
						: String(payload.manifest ?? '')
			});
		case 'plugin_install':
			return configurePluginInstall({
				plugin:
					typeof payload.plugin === 'string'
						? payload.plugin
						: String(payload.manifest ?? ''),
				allowMissingDependencies: payload.allowMissingDependencies === true,
				adoptExisting: payload.adoptExisting === true,
				skipInstallCommands: payload.skipInstallCommands === true
			});
		case 'plugin_remove':
			return configurePluginRemove({
				plugin:
					typeof payload.plugin === 'string'
						? payload.plugin
						: String(payload.manifest ?? '')
			});
		case 'extensions':
			return configureExtensions();
		case 'openai':
			return configureOpenAi({
				apiKey: String(payload.apiKey ?? ''),
				credential: typeof payload.credential === 'string' ? payload.credential : undefined,
				profile: typeof payload.profile === 'string' ? payload.profile : undefined,
				layer: typeof payload.layer === 'string' ? payload.layer : undefined
			});
		case 'claude_api':
			return configureClaudeApi({
				apiKey: String(payload.apiKey ?? ''),
				credential: typeof payload.credential === 'string' ? payload.credential : undefined,
				profile: typeof payload.profile === 'string' ? payload.profile : undefined,
				layer: typeof payload.layer === 'string' ? payload.layer : undefined
			});
		case 'claude_code':
			return configureClaudeCode({
				token: typeof payload.token === 'string' ? payload.token : undefined,
				oauthCommand: typeof payload.oauthCommand === 'string' ? payload.oauthCommand : undefined,
				credential: typeof payload.credential === 'string' ? payload.credential : undefined,
				profile: typeof payload.profile === 'string' ? payload.profile : undefined,
				layer: typeof payload.layer === 'string' ? payload.layer : undefined
			});
		case 'codex':
			return configureCodex({
				token: typeof payload.token === 'string' ? payload.token : undefined,
				oauthCommand: typeof payload.oauthCommand === 'string' ? payload.oauthCommand : undefined,
				credential: typeof payload.credential === 'string' ? payload.credential : undefined,
				profile: typeof payload.profile === 'string' ? payload.profile : undefined,
				layer: typeof payload.layer === 'string' ? payload.layer : undefined
			});
		case 'login':
			return configureLogin({
				credential: String(payload.credential ?? '')
			});
		case 'detect_clis':
			return detectOAuthCliTools();
		case 'install_cli':
			if (payload.tool !== 'claude' && payload.tool !== 'codex') {
				throw new Error("install_cli requires tool='claude' or tool='codex'");
			}
			return installOAuthCli({
				tool: payload.tool,
				force: payload.force === true
			});
		case 'install_missing_clis':
			return installMissingOAuthCliTools();
		case 'claude_code_oauth_connect':
			return connectClaudeCodeOAuth({
				credential: typeof payload.credential === 'string' ? payload.credential : undefined,
				profile: typeof payload.profile === 'string' ? payload.profile : undefined,
				layer: typeof payload.layer === 'string' ? payload.layer : undefined,
				oauthCommand: typeof payload.oauthCommand === 'string' ? payload.oauthCommand : undefined
			});
		case 'codex_oauth_connect':
			return connectCodexOAuth({
				credential: typeof payload.credential === 'string' ? payload.credential : undefined,
				profile: typeof payload.profile === 'string' ? payload.profile : undefined,
				layer: typeof payload.layer === 'string' ? payload.layer : undefined,
				oauthCommand: typeof payload.oauthCommand === 'string' ? payload.oauthCommand : undefined,
				token: typeof payload.token === 'string' ? payload.token : undefined
			});
		case 'extension_add':
			return configureExtensionAdd({
				name: String(payload.name ?? ''),
				kind: typeof payload.kind === 'string' ? payload.kind : undefined,
				slot: typeof payload.slot === 'string' ? payload.slot : undefined,
				title: typeof payload.title === 'string' ? payload.title : undefined,
				detail: typeof payload.detail === 'string' ? payload.detail : undefined,
				route: typeof payload.route === 'string' ? payload.route : undefined,
				order: typeof payload.order === 'number' ? payload.order : undefined,
				enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined
			});
		case 'extension_remove':
			return configureExtensionRemove({
				name: String(payload.name ?? '')
			});
		default:
			throw new Error(`unsupported configure action: ${action}`);
	}
}

export async function discoverExtensionSurfaces(): Promise<UiExtensionSurface[]> {
	return configureExtensions();
}

export async function runTaskFromApp(input: {
	task: string;
	resource: string;
	action: 'create' | 'read' | 'update' | 'delete';
	target?: string;
	runtime?: string;
	profile?: string;
	image?: string;
	network?: string;
}): Promise<unknown> {
	const task = trimOrUndefined(input.task);
	if (!task) {
		throw new Error('task is required');
	}
	const resource = trimOrUndefined(input.resource);
	if (!resource) {
		throw new Error('resource is required');
	}

	const args = ['run', '--task', task, '--resource', resource, '--action', input.action];
	const target = trimOrUndefined(input.target);
	const runtime = trimOrUndefined(input.runtime);
	const profile = trimOrUndefined(input.profile);
	const image = trimOrUndefined(input.image);
	const network = trimOrUndefined(input.network);
	if (target) {
		args.push('--target', target);
	}
	if (runtime) {
		args.push('--runtime', runtime);
	}
	if (profile) {
		args.push('--profile', profile);
	}
	if (image) {
		args.push('--image', image);
	}
	if (network) {
		args.push('--network', network);
	}

	return runCommand(args, undefined, TASK_TIMEOUT_MS);
}
