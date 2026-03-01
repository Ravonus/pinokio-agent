import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';

const SUPPORTED_MODES: Set<string> = new Set(['llm', 'command']);

function firstJsonStart(text: string): number {
  const firstObject: number = text.indexOf('{');
  const firstArray: number = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

function parseJsonOutput(raw: unknown): unknown {
  const trimmed: string = String(raw || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start: number = firstJsonStart(trimmed);
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

function parseTargetMeta(target: unknown): Record<string, unknown> {
  if (typeof target !== 'string') {
    return {};
  }
  const trimmed: string = target.trim();
  if (!trimmed) {
    return {};
  }
  if (!trimmed.startsWith('{')) {
    return { message: trimmed };
  }
  const parsed: unknown = parseJsonOutput(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function normalizeMessage(summary: unknown, targetMeta: Record<string, unknown>): string {
  const targetMessage: string =
    typeof targetMeta.message === 'string' ? (targetMeta.message as string).trim() : '';
  if (targetMessage) {
    return targetMessage;
  }

  const summaryText: string = typeof summary === 'string' ? summary.trim() : '';
  if (summaryText) {
    return summaryText;
  }

  return 'Hello';
}

function ensureManagedInvocation(request: PluginRequest): void {
  const callerTask: string = typeof request.caller_task_id === 'string' ? (request.caller_task_id as string).trim() : '';
  const callerAgent: string = typeof request.caller_agent_id === 'string' ? (request.caller_agent_id as string).trim() : '';
  const callerResource: string =
    typeof request.caller_resource === 'string' ? (request.caller_resource as string).trim() : '';

  if (!callerTask || !callerAgent || !callerResource) {
    fail('unsafe_host_agent is managed-only and cannot be invoked directly');
  }

  const allowedCallers: string[] = String(process.env.PINOKIO_UNSAFE_ALLOWED_CALLERS || '')
    .split(',')
    .map((value: string) => value.trim())
    .filter(Boolean);
  if (allowedCallers.length > 0 && !allowedCallers.includes(callerResource)) {
    fail(
      `unsafe_host_agent caller '${callerResource}' is not allowed (allowed: ${allowedCallers.join(', ')})`
    );
  }
}

function normalizeMode(value: unknown): string {
  const mode: string = String(value || 'llm').trim().toLowerCase();
  if (!SUPPORTED_MODES.has(mode)) {
    fail(`unsupported unsafe_host_agent mode '${mode}'`);
  }
  return mode;
}

function resolveAgentBinary(): string {
  const candidates: string[] = [
    process.env.PINOKIO_AGENT_BIN,
    'pinokio-agent',
    '/usr/local/bin/pinokio-agent',
    './target/debug/pinokio-agent',
    './target/release/pinokio-agent'
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const probe: SpawnSyncReturns<string> = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      env: process.env
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return 'pinokio-agent';
}

interface LlmResult {
  text: string;
  profile: string;
  provider: string;
  model: string;
}

function runChatLlm({ profile, prompt }: { profile: string; prompt: string }): LlmResult {
  const agentBin: string = resolveAgentBinary();
  const out: SpawnSyncReturns<string> = spawnSync(agentBin, ['llm', '--profile', profile, '--prompt', prompt], {
    encoding: 'utf8',
    env: process.env
  });

  if (out.error) {
    throw new Error(`failed to run ${agentBin} llm: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error(
      `unsafe host llm command failed (${out.status}): ${(out.stderr || out.stdout || '').trim()}`
    );
  }

  const payload: unknown = parseJsonOutput(out.stdout);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('unsafe host llm command returned non-JSON output');
  }

  const payloadObj = payload as Record<string, unknown>;
  const text: string = typeof payloadObj.text === 'string' ? (payloadObj.text as string).trim() : '';
  if (!text) {
    throw new Error('unsafe host llm response was empty');
  }

  return {
    text,
    profile,
    provider: typeof payloadObj.provider === 'string' ? payloadObj.provider as string : 'unknown',
    model: typeof payloadObj.model === 'string' ? payloadObj.model as string : 'unknown'
  };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runHostCommand(command: string): CommandResult {
  const out: SpawnSyncReturns<string> = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024 * 4
  });
  if (out.error) {
    throw new Error(`failed running host command: ${out.error.message}`);
  }
  if (out.status !== 0) {
    const detail: string = (out.stderr || out.stdout || '').trim();
    throw new Error(`host command failed (${out.status}): ${detail}`);
  }
  return {
    stdout: String(out.stdout || '').trim(),
    stderr: String(out.stderr || '').trim(),
    status: out.status ?? 0
  };
}

function buildChatPrompt(message: string, systemContext: string): string {
  const blocks: string[] = [
    'You are a dedicated chat agent running with host-level tools.',
    'Reply directly to the user in a concise, practical style.',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ];
  return blocks.filter(Boolean).join('\n\n');
}

try {
  const { request }: { request: PluginRequest } = pluginContext();
  ensureManagedInvocation(request);

  const targetMeta: Record<string, unknown> = parseTargetMeta(request.target);
  const mode: string = normalizeMode(targetMeta.mode);

  if (mode === 'command') {
    const command: string = typeof targetMeta.command === 'string' ? (targetMeta.command as string).trim() : '';
    if (!command) {
      fail('unsafe_host_agent command mode requires target.command');
    }
    const result: CommandResult = runHostCommand(command);
    respond({
      ok: true,
      plugin: 'unsafe_host_agent',
      mode: 'command',
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.status
    });
  } else {
    const message: string = normalizeMessage(request.summary, targetMeta);
    const profile: string =
      (typeof targetMeta.profile === 'string' && (targetMeta.profile as string).trim()) ||
      (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
      'codex';
    const systemContext: string =
      typeof targetMeta.system === 'string' ? (targetMeta.system as string).trim() : '';
    const prompt: string = buildChatPrompt(message, systemContext);
    const chat: LlmResult = runChatLlm({ profile, prompt });
    respond({
      ok: true,
      plugin: 'unsafe_host_agent',
      mode: 'llm',
      profile: chat.profile,
      provider: chat.provider,
      model: chat.model,
      chat_prompt: message,
      chat_response: chat.text
    });
  }
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
