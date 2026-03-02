import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fail } from '../../sdk/typescript/pinokio-sdk.ts';
import { asOptionalString } from '../plugin-utils.ts';
import type { ScriptStep } from './shared.ts';
import { resolveTemplateString } from './script-executor.ts';
import type { TemplateContext } from './script-executor.ts';
import { ensureParentDir } from './write.ts';
import type { MutationResult } from './write.ts';

// ── Constants ──────────────────────────────────────────────────────

export const PACKAGE_STEP_TIMEOUT_MS: number = 600_000;
export const PACKAGE_LEDGER_VERSION: number = 1;

// ── Interfaces ─────────────────────────────────────────────────────

export interface PackagePlanStep {
  command: string;
  args: string[];
}

export interface PackageCommandOutput {
  command: string;
  args: string[];
  status: number;
  output: string;
}

export interface LedgerScopeData {
  manager: string | null;
  packages: string[];
}

export interface PackageLedger {
  version: number;
  updated_at: string;
  scopes: Record<string, LedgerScopeData>;
  events: Record<string, unknown>[];
}

export interface LedgerUpdateResult {
  ledger_path: string;
  scope_key: string;
  recorded: boolean;
  installed_packages?: string[];
}

export interface ScopePackagesFromLedger {
  ledger_path: string;
  scope_key: string;
  manager: string | null;
  packages: string[];
}

// ── Helpers ────────────────────────────────────────────────────────

export function isTruthy(value: unknown): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

// ── Package management functions ───────────────────────────────────

export function assertContainerPackageInstallsEnabled(stepOp: string): void {
  if (isTruthy(process.env.PINOKIO_CONTAINER_PACKAGE_INSTALLS_ENABLED)) {
    return;
  }
  fail(
    `${stepOp} is disabled by manager policy. Enable container package installs in /ui/configure (Manager Security Policy) to allow apt/apk/dnf/yum operations.`
  );
}

export function sanitizePackageName(value: unknown): string | null {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9+._:-]{0,127}$/i.test(raw)) {
    fail(`invalid package name '${raw}'`);
  }
  return raw;
}

export function parsePackageList(rawValue: unknown, context: TemplateContext): string[] {
  const resolved = resolveTemplateString(rawValue, context);
  const items: string[] = [];
  if (Array.isArray(resolved)) {
    for (const value of resolved) {
      const token = sanitizePackageName(resolveTemplateString(value, context));
      if (token) {
        items.push(token);
      }
    }
  } else if (typeof resolved === 'string') {
    for (const token of resolved.split(/[\s,;|]+/)) {
      const normalized = sanitizePackageName(token);
      if (normalized) {
        items.push(normalized);
      }
    }
  } else if (resolved !== null && resolved !== undefined) {
    const normalized = sanitizePackageName(String(resolved));
    if (normalized) {
      items.push(normalized);
    }
  }

  const deduped = Array.from(new Set(items));
  if (deduped.length === 0) {
    fail('run_script package operations require at least one package');
  }
  return deduped;
}

export function commandAvailable(command: string): boolean {
  const probe = spawnSync('which', [command], { encoding: 'utf8' });
  return probe.status === 0;
}

export function detectPackageManager(preferred: unknown): string {
  const normalizedPreferred = asOptionalString(preferred)?.toLowerCase() || null;
  const supported = ['apt-get', 'apk', 'dnf', 'yum'];
  const candidates = normalizedPreferred
    ? [normalizedPreferred, ...supported.filter((item) => item !== normalizedPreferred)]
    : supported;

  for (const candidate of candidates) {
    if (!supported.includes(candidate)) {
      continue;
    }
    if (commandAvailable(candidate)) {
      return candidate;
    }
  }

  fail(
    `no supported package manager found in this container. checked: ${supported.join(', ')}`
  );
}

export function packageInstallPlan(manager: string, packages: string[], updateIndex: unknown): PackagePlanStep[] {
  if (manager === 'apt-get') {
    const plan: PackagePlanStep[] = [];
    if (updateIndex !== false) {
      plan.push({ command: 'apt-get', args: ['update'] });
    }
    plan.push({ command: 'apt-get', args: ['install', '-y', ...packages] });
    return plan;
  }
  if (manager === 'apk') {
    return [{ command: 'apk', args: ['add', '--no-cache', ...packages] }];
  }
  if (manager === 'dnf') {
    return [{ command: 'dnf', args: ['install', '-y', ...packages] }];
  }
  if (manager === 'yum') {
    return [{ command: 'yum', args: ['install', '-y', ...packages] }];
  }
  fail(`unsupported package manager '${manager}'`);
}

