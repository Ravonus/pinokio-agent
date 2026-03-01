# pinokio-agent

Rust-first multi-agent orchestrator with plugin SDK, socket bus, live topology map, and container isolation. Plugins and workers can be written in **TypeScript or JavaScript**.

## What this is

- **Rust manager** is the central policy and coordination brain.
- Every task is executed by one or more short-lived **agents**.
- Agents are split by action (`create`, `read`, `update`, `delete`) when CRUD policy is enabled.
- Isolation is selected per agent (`host` vs `container`) from config and resource risk.
- **Playwright** is used as a managed worker for web read actions.
- Connections, plugins, and hooks are command-based and run through manager-controlled flow.
- Optional auth/login and optional marketplace tracking are built-in but disabled by default.
- Plugins and workers are written in TypeScript (or JavaScript) and executed via Node's native TS support (Node 23.6+).

Built as the [pinokio.ai](https://pinokio.ai) agent runtime baseline. More detail in `docs/ARCHITECTURE.md`.

## Requirements

- **Rust** toolchain (for building the manager binary)
- **Node.js 23.6+** (for native TypeScript execution without flags) or Node 22+ with `--experimental-strip-types`
- **Docker** (optional, for container agent isolation)

## Layout

```
src/                    Rust source (manager binary)
config/agent.toml       Runtime configuration
plugins/                TypeScript plugin agents
  manifests/            Plugin manifest JSON files (pinokio.plugin/v1)
  skills/               Markdown skill files injected into agent context
  readmes/              Human-readable plugin docs
workers/                TypeScript Playwright service
hooks/                  TypeScript event hook extensions
sdk/
  typescript/           Typed SDK for plugin/connection/hook authors
  rust/                 Rust scaffold for plugin authors
ui/                     Svelte + Tailwind frontend (topology map, config UI)
plugin-manifests/       External/starter plugin manifests
docs/                   Architecture docs
```

## Quick start

1. Build and run the Rust binary:

```bash
cargo run -- run --task "read pinokio.ai homepage title" --resource web --action read --target https://pinokio.ai
```

2. Start the UI:

```bash
cargo run -- ui --configure
```

Then open `https://127.0.0.1:5173/ui/configure`.

3. Example plugin task:

```bash
cargo run -- run --task "read plugin health" --resource plugin:echo --action read
```

4. Chat with LLM:

```bash
cargo run -- run --task "Explain Rust lifetimes simply" --resource plugin:chat_agent --action read --profile codex
```

## Writing plugins (TypeScript or JavaScript)

Plugins are short-lived Node processes invoked by the manager via `sh -c "node plugins/my-plugin.ts"`. Node 23.6+ runs `.ts` files natively. Users on Node 22 can use `--experimental-strip-types`.

### TypeScript plugin

```typescript
// plugins/my-plugin.ts
import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.ts';

try {
  const { request } = pluginContext();
  respond({
    ok: true,
    plugin: 'my_plugin',
    message: `handled: ${request.summary}`
  });
} catch (error: unknown) {
  fail(error instanceof Error ? error.message : String(error));
}
```

### JavaScript plugin

```javascript
// plugins/my-plugin.mjs
import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.ts';

try {
  const { request } = pluginContext();
  respond({
    ok: true,
    plugin: 'my_plugin',
    message: `handled: ${request.summary}`
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
```

Both `.ts` and `.mjs`/`.js` files work. Register your plugin in a manifest JSON file under `plugins/manifests/`.

### SDK exports

The SDK (`sdk/typescript/pinokio-sdk.ts`) provides:

| Function | Purpose |
|---|---|
| `pluginContext()` | Parse `PINOKIO_PLUGIN_REQUEST_JSON` and `PINOKIO_PLUGIN_SPEC_JSON` from env |
| `connectionContext()` | Parse connection request/spec/name from env |
| `respond(data)` | Write JSON result to stdout |
| `spawnChild(request)` | Emit `spawn_child` payload for manager-mediated child task |
| `requestHook(name, payload)` | Emit `hook_request` for named extension hooks |
| `socketPublish(channel, payload)` | Publish to socket bus channel |
| `socketRead(channel, options)` | Read from socket bus channel |
| `socketConsume(channel, options)` | Consume from socket bus channel |
| `fail(message)` | Write error to stderr and exit |

### Plugin manifest

```json
{
  "api_version": "pinokio.plugin/v1",
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "plugins": [
    {
      "name": "my_plugin",
      "command": "node plugins/my-plugin.ts",
      "host_only": false,
      "allowed_actions": ["read", "create"],
      "permissions": {
        "create": true,
        "read": true,
        "spawn_child": false,
        "network": false
      }
    }
  ]
}
```

## Runtime model

1. `run` command creates a `TaskRequest`.
2. Manager plans one or more `AgentSpec`s (CRUD split, isolation, execution kind).
3. Each agent is spawned with host or container isolation.
4. Manager and agent communicate via JSON lines over unix sockets.
5. Container agents run in `micro` mode by default.
6. Micro agents can request child tasks through manager permission gates.
7. Manager aggregates all agent results into one task report.

## Plugin output protocol

Plugins write JSON to stdout. The manager looks for extension keys:

| JSON Key | Meaning |
|---|---|
| `spawn_child` | Request manager to spawn a child task |
| `hook_request` | Request a named extension hook |
| `socket_request` | Socket bus publish/read/consume |
| `ui_page` / `ui_pages` | Publish agent-generated UI pages |
| (anything else) | Task result data |

## Socket bus

The socket bus is a file-backed JSONL message system in `.pka/socket-bus/`. Plugins can publish and consume messages across channels. The topology map visualizes live socket bus activity with flowing edge animations.

## Topology map

The `/ui/map` page shows a live network topology of all agents, plugins, services, and connections. Features:

- Force-directed graph layout with D3
- Plugin group drill-down (click a group node to see its agents)
- Live activity visualization (flowing dots on edges from socket bus data)
- Activity feed panel showing recent socket bus messages
- Auto-refresh every 30s (topology) and 5s (activity)

## LLM configuration

```bash
# OpenAI API
cargo run -- configure openai --api-key "<OPENAI_KEY>"

# Claude API
cargo run -- configure claude-api --api-key "<ANTHROPIC_KEY>"

# Claude Code (OAuth)
cargo run -- configure claude-code --oauth-command "claude auth token --json"

# Health check
cargo run -- configure doctor
```

LLM profiles are defined in `config/agent.toml` under `[llm_profiles.*]`. Each profile references an `api_layer` (OpenAI-compatible, Anthropic Messages, or CLI command) and optionally a credential.

## Container agents

- Rust orchestrator spins up containers only when a task needs them.
- Supported backends: `docker` and `swarm`.
- Containers are short-lived and removed after agent completion.
- Host binary injection lets containers run the installed Rust agent without custom images.
- Per-task custom images are allowed by policy allowlist.

## Event hooks

```toml
[hooks.events."task.*"]
commands = ["node hooks/task-observer.ts"]
timeout_ms = 15000
fail_open = true
```

Hook env: `PINOKIO_HOOK_EVENT`, `PINOKIO_HOOK_CONTEXT_JSON`.

## Connections vs Plugins vs Hooks

| Kind | Purpose | Example |
|---|---|---|
| `connection:<name>` | External system bridge | Telegram, email, bank APIs |
| `plugin:<name>` | Feature logic on core runtime | Chat agent, database agent, explorer |
| `hooks` | Manager-controlled extension points | Event observers, connection routers |

All three are command-driven, capability-gated, and policy-checked by the manager.

## Built-in plugins

| Plugin | Description |
|---|---|
| `chat_agent` / `chat_worker_agent` | LLM-backed chat orchestration with child-spawn |
| `explorer_agent` / `explorer_read_agent` / `explorer_write_agent` | Safe directory read/write with split workers |
| `postgres_agent` / `db_router_agent` / `db_role_agent` | PostgreSQL with CRUD role split |
| `memory_agent` | Namespaced memory system on Postgres |
| `unsafe_host_agent` | Privileged host operations (managed-only) |
| `echo` | Smoke-test echo plugin |

## Security defaults

- `always_split_crud = true` — read and write paths are separated by default
- High-risk resources default to container for non-read actions
- Host-only connectors keep sensitive credentials local to host processes
- Hooks/plugin/connection commands run only via manager-controlled execution paths
- `unsafe_host_agent` cannot be invoked directly; only through managed child requests

## License

MIT
