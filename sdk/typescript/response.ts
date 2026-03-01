import type { SpawnChildRequest } from './types.ts';

/** Write a JSON result object to stdout (the plugin output protocol). */
export function respond(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data));
}

/** Emit a spawn_child request for manager-mediated child task creation. */
export function spawnChild(request: SpawnChildRequest, base: Record<string, unknown> = {}): void {
  respond({
    ...base,
    spawn_child: request,
  });
}

/** Emit a hook_request for a named extension hook. */
export function requestHook(name: string, payload: Record<string, unknown>, base: Record<string, unknown> = {}): void {
  respond({
    ...base,
    hook_request: { name, payload },
  });
}

/** Write an error message to stderr and exit with code 1. */
export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