export function packageRemovePlan(manager: string, packages: string[], autoremove: unknown): PackagePlanStep[] {
  if (manager === 'apt-get') {
    const plan: PackagePlanStep[] = [{ command: 'apt-get', args: ['remove', '-y', ...packages] }];
    if (autoremove) {
      plan.push({ command: 'apt-get', args: ['autoremove', '-y'] });
    }
    return plan;
  }
  if (manager === 'apk') {
    return [{ command: 'apk', args: ['del', ...packages] }];
  }
  if (manager === 'dnf') {
    return [{ command: 'dnf', args: ['remove', '-y', ...packages] }];
  }
  if (manager === 'yum') {
    return [{ command: 'yum', args: ['remove', '-y', ...packages] }];
  }
  fail(`unsupported package manager '${manager}'`);
}

export function shellLineForCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => JSON.stringify(arg))].join(' ');
}

export function runPackagePlan(plan: PackagePlanStep[], dryRun: boolean): PackageCommandOutput[] {
  const outputs: PackageCommandOutput[] = [];
  if (dryRun) {
    return outputs;
  }
  for (const step of plan) {
    const out = spawnSync(step.command, step.args, {
      encoding: 'utf8',
      timeout: PACKAGE_STEP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
      env: {
        ...process.env,
        DEBIAN_FRONTEND: 'noninteractive'
      }
    });
    if (out.error) {
      if ((out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        fail(
          `package command timed out after ${PACKAGE_STEP_TIMEOUT_MS}ms: ${shellLineForCommand(
            step.command,
            step.args
          )}`
        );
      }
      fail(
        `package command failed to start: ${shellLineForCommand(step.command, step.args)} (${out.error.message})`
      );
    }
    const output = `${String(out.stdout || '')}${String(out.stderr || '')}`.trim();
    outputs.push({
      command: step.command,
      args: step.args,
      status: out.status ?? 1,
      output: output.slice(-4000)
    });
    if (out.status !== 0) {
      fail(
        `package command failed (${out.status}): ${shellLineForCommand(step.command, step.args)}${output ? `\n${output}` : ''}`
      );
    }
  }
  return outputs;
}

export function resolvePackageLedgerPath(): string {
  return asOptionalString(process.env.PINOKIO_PACKAGE_LEDGER_PATH) || '/app/.pka/package-ledger.json';
}

export function normalizeLedgerScopeData(raw: unknown): LedgerScopeData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manager: null, packages: [] };
  }
  const rawObj = raw as Record<string, unknown>;
  const manager = asOptionalString(rawObj.manager);
  const packages: string[] = [];
  if (Array.isArray(rawObj.packages)) {
    for (const value of rawObj.packages) {
      if (typeof value !== 'string') {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      if (/^[a-z0-9][a-z0-9+._:-]{0,127}$/i.test(trimmed)) {
        packages.push(trimmed);
      }
    }
  }
  return {
    manager,
    packages: Array.from(new Set(packages))
  };
}

export function loadPackageLedger(ledgerPath: string): PackageLedger {
  const empty: PackageLedger = {
    version: PACKAGE_LEDGER_VERSION,
    updated_at: new Date().toISOString(),
    scopes: {},
    events: []
  };
  if (!fs.existsSync(ledgerPath)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return empty;
    }
    const scopes: Record<string, LedgerScopeData> = {};
    if (parsed.scopes && typeof parsed.scopes === 'object' && !Array.isArray(parsed.scopes)) {
      for (const [key, value] of Object.entries(parsed.scopes)) {
        scopes[key] = normalizeLedgerScopeData(value);
      }
    }
    const events: Record<string, unknown>[] = Array.isArray(parsed.events)
      ? parsed.events.filter((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)).slice(-5000) as Record<string, unknown>[]
      : [];
    return {
      version: PACKAGE_LEDGER_VERSION,
      updated_at: asOptionalString(parsed.updated_at) || empty.updated_at,
      scopes,
      events
    };
  } catch {
    return empty;
  }
}

