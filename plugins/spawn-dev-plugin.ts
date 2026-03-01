const requestRaw = process.env.PINOKIO_PLUGIN_REQUEST_JSON || "{}";
const request: Record<string, unknown> = JSON.parse(requestRaw);

const output = {
  status: "queued-child-spawn",
  hook_request: {
    name: "connection_router",
    payload: {
      connection: "telegram",
      operation: "inspect",
      note: "spawn-dev extension check"
    }
  },
  spawn_child: {
    summary: `micro child follow-up for: ${request.summary || "task"}`,
    resource: "web",
    action: "read",
    target: "https://pinokio.ai",
    container_image: null,
    llm_profile: (request.llm_profile as string) || null
  }
};

process.stdout.write(JSON.stringify(output));
