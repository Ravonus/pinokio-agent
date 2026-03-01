# Architecture

## Core design

- Manager is the only long-lived control plane.
- All task execution happens in short-lived task agents.
- Containerized task agents run a `micro` child runtime profile.
- Manager plans agents using policy rules:
  - CRUD split (`create`, `read`, `update`, `delete`)
  - host vs container isolation
  - execution mode (Playwright read, plugin command, noop)
  - connector + LLM profile assignment
- LLM profile resolution is separate from task policy:
  - profile -> api layer -> backend transport
  - supports OpenAI-compatible HTTP, Anthropic Messages API, and CLI command layers (for Claude Code style flows)

## Security model

- Read and write paths are separated by default (CRUD split policy).
- Connectors define required auth env vars and whether they are host-only.
- Host-only connectors force host execution.
- High-risk non-read actions default to container isolation.
- Hooks/plugins are not direct user-supplied code paths. They run from config through manager stages.

## Communication flow

1. User submits task to manager (`run` command).
2. Manager creates per-action agent specs.
3. Manager runs automatic preflight (Node/Playwright, Docker/Swarm, image pull when needed).
4. Manager spawns agent process.
5. Manager sends `ManagerMessage::Run` (includes child-runtime policy) over unix socket JSON line protocol.
6. Agent executes and returns `AgentMessage::Result|Error`.
7. Micro agents may emit `AgentMessage::SpawnChildRequest`; manager gates + executes or denies.
8. Manager aggregates into one `TaskReport`.

## Container orchestration

- Container lifecycle is manager-owned (spin up on task start, tear down on completion).
- Backends:
  - `docker`: one-shot `docker run --rm` task agents.
  - `swarm`: ephemeral `docker service create` with manager-side polling and automatic `service rm`.
- Image policy:
  - default image per install
  - optional per-resource image mapping
  - optional per-task custom image with prefix allowlist
- Container child runtime:
  - runs `pinokio-agent micro` by default
  - child agents cannot spawn directly; they request manager-mediated child spawns
  - manager applies depth + isolation gates before approving child spawns

## Playwright

- Playwright service is started by Rust (`workers/playwright-service.ts` by default).
- Rust picks host/container service command from config and injects runtime env into task agents.
- Chromium install policy is controlled by Rust config (`auto_install_chromium` + `install_command`).
- Service returns structured JSON (title/url/status for now).

## Planned next steps

- Signed agent attestation between manager and workers.
- Container-first default path with mandatory template (no fallback).
- Dedicated approval workflow for write/delete actions.
- Typed plugin SDK for Rust/Node workers.
