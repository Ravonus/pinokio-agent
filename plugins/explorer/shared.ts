import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../../sdk/typescript/pinokio-sdk.ts';
import { normalizeAction } from '../plugin-utils.ts';

// ── Shared types ────────────────────────────────────────────────────

export interface TargetMeta {
  [key: string]: unknown;
}

export interface ScriptStep {
  op: string;
  [key: string]: unknown;
}

// ── Shared constants ────────────────────────────────────────────────

export const DEFAULT_SCOPE_DIR: string = process.env.PINOKIO_EXPLORER_SCOPE || '/app';

export const SCRIPT_MUTATION_OPERATIONS: Set<string> = new Set([
  'delete_by_extension',
  'cleanup',
  'zip_files_over_size',
  'archive_large_files',
  'run_script'
]);

export const DEFAULT_CLEANUP_NAMES: Set<string> = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.localized'
]);

export const DEFAULT_CLEANUP_EXTENSIONS: Set<string> = new Set([
  'tmp',
  'bak',
  'old',
  'log',
  'dmp',
  'rar'
]);

// ── Shared functions ────────────────────────────────────────────────

export function normalizeScriptOperation(value: unknown): string {
  const operation = normalizeAction(value);
  if (operation === 'archive_large_files') {
    return 'zip_files_over_size';
  }
  if (operation === 'script' || operation === 'execute_script' || operation === 'workflow') {
    return 'run_script';
  }
  return operation;
}

export function toPositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function normalizeExtensionToken(value: unknown): string | null {
  const trimmed = String(value || '')
    .trim()
    .toLowerCase();
  if (!trimmed) {
    return null;
  }
  const stripped = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  const safe = stripped.replace(/[^a-z0-9]+/g, '');
  return safe || null;
}

export function extensionFromName(name: unknown): string {
  const value = String(name || '');
  const index = value.lastIndexOf('.');
  if (index <= 0 || index === value.length - 1) {
    return '';
  }
  return value.slice(index + 1).toLowerCase();
}

export function ensureDirectory(value: string, label: string): void {
  if (!fs.existsSync(value)) {
    fail(`${label} does not exist: ${value}`);
  }
  const stat = fs.statSync(value);
  if (!stat.isDirectory()) {
    fail(`${label} is not a directory: ${value}`);
  }
}

export function ensureInsideScope(scopeDir: string, candidate: string): string {
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(candidate);
  if (resolved === scope) {
    return resolved;
  }
  const withSep = scope.endsWith(path.sep) ? scope : `${scope}${path.sep}`;
  if (!resolved.startsWith(withSep)) {
    fail(`path escapes scope '${scope}': ${resolved}`);
  }
  return resolved;
}

export function formatHumanBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units: string[] = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex < 0) {
    return `${bytes} B`;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
