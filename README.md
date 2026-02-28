# pinokio-agent (MVP)

Minimal Rust-first multi-agent orchestrator using Playwright workers, strict CRUD role split, optional auth, and extensible connection/plugin/hook SDK layers.

## What this is

- Rust manager is the central policy/coordination brain.
- Every task is executed by one or more short-lived agents.
- Agents are split by action (`create`, `read`, `update`, `delete`) when policy is enabled.
- Isolation is selected per agent (`host` vs `container`) from config + resource risk.
- Playwright is used only as a worker for web read actions.
- Connections, plugins, and hooks are command-based and run through manager-controlled flow.
- Optional auth/login and optional marketplace tracking are built-in but disabled by default.

This is intentionally small and opinionated, built as the `pinokio.ai` agent runtime baseline.

More detail: `docs/ARCHITECTURE.md`.

## Layout

- `src/main.rs`: CLI entry (`run`, `setup`, `configure`, `ui`, `login`, `logout`, `auth-status`, internal `agent` + `micro` modes).
- `src/manager.rs`: manager orchestration and socket protocol.
- `src/policy.rs`: planning rules (CRUD split, isolation, execution kind).
- `src/agent.rs`: agent runtime (playwright + plugin + connection + noop).
- `src/auth.rs`: optional auth/login provider + local session handling.
- `src/marketplace.rs`: optional external ecosystem event tracking.
- `src/llm.rs`: pluggable LLM layer (OpenAI-compatible, Anthropic, command/CLI).
- `src/runtime.rs`: host/docker/swarm orchestration for short-lived task agents.
- `src/ui_pages.rs`: manager-side publisher for agent-generated UI pages.
- `workers/playwright-service.mjs`: Node Playwright Chromium service (spawned/controlled by Rust).
- `plugins/echo-plugin.mjs`: example plugin command.
- `plugins/telegram-connection.mjs`: example connection command.
- `hooks/connection-router.mjs`: example extension hook command.
- `sdk/typescript/pinokio-sdk.mjs`: helper SDK for plugin/connection authors.
- `config/agent.toml`: default config (profiles/connectors/connections/policies/hooks/plugins/auth/marketplace).

## Runtime model

1. `run` command creates a `TaskRequest`.
2. Manager plans one or more `AgentSpec`s.
3. Each agent is spawned with host/container isolation.
4. Manager and agent communicate with JSON lines over unix sockets (or TCP bridge for macOS container agents).
5. Container agents run in `micro` mode by default.
6. Micro agents can request child tasks only through manager permission gates.
7. Micro agents can request manager-approved hook extensions (`hook_request`) through the same protocol.
8. Any subsystem can emit event hooks (`task.*`, `agent.*`, `runtime.*`, `cli.*`, `setup.*`, etc).
9. Manager aggregates all agent results into one task report.

## Quick start

1. Build/run Rust binary (requires Rust toolchain):

```bash
cargo run -- run --task "read pinokio.ai homepage title" --resource web --action read --target https://pinokio.ai
```

2. Optional explicit setup check (same checks are auto-run on `run`):

```bash
cargo run -- setup
```

3. Optional auth login (only needed if `auth.required=true`):

```bash
cargo run -- login
```

Example plugin task:

```bash
cargo run -- run --task "read plugin health" --resource plugin:echo --action read
```

Containerized chat plugin task (single-shot):

```bash
cargo run -- run --task "Explain Rust lifetimes simply" --resource plugin:chat_agent --action read --profile codex
```

Containerized child-chat-agent spawn (via plugin extension path):

```bash
cargo run -- run --task "Draft a release note intro" --resource plugin:chat_agent --action create --profile claude_code
```

Implementation note:
- `plugin:chat_agent` runs as a containerized orchestrator plugin and issues `spawn_child`.
- spawned child runs `plugin:chat_worker_agent` (containerized) for normal chat replies.
- optional `runtime:"unsafe_host"` delegates from `plugin:chat_worker_agent` to managed-only `plugin:unsafe_host_agent` on host.
- `plugin:unsafe_host_agent` cannot be invoked directly; it only accepts managed child requests.

Optional structured target for `plugin:chat_agent`:

```json
{"message":"Give me 3 commit message options","profile":"codex","system":"Keep it terse","runtime":"container"}
```

Connection task (example `connection:telegram`):

```bash
cargo run -- run --task "check telegram agent inbox" --resource connection:telegram --action read
```

Custom container image per task:

```bash
cargo run -- run --task "scan files safely" --resource filesystem --action read --image ghcr.io/pinokio-ai/sandbox:latest
```

