import { fail } from '../../sdk/typescript/pinokio-sdk.ts';
import { asOptionalString, normalizeAction } from '../plugin-utils.ts';
import {
  type TargetMeta,
  normalizeScriptOperation,
  toPositiveInt
} from './shared.ts';

export interface SocketHandoffResult {
  targetMeta: TargetMeta;
  handoff: {
    channel: string | null;
    sender_agent_id: string | null;
    seq: number;
    request_id: string | null;
    message_count: number;
  } | null;
}

function extractSocketResultPayload(targetMeta: TargetMeta): Record<string, unknown> | null {
  const unwrap = (candidate: unknown): Record<string, unknown> | null => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }
    const direct = candidate as Record<string, unknown>;
    if (Array.isArray(direct.messages)) {
      return direct;
    }
    const nested = direct.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedObj = nested as Record<string, unknown>;
      if (Array.isArray(nestedObj.messages)) {
        return nestedObj;
      }
    }
    return null;
  };

  const direct = unwrap(targetMeta.__socket_result);
  if (direct) {
    return direct;
  }

  const all = Array.isArray(targetMeta.__socket_results) ? targetMeta.__socket_results : [];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const resolved = unwrap(all[i]);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function applySocketHandoff(targetMeta: TargetMeta, desiredAction: string): SocketHandoffResult {
  const socketResult = extractSocketResultPayload(targetMeta);
  if (!socketResult) {
    const requireMatches = targetMeta?.require_handoff_matches === true;
    const hasFallbackMatches = Array.isArray(targetMeta?.handoff_matches);
    if (requireMatches && !hasFallbackMatches) {
      fail('missing socket consume payload (__socket_result/__socket_results) from explorer read handoff');
    }
    return {
      targetMeta,
      handoff: null
    };
  }

  const messages = Array.isArray(socketResult.messages) ? socketResult.messages : [];
  if (messages.length === 0) {
    const channel = asOptionalString(socketResult.channel) || asOptionalString(targetMeta.socket_channel);
    fail(
      `socket consume returned no messages${channel ? ` on channel '${channel}'` : ''}. retry request after read agent publishes handoff`
    );
  }

  const envelope = messages[messages.length - 1] as Record<string, unknown>;
  const payload =
    envelope && envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload as Record<string, unknown>
      : null;
  if (!payload) {
    fail('socket handoff payload is missing or malformed');
  }
  if (String(payload.schema || '') !== 'pinokio.explorer.handoff/v1') {
    fail('socket handoff payload schema mismatch');
  }

  const payloadAction = normalizeAction(payload.desired_action || '');
  if (!payloadAction || payloadAction !== desiredAction) {
    fail(
      `socket handoff action mismatch: expected '${desiredAction}', received '${payloadAction || 'unknown'}'`
    );
  }

  const options = payload.options && typeof payload.options === 'object' ? payload.options as Record<string, unknown> : {};

  const merged: TargetMeta = { ...targetMeta };
  if (!asOptionalString(merged.scope_dir) && asOptionalString(payload.scope_dir)) {
    merged.scope_dir = payload.scope_dir;
  }
  if (!asOptionalString(merged.query) && asOptionalString(payload.query)) {
    merged.query = payload.query;
  }
  if (!asOptionalString(merged.resolved_path) && asOptionalString(payload.resolved_path)) {
    merged.resolved_path = payload.resolved_path;
  }
  if (!asOptionalString(merged.path) && asOptionalString(payload.resolved_path)) {
    merged.path = payload.resolved_path;
  }
  if (!asOptionalString(merged.operation) && asOptionalString(options.operation)) {
    merged.operation = normalizeScriptOperation(options.operation);
  } else if (asOptionalString(merged.operation)) {
    merged.operation = normalizeScriptOperation(merged.operation);
  }
  if (!asOptionalString(merged.kind) && asOptionalString(options.kind)) {
    merged.kind = options.kind;
  }
  if (typeof merged.content !== 'string' && typeof options.content === 'string') {
    merged.content = options.content;
  }
  if (typeof merged.overwrite !== 'boolean' && typeof options.overwrite === 'boolean') {
    merged.overwrite = options.overwrite;
  }
  if (typeof merged.ensure_parent !== 'boolean' && typeof options.ensure_parent === 'boolean') {
    merged.ensure_parent = options.ensure_parent;
  }
  if (!asOptionalString(merged.new_name) && asOptionalString(options.new_name)) {
    merged.new_name = options.new_name;
  }
  if (!asOptionalString(merged.destination) && asOptionalString(options.destination)) {
    merged.destination = options.destination;
  }
  if (typeof merged.recursive !== 'boolean' && typeof options.recursive === 'boolean') {
    merged.recursive = options.recursive;
  }
  if (typeof merged.dry_run !== 'boolean' && typeof options.dry_run === 'boolean') {
    merged.dry_run = options.dry_run;
  }
  if (!merged.extensions && options.extensions) {
    merged.extensions = options.extensions;
  }
  if (!asOptionalString(merged.cleanup_profile) && asOptionalString(options.cleanup_profile)) {
    merged.cleanup_profile = options.cleanup_profile;
  }
  if (!toPositiveInt(merged.min_size_bytes) && toPositiveInt(options.min_size_bytes)) {
    merged.min_size_bytes = toPositiveInt(options.min_size_bytes);
  }
  if (!asOptionalString(merged.archive_destination) && asOptionalString(options.archive_destination)) {
    merged.archive_destination = options.archive_destination;
  }
  if (typeof merged.delete_source !== 'boolean' && typeof options.delete_source === 'boolean') {
    merged.delete_source = options.delete_source;
  }
  if (!Array.isArray(merged.handoff_matches) && Array.isArray(payload.matches)) {
    merged.handoff_matches = payload.matches;
  }
  if (!merged.script_plan && payload.script_plan && typeof payload.script_plan === 'object') {
    merged.script_plan = payload.script_plan;
  }
  if (!merged.script && options.script) {
    merged.script = options.script;
  }
  if (
    typeof merged.require_handoff_matches !== 'boolean' &&
    typeof options.require_handoff_matches === 'boolean'
  ) {
    merged.require_handoff_matches = options.require_handoff_matches;
  }

  return {
    targetMeta: merged,
    handoff: {
      channel: asOptionalString(socketResult.channel) || asOptionalString(targetMeta.socket_channel),
      sender_agent_id: asOptionalString(envelope.sender_agent_id),
      seq: Number(envelope.seq || 0),
      request_id: asOptionalString(payload.request_id),
      message_count: messages.length
    }
  };
}
