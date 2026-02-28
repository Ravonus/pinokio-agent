import { spawnSync } from 'node:child_process';
import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_MODES = new Set(['llm', 'command']);

function firstJsonStart(text) {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  if (firstObject === -1) return firstArray;
  if (firstArray === -1) return firstObject;
  return Math.min(firstObject, firstArray);
}

function parseJsonOutput(raw) {
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

function parseTargetMeta(target) {
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
  return parsed;
}

function normalizeMessage(summary, targetMeta) {
  const targetMessage =
    typeof targetMeta.message === 'string' ? targetMeta.message.trim() : '';
  if (targetMessage) {
    return targetMessage;
  }

  const summaryText = typeof summary === 'string' ? summary.trim() : '';
  if (summaryText) {
    return summaryText;
  }

  return 'Hello';
}

function ensureManagedInvocation(request) {
  const callerTask = typeof request.caller_task_id === 'string' ? request.caller_task_id.trim() : '';
  const callerAgent = typeof request.caller_agent_id === 'string' ? request.caller_agent_id.trim() : '';
  const callerResource =
    typeof request.caller_resource === 'string' ? request.caller_resource.trim() : '';

  if (!callerTask || !callerAgent || !callerResource) {
    fail('unsafe_host_agent is managed-only and cannot be invoked directly');
  }

  const allowedCallers = String(process.env.PINOKIO_UNSAFE_ALLOWED_CALLERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedCallers.length > 0 && !allowedCallers.includes(callerResource)) {
    fail(
      `unsafe_host_agent caller '${callerResource}' is not allowed (allowed: ${allowedCallers.join(', ')})`
    );
  }
}

function normalizeMode(value) {
  const mode = String(value || 'llm').trim().toLowerCase();
  if (!SUPPORTED_MODES.has(mode)) {
    fail(`unsupported unsafe_host_agent mode '${mode}'`);
  }
  return mode;
}

function resolveAgentBinary() {
  const candidates = [
    process.env.PINOKIO_AGENT_BIN,
    'pinokio-agent',
    '/usr/local/bin/pinokio-agent',
    './target/debug/pinokio-agent',
    './target/release/pinokio-agent'
  ].filter(Boolean);

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

function runChatLlm({ profile, prompt }) {
  const agentBin = resolveAgentBinary();
  const out = spawnSync(agentBin, ['llm', '--profile', profile, '--prompt', prompt], {
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

  const payload = parseJsonOutput(out.stdout);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('unsafe host llm command returned non-JSON output');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    throw new Error('unsafe host llm response was empty');
  }

  return {
    text,
    profile,
    provider: typeof payload.provider === 'string' ? payload.provider : 'unknown',
    model: typeof payload.model === 'string' ? payload.model : 'unknown'
  };
}

function runHostCommand(command) {
  const out = spawnSync('sh', ['-lc', command], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024 * 4
  });
  if (out.error) {
    throw new Error(`failed running host command: ${out.error.message}`);
  }
  if (out.status !== 0) {
    const detail = (out.stderr || out.stdout || '').trim();
    throw new Error(`host command failed (${out.status}): ${detail}`);
  }
  return {
    stdout: String(out.stdout || '').trim(),
    stderr: String(out.stderr || '').trim(),
    status: out.status ?? 0
  };
}

function buildChatPrompt(message, systemContext) {
  const blocks = [
    'You are a dedicated chat agent running with host-level tools.',
    'Reply directly to the user in a concise, practical style.',
    systemContext ? `System context:\n${systemContext}` : '',
    `User message:\n${message}`
  ];
  return blocks.filter(Boolean).join('\n\n');
}

try {
  const { request } = pluginContext();
  ensureManagedInvocation(request);

  const targetMeta = parseTargetMeta(request.target);
  const mode = normalizeMode(targetMeta.mode);

  if (mode === 'command') {
    const command = typeof targetMeta.command === 'string' ? targetMeta.command.trim() : '';
    if (!command) {
      fail('unsafe_host_agent command mode requires target.command');
    }
    const result = runHostCommand(command);
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
    const message = normalizeMessage(request.summary, targetMeta);
    const profile =
      (typeof targetMeta.profile === 'string' && targetMeta.profile.trim()) ||
      (typeof request.llm_profile === 'string' && request.llm_profile.trim()) ||
      'codex';
    const systemContext =
      typeof targetMeta.system === 'string' ? targetMeta.system.trim() : '';
    const prompt = buildChatPrompt(message, systemContext);
    const chat = runChatLlm({ profile, prompt });
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
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
