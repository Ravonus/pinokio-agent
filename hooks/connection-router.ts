const stage: string = process.env.PINOKIO_HOOK_STAGE || "";
const contextRaw: string = process.env.PINOKIO_HOOK_CONTEXT_JSON || "{}";
const context: Record<string, unknown> = JSON.parse(contextRaw);

if (!stage.startsWith("extension:")) {
  process.exit(0);
}

const requestObj = (context?.request ?? {}) as Record<string, unknown>;
const payload = (requestObj?.payload ?? {}) as Record<string, unknown>;
const connection: string = String(payload.connection || "unknown");
const operation: string = String(payload.operation || "unknown");

// Placeholder router: this is where marketplace/internal dispatch logic can live.
process.stderr.write(
  `[pinokio-hook] routed extension for connection=${connection} operation=${operation}\n`
);
process.exit(0);
