# Directory Plugin (Explorer Compatibility)

This file is kept for compatibility. Current canonical docs are in `plugins/readmes/directory.md`.

The Directory Plugin (`pinokio.explorer`) lets sandbox/container chat agents inspect and mutate files/directories on the host through manager-mediated workers.

## Manager-mediated model

- `explorer_agent` is the entry router and is `managed_only=true`.
- `explorer_read_agent` and `explorer_write_agent` are `managed_only=true`.
- Manager routes child tasks to these workers; direct top-level calls are blocked.

## Socket channels

- Plugin catalog: `plugins:index`
- Plugin metadata: `plugin:pinokio.explorer:meta`
- Plugin README: `plugin:pinokio.explorer:readme`
- Explorer handoff session (dynamic): `explorer:<task-id>`

## Permissions summary

- Read worker: `read + filesystem_read`
- Write worker: `create/read/update/delete + filesystem_read + filesystem_write`
- Router: `spawn_child` to enforce read -> write workflow

## Safety notes

- Use `scope_dir` to constrain access.
- Use `dry_run=true` before mutations.
- Prefer explicit `path` for update/delete operations.