export function savePackageLedger(ledgerPath: string, ledger: PackageLedger): void {
  ensureParentDir(ledgerPath);
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify(
      {
        ...ledger,
        version: PACKAGE_LEDGER_VERSION,
        updated_at: new Date().toISOString(),
        events: Array.isArray(ledger.events) ? ledger.events.slice(-5000) : []
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

export function ledgerScopeKey(scopeDir: string): string {
  const resource = asOptionalString(process.env.PINOKIO_SOCKET_RESOURCE) || 'unknown_resource';
  const agentId = asOptionalString(process.env.PINOKIO_SOCKET_AGENT_ID) || 'unknown_agent';
  return `${resource}::${agentId}::${scopeDir}`;
}

export function updatePackageLedger(scopeDir: string, manager: string, packages: string[], action: string, dryRun: boolean): LedgerUpdateResult {
  const ledgerPath = resolvePackageLedgerPath();
  const scopeKey = ledgerScopeKey(scopeDir);
  if (dryRun) {
    return {
      ledger_path: ledgerPath,
      scope_key: scopeKey,
      recorded: false
    };
  }

  const ledger = loadPackageLedger(ledgerPath);
  const existing = normalizeLedgerScopeData(ledger.scopes[scopeKey]);
  const currentPackages = new Set(existing.packages);
  const normalizedPackages = packages.map((value) => sanitizePackageName(value)).filter(Boolean) as string[];

  if (action === 'install') {
    for (const pkg of normalizedPackages) {
      currentPackages.add(pkg);
    }
  } else if (action === 'remove') {
    for (const pkg of normalizedPackages) {
      currentPackages.delete(pkg);
    }
  }

  ledger.scopes[scopeKey] = {
    manager,
    packages: Array.from(currentPackages).sort((a, b) => a.localeCompare(b))
  };
  const resource = asOptionalString(process.env.PINOKIO_SOCKET_RESOURCE);
  const agentId = asOptionalString(process.env.PINOKIO_SOCKET_AGENT_ID);
  ledger.events.push({
    at: new Date().toISOString(),
    action,
    manager,
    packages: normalizedPackages,
    scope_key: scopeKey,
    scope_dir: scopeDir,
    resource,
    agent_id: agentId
  });
  savePackageLedger(ledgerPath, ledger);

  return {
    ledger_path: ledgerPath,
    scope_key: scopeKey,
    recorded: true,
    installed_packages: ledger.scopes[scopeKey].packages
  };
}

export function readScopePackagesFromLedger(scopeDir: string): ScopePackagesFromLedger {
  const ledgerPath = resolvePackageLedgerPath();
  const scopeKey = ledgerScopeKey(scopeDir);
  const ledger = loadPackageLedger(ledgerPath);
  const scoped = normalizeLedgerScopeData(ledger.scopes[scopeKey]);
  return {
    ledger_path: ledgerPath,
    scope_key: scopeKey,
    manager: scoped.manager,
    packages: scoped.packages
  };
}

export function executeEnsurePackagesStep(scopeDir: string, step: ScriptStep, context: TemplateContext, dryRun: boolean): MutationResult {
  assertContainerPackageInstallsEnabled('ensure_packages');
  const packages = parsePackageList(step.packages ?? step.package ?? step.names, context);
  const manager = detectPackageManager(resolveTemplateString(step.package_manager ?? step.manager, context));
  const plan = packageInstallPlan(manager, packages, step.update_index !== false);
  const outputs = runPackagePlan(plan, dryRun);
  const ledger = updatePackageLedger(scopeDir, manager, packages, 'install', dryRun);
  return {
    operation: 'ensure_packages',
    manager,
    packages,
    command_count: plan.length,
    script: plan.map((entry) => shellLineForCommand(entry.command, entry.args)).join('\n'),
    command_outputs: outputs,
    ledger,
    applied: !dryRun
  };
}

export function executeRemovePackagesStep(scopeDir: string, step: ScriptStep, context: TemplateContext, dryRun: boolean): MutationResult {
  assertContainerPackageInstallsEnabled('remove_packages');
  const packages = parsePackageList(step.packages ?? step.package ?? step.names, context);
  const manager = detectPackageManager(resolveTemplateString(step.package_manager ?? step.manager, context));
  const plan = packageRemovePlan(manager, packages, step.autoremove !== false);
  const outputs = runPackagePlan(plan, dryRun);
  const ledger = updatePackageLedger(scopeDir, manager, packages, 'remove', dryRun);
  return {
    operation: 'remove_packages',
    manager,
    packages,
    command_count: plan.length,
    script: plan.map((entry) => shellLineForCommand(entry.command, entry.args)).join('\n'),
    command_outputs: outputs,
    ledger,
    applied: !dryRun
  };
}

export function executeRestorePackagesStep(scopeDir: string, step: ScriptStep, context: TemplateContext, dryRun: boolean): MutationResult {
  assertContainerPackageInstallsEnabled('restore_packages');
  const fromLedger = readScopePackagesFromLedger(scopeDir);
  if (!Array.isArray(fromLedger.packages) || fromLedger.packages.length === 0) {
    fail(
      `restore_packages found no tracked packages for this scope in ${fromLedger.ledger_path}`
    );
  }
  const manager = detectPackageManager(
    resolveTemplateString(step.package_manager ?? step.manager, context) || fromLedger.manager
  );
  const plan = packageInstallPlan(manager, fromLedger.packages, step.update_index !== false);
  const outputs = runPackagePlan(plan, dryRun);
  const ledger = updatePackageLedger(scopeDir, manager, fromLedger.packages, 'install', dryRun);
  return {
    operation: 'restore_packages',
    manager,
    packages: fromLedger.packages,
    command_count: plan.length,
    script: plan.map((entry) => shellLineForCommand(entry.command, entry.args)).join('\n'),
    command_outputs: outputs,
    ledger,
    restored_from: fromLedger.ledger_path,
    applied: !dryRun
  };
}
