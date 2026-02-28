const stage = process.env.PINOKIO_HOOK_STAGE || "";
const contextRaw = process.env.PINOKIO_HOOK_CONTEXT_JSON || "{}";
const context = JSON.parse(contextRaw);

if (!stage.startsWith("extension:")) {
  process.exit(0);
}

const payload = context?.request?.payload || {};
const connection = payload.connection || "unknown";
const operation = payload.operation || "unknown";

// Placeholder router: this is where marketplace/internal dispatch logic can live.
process.stderr.write(
  `[pinokio-hook] routed extension for connection=${connection} operation=${operation}\n`
);
process.exit(0);