Playwright runtime is managed by Rust via config/env (`PINOKIO_PLAYWRIGHT_SERVICE_COMMAND`, install command, timeout, container override).

## UI model layer (Svelte + Tailwind + HTMX)

This repo now includes a consumer-friendly UI shell in `ui/` with a strict JSON UI model that agents can target:

- `GET /api/ui-model?view=health|config|configure|apps`: typed `UiModel` JSON payloads.
- `/ui?view=health|config|configure|apps`: shared renderer for model-driven pages.
- `/ui/configure`: consumer configuration UI for OpenAI/Claude credentials plus extension-surface registration/removal.
- `/ui/apps` and `/ui/apps/:id`: system-published pages generated by agents/plugins/connections.
- `GET/POST /api/configure`: manager-side configure API used by the UI (`view=status|doctor|surfaces`, no task-agent spawn).
- `POST /api/ui-form`: built-in form submission endpoint for agent-generated pages.
- `/fragments/health` and `/fragments/config`: HTMX partial updates for lightweight live panels.

Start the UI through the Rust app:

```bash
cargo run -- ui --configure
```

Then open `http://127.0.0.1:5173/ui/configure`.

After startup, task execution can be done directly from the Configure UI (`Run Task From App` panel), so users do not need additional terminal commands.

OAuth command runtimes (`codex`, `claude`) are now bootstrapped automatically:
- missing CLI binaries are installed on-demand using OS-appropriate install commands
- containerized agents inherit host OAuth session state by mounting `~/.codex` / `~/.claude*` when present

The model schema and builders live in:

- `ui/src/lib/ui/model.ts`
- `ui/src/lib/ui/runtime.ts`
- `ui/src/lib/components/UiRenderer.svelte`

## Plug your LLM

Use app-driven commands (consumer flow):

```bash
# OpenAI API
cargo run -- configure openai --api-key "<OPENAI_KEY>"

# Claude API
cargo run -- configure claude-api --api-key "<ANTHROPIC_KEY>"

# Claude Code (OAuth command or direct token)
cargo run -- configure claude-code --oauth-command "claude auth token --json"
cargo run -- configure login --credential claude_code_main
```

`--api-key` can be omitted and the app will prompt securely via stdin.

Inspect configuration health:

```bash
cargo run -- configure doctor
cargo run -- configure status
```

## Agent-generated UI pages

Agents/plugins/connections can publish full pages by returning `ui_page` or `ui_pages` in their JSON result.
Manager writes them into `ui.pages_dir` and they appear automatically in `/ui/apps`.
`UiModel` now supports a `form` block, so agents can collect user input directly in these pages.

Payload contract:

```json
{
  "ui_page": {
    "id": "setup-wizard",
    "title": "Setup Wizard",
    "route": "/ui/apps/setup-wizard",
    "model": {
      "id": "setup-wizard",
      "title": "Setup Wizard",
      "sections": [
        {
          "id": "step-1",
          "title": "Collect input",
          "blocks": [
            { "type": "notice", "tone": "neutral", "message": "Tell me what to configure." }
          ]
        }
      ]
    }
  }
}
```

The same `UiModel` schema powers built-in views and these system-published pages.

Then open:

```text
/ui/apps
/ui/apps/<page-id>
```

By default the app reads/writes `~/.pinokio-agent/config.toml` (falls back to `config/agent.toml` in this repo).

Under the hood, config has two layers:

- `api_layers`: how to reach an LLM backend (`openai_compatible`, `anthropic_messages`, or `command` for CLI like Claude Code)
- `credentials`: API key/OAuth definitions (supports multiple keys and multiple credential entries)
- `llm_profiles`: model + limits + fallback that reference an `api_layer` and can override credential

Quick LLM test:

```bash
cargo run -- llm --profile codex --prompt "Summarize security controls for this agent runtime"
```

Task execution can use a profile directly:

```bash
cargo run -- run --task "plan a safe email audit" --resource email --action read --profile claude_code
```

Required env vars (by default):

- none required if you set tokens via `configure ...` commands
- optional env fallback is still supported via `credentials.<name>.env`

## Container agents

- Rust orchestrator spins up containers only when a task needs them.
- Supported backends: `docker` and `swarm`.
- Containers are short-lived and are removed after agent completion.
- Container agents run `micro` child runtime (`pinokio-agent micro ...`) by default.
- Per-task custom images are allowed by policy allowlist.
- Host binary injection lets containers run the installed Rust agent without requiring users to build custom images first.

`config/agent.toml`:

