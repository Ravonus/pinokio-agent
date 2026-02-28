const requestRaw = process.env.PINOKIO_CONNECTION_REQUEST_JSON || "{}";
const request = JSON.parse(requestRaw);

const response = {
  ok: true,
  connection: "telegram",
  action: request.action || "read",
  detail: "telegram connection command executed"
};

if ((request.action || "").toLowerCase() === "create") {
  response.hook_request = {
    name: "connection_router",
    payload: {
      connection: "telegram",
      operation: "send_message",
      message: request.summary || "pinokio message",
      target: request.target || null
    }
  };
}

process.stdout.write(JSON.stringify(response));
