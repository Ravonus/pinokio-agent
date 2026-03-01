import type { SocketRequest, SocketReadOptions } from './types.ts';
import { respond } from './response.ts';

/** Emit a single socket bus operation. */
export function requestSocket(socketRequest: SocketRequest, base: Record<string, unknown> = {}): void {
  respond({
    ...base,
    socket_request: socketRequest,
  });
}

/** Emit multiple socket bus operations in a single response. */
export function requestSockets(socketRequests: SocketRequest[], base: Record<string, unknown> = {}): void {
  respond({
    ...base,
    socket_requests: Array.isArray(socketRequests) ? socketRequests : [],
  });
}

/** Publish a message to a socket bus channel. */
export function socketPublish(channel: string, payload: unknown, base: Record<string, unknown> = {}): void {
  requestSocket(
    { op: 'publish', channel, payload },
    base
  );
}

/** Read messages from a socket bus channel. */
export function socketRead(channel: string, options: SocketReadOptions = {}, base: Record<string, unknown> = {}): void {
  requestSocket(
    {
      op: 'read',
      channel,
      max_messages: options.max_messages,
      since_seq: options.since_seq,
      sender_filter: options.sender_filter,
    },
    base
  );
}

/** Consume messages from a socket bus channel (marks them as read). */
export function socketConsume(channel: string, options: SocketReadOptions = {}, base: Record<string, unknown> = {}): void {
  requestSocket(
    {
      op: 'consume',
      channel,
      max_messages: options.max_messages,
      since_seq: options.since_seq,
      sender_filter: options.sender_filter,
    },
    base
  );
}

function socketPluginToken(value: unknown): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'plugin';
}

/** Read the manager-published plugin catalog from the socket bus. */
export function socketReadPluginCatalog(options: SocketReadOptions = {}, base: Record<string, unknown> = {}): void {
  const channel = process.env.PINOKIO_SOCKET_PLUGINS_INDEX_CHANNEL || 'plugins:index';
  socketRead(
    channel,
    {
      max_messages: options.max_messages ?? 1,
      since_seq: options.since_seq,
      sender_filter: options.sender_filter ?? 'manager'
    },
    base
  );
}

/** Read a specific plugin's metadata from the socket bus. */
export function socketReadPluginMeta(manifestId: string, options: SocketReadOptions = {}, base: Record<string, unknown> = {}): void {
  const token = socketPluginToken(manifestId);
  socketRead(
    `plugin:${token}:meta`,
    {
      max_messages: options.max_messages ?? 1,
      since_seq: options.since_seq,
      sender_filter: options.sender_filter ?? 'manager'
    },
    base
  );
}

/** Read a specific plugin's readme from the socket bus. */
export function socketReadPluginReadme(manifestId: string, options: SocketReadOptions = {}, base: Record<string, unknown> = {}): void {
  const token = socketPluginToken(manifestId);
  socketRead(
    `plugin:${token}:readme`,
    {
      max_messages: options.max_messages ?? 1,
      since_seq: options.since_seq,
      sender_filter: options.sender_filter ?? 'manager'
    },
    base
  );
}