```toml
[orchestrator]
backend = "auto" # auto | docker | swarm
enabled = true
default_image = "ghcr.io/pinokio-ai/pinokio-agent-micro:local"
allow_custom_images = true
allowed_custom_image_prefixes = ["ghcr.io/pinokio-ai/", "mcr.microsoft.com/playwright", "alpine:"]
agent_entrypoint = "/usr/local/bin/pinokio-agent"
mounts = ["/tmp:/tmp"]
mount_workspace = true
workspace_mount_path = "/app"
swarm_poll_interval_ms = 1000
allow_backend_fallback = true
auto_init_swarm = false
auto_pull_images = true
inject_host_binary = true

[orchestrator.resource_images]
filesystem = "ghcr.io/pinokio-ai/pinokio-agent-micro:local"
plugins = "ghcr.io/pinokio-ai/pinokio-agent-micro:local"
connections = "ghcr.io/pinokio-ai/pinokio-agent-micro:local"
```

Manager child-spawn policy:

```toml
[manager]
child_spawn_enabled = true
child_spawn_max_depth = 2
child_spawn_container_only = true
hook_extensions_enabled = true
hook_extensions_container_only = true
```

Plugin-triggered child spawn (micro mode only):

- Plugin can return JSON with `spawn_child`:

```json
{
  "result": {"status": "ok"},
  "spawn_child": {
    "summary": "read account inbox headers",
    "resource": "email",
    "action": "read",
    "target": null,
    "container_image": null,
    "llm_profile": "claude_code"
  }
}
```

- Manager applies policy gates and either returns a child `TaskReport` or denies with reason.

Hook extension request (micro mode only):

```json
{
  "result": {"status": "ok"},
  "hook_request": {
    "name": "connection_router",
    "payload": {"connection": "telegram", "operation": "send_message"}
  }
}
```

- Manager checks plugin/connection capabilities + hook extension policy and then runs `[hooks.extensions.<name>]`.

System-wide event hooks:

- Configure `[hooks.events]` with wildcard or exact names:

```toml
[hooks.events."*"]
commands = ["node hooks/global-observer.mjs"]

[hooks.events."task.*"]
commands = ["node hooks/task-observer.mjs"]
timeout_ms = 15000
fail_open = true
max_retries = 1

[hooks.events."runtime.spawn.container.docker"]
commands = ["node hooks/runtime-spawn-audit.mjs"]
```

- Matching rules:
`"*"` = all events, `"prefix.*"` = prefix match, `"exact.name"` = exact.
- Hook env:
`PINOKIO_HOOK_EVENT`, `PINOKIO_HOOK_CONTEXT_JSON`.

## Optional Auth + Marketplace

- Auth is optional and disabled by default.
- Set `auth.enabled=true` and optionally `auth.required=true` to enforce login before `run`.
- `auth.provider=command` lets you swap auth backend with a single command (`auth.login_command` / `auth.logout_command`).
- Marketplace tracking is separate and optional (`[marketplace]`), disabled by default.

Example:

```toml
[auth]
enabled = true
required = false
provider = "command"
login_command = "pinokio-auth login --json"
logout_command = "pinokio-auth logout"

[marketplace]
enabled = false
endpoint = "https://api.pinokio.ai/v1/events"
api_key_env = "PINOKIO_MARKETPLACE_KEY"
source = "oss"
send_task_events = true
```

## Connections vs Plugins vs Hooks

- `connection:<name>`: external system bridge (Telegram, email, bank APIs, infra APIs).
- `plugin:<name>`: feature logic on top of core runtime behavior.
- `hooks`: manager-controlled extension points (named extension hooks and system-wide event hooks).

All three are command-driven, capability-gated, and policy-checked by manager.

## SDK

- TypeScript helper: `sdk/typescript/pinokio-sdk.mjs`
- Rust helper scaffold: `sdk/rust/src/lib.rs`

These helpers standardize request parsing and emitting `spawn_child` / `hook_request` payloads.

## Playwright + Chromium control (Rust-managed)

- Rust manager injects Playwright runtime settings into every agent process.
- Host/container can use different Playwright service commands.
- Optional Chromium auto-install can run before retrying failed Playwright execution.

`config/agent.toml`:

```toml
[playwright]
managed_by_rust = true
auto_install_node_deps = true
node_setup_command = "npm install --omit=dev"
auto_install_chromium = true
install_command = "npx playwright install chromium"
host_service_command = "node workers/playwright-service.mjs"
container_service_command = "docker run --rm -i --network host mcr.microsoft.com/playwright:v1.58.2-noble node /app/workers/playwright-service.mjs"
request_timeout_ms = 45000
```

## Security defaults

- `always_split_crud = true`
- high-risk resources default to container for non-read actions
- host-only connectors keep sensitive credentials local to host processes
- hooks/plugin/connection commands run only via manager-controlled execution paths
