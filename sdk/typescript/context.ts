import type { PluginContext, PluginRequest, PluginSpec, ConnectionContext, ConnectionRequest, ConnectionSpec } from './types.ts';

/** Parse a JSON string from an environment variable, returning fallback on failure. */
export function parseJsonEnv(name: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Read plugin request and spec from environment variables. */
export function pluginContext(): PluginContext {
  return {
    request: parseJsonEnv("PINOKIO_PLUGIN_REQUEST_JSON", {}) as unknown as PluginRequest,
    spec: parseJsonEnv("PINOKIO_PLUGIN_SPEC_JSON", {}) as unknown as PluginSpec,
  };
}

/** Read connection request, spec, and name from environment variables. */
export function connectionContext(): ConnectionContext {
  return {
    request: parseJsonEnv("PINOKIO_CONNECTION_REQUEST_JSON", {}) as unknown as ConnectionRequest,
    spec: parseJsonEnv("PINOKIO_CONNECTION_SPEC_JSON", {}) as unknown as ConnectionSpec,
    name: process.env.PINOKIO_CONNECTION_NAME || null,
  };
}
