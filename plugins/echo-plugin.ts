const requestRaw = process.env.PINOKIO_PLUGIN_REQUEST_JSON || "{}";
const specRaw = process.env.PINOKIO_PLUGIN_SPEC_JSON || "{}";

const request: Record<string, unknown> = JSON.parse(requestRaw);
const spec: Record<string, unknown> = JSON.parse(specRaw);

const output = {
  ok: true,
  plugin: spec.plugin || "echo",
  resource: request.resource,
  action: request.action,
  message: `plugin handled task: ${request.summary}`
};

process.stdout.write(JSON.stringify(output));
