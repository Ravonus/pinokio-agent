# pinokio-agent UI

SvelteKit + Tailwind + HTMX UI layer for `pinokio-agent`.

## What it provides

- Strict JSON `UiModel` schema (`zod`) for agent-safe UI generation.
- Shared renderer for built-in and agent-generated dashboards.
- Built-in `form` block support for agent-driven setup pages.
- HTMX fragments for low-overhead live updates.

## Routes

- `/ui?view=health|config|configure|apps`
- `/ui/configure`
- `/ui/apps`
- `/ui/apps/:id`
- `/api/ui-model?view=health|config|configure|apps`
- `/api/configure`
- `/api/ui-form`
- `/fragments/health`
- `/fragments/config`

## Commands

Consumer startup (from repo root, through Rust app):

```sh
cargo run -- ui --configure
```

Contributor-only UI commands:

```sh
npm run dev
npm run check
npm run build
```
