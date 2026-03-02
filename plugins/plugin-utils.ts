/**
 * Shared utilities used across all Pinokio plugins.
 *
 * This module is the single source of truth for common parsing, type coercion,
 * LLM execution, and agent binary resolution functions.  Every plugin should
 * import from here rather than defining its own local copy.
 */

import { spawnSync } from 'node:child_process';

/* ------------------------------------------------------------------ */
/*  Type coercion helpers                                              */
/* ------------------------------------------------------------------ */

/** Return a trimmed, non-empty string or `null`. */
export function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Coerce an unknown value to a boolean with a configurable fallback. */
export function toBool(value: unknown, fallback: boolean = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return fallback;
}

/** Parse an integer with clamping to `[min, max]` and a fallback default. */
export function toInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/** Normalize a CRUD action string: trim + lowercase. */
export function normalizeAction(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  JSON parsing                                                       */
/* ------------------------------------------------------------------ */

/** Return the index of the first `{` or `[` in `text`, or -1. */
export function firstJsonStart(text: string): number {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

/** Best-effort JSON parse: tries the full string, then strips a leading prefix. */
export function parseJsonOutput(raw: unknown): unknown {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = firstJsonStart(trimmed);
    if (start < 0) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

/** Parse the `target` env string into a metadata record. */
export function parseTargetMeta(target: unknown): Record<string, unknown> {
  if (typeof target !== 'string') {
    return {};
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.startsWith('{')) {
    return { message: trimmed };
  }
  const parsed = parseJsonOutput(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Agent binary & LLM execution                                       */
/* ------------------------------------------------------------------ */

/** Locate the `pinokio-agent` binary by probing candidate paths. */
export function resolveAgentBinary(): string {
  const candidates: string[] = [
    asOptionalString(process.env.PINOKIO_AGENT_BIN),
    'pinokio-agent',
    '/usr/local/bin/pinokio-agent',
    './target/debug/pinokio-agent',
    './target/release/pinokio-agent'
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      env: process.env
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return 'pinokio-agent';
}

/** Build an env block suitable for running LLM commands inside a container. */
export function buildContainerLlmEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const childHome =
    asOptionalString(env.PINOKIO_CHILD_HOME) || '/var/lib/pinokio-oauth';
  const childBins = [`${childHome}/.npm-global/bin`, `${childHome}/.local/bin`];
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  env.PINOKIO_CHILD_MODE = '1';
  env.PINOKIO_CHILD_HOME = childHome;
  env.PATH = `${childBins.join(':')}${pathValue ? `:${pathValue}` : ''}`;
  return env;
}

/** Result from an LLM invocation. */
export interface ChatLlmResult {
  text: string;
  profile: string;
  provider: string;
  model: string;
}

/** Run the pinokio-agent LLM command and return the parsed result. */
export function runChatLlm(params: {
  profile: string;
  prompt: string;
  timeoutMs?: number;
}): ChatLlmResult {
  const timeoutMs = toInt(params.timeoutMs, 120000, 10000, 600000);
  const agentBin = resolveAgentBinary();
  const out = spawnSync(agentBin, ['llm', '--profile', params.profile, '--prompt', params.prompt], {
    encoding: 'utf8',
    env: buildContainerLlmEnv(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8
  });

  if (out.error) {
    if ((out.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`chat llm timed out after ${timeoutMs}ms`);
    }
    throw new Error(`failed to run ${agentBin} llm: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `chat llm command failed (${out.status}): ${(out.stderr || out.stdout || '').trim()}`
    );
  }
  const parsed = parseJsonOutput(out.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('chat llm command returned non-JSON output');
  }
  const payload = parsed as Record<string, unknown>;
  const text = asOptionalString(payload.text);
  if (!text) {
    throw new Error('chat llm response was empty');
  }
  return {
    text,
    profile: asOptionalString(payload.profile) || params.profile,
    provider: asOptionalString(payload.provider) || 'unknown',
    model: asOptionalString(payload.model) || 'unknown'
  };
}
