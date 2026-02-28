function parseJsonEnv(name, fallback = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function pluginContext() {
  return {
    request: parseJsonEnv("PINOKIO_PLUGIN_REQUEST_JSON", {}),
    spec: parseJsonEnv("PINOKIO_PLUGIN_SPEC_JSON", {}),
  };
}

export function connectionContext() {
  return {
    request: parseJsonEnv("PINOKIO_CONNECTION_REQUEST_JSON", {}),
    spec: parseJsonEnv("PINOKIO_CONNECTION_SPEC_JSON", {}),
    name: process.env.PINOKIO_CONNECTION_NAME || null,
  };
}

export function respond(data) {
  process.stdout.write(JSON.stringify(data));
}

export function spawnChild(request, base = {}) {
  respond({
    ...base,
    spawn_child: request,
  });
}

export function requestHook(name, payload, base = {}) {
  respond({
    ...base,
    hook_request: { name, payload },
  });
}

export function requestSocket(socketRequest, base = {}) {
  respond({
    ...base,
    socket_request: socketRequest,
  });
}

export function requestSockets(socketRequests, base = {}) {
  respond({
    ...base,
    socket_requests: Array.isArray(socketRequests) ? socketRequests : [],
  });
}

export function socketPublish(channel, payload, base = {}) {
  requestSocket(
    {
      op: 'publish',
      channel,
      payload,
    },
    base
  );
}

export function socketRead(channel, options = {}, base = {}) {
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

export function socketConsume(channel, options = {}, base = {}) {
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

function socketPluginToken(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'plugin';
}

export function socketReadPluginCatalog(options = {}, base = {}) {
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

export function socketReadPluginMeta(manifestId, options = {}, base = {}) {
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

export function socketReadPluginReadme(manifestId, options = {}, base = {}) {
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

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
