# Directory Plugin

The Directory Plugin (`pinokio.explorer`) lets sandbox/container chat agents inspect and mutate files/directories on the host through manager-mediated workers.

This plugin is designed so the sandbox bot does not directly mutate the host. The manager routes requests to split read/write workers with explicit permissions.

## What it does

- Display files and directories (discovery/read flow)
- Read path metadata and size info (`desired_action: "info"`)
- Create files or folders
- Update files/folders (write, append, rename, move)
- Delete files/folders
- Run constrained scripted ops through read->write handoff:
  - `delete_by_extension` (example: delete all `.rar`)
  - `cleanup` (desktop junk cleanup profile)
  - `zip_files_over_size` (archive files above threshold)
  - `run_script` (multi-step internal file-op workflow DSL)

## Manager-mediated model

- `explorer_agent` is the entry router and is `managed_only=true`.
- `explorer_read_agent` and `explorer_write_agent` are also `managed_only=true`.
- All Directory plugin agents are called as child tasks via manager, not as direct top-level plugin calls.
- Read worker publishes socket handoff context; write worker consumes that context before mutating.
- Scripted mutations must use read worker handoff candidates; write worker does not accept direct scripted mutation input.
- `run_script` defaults to requiring read handoff candidates (`require_handoff_matches=true`) and still enforces scope bounds.

## Manifest permissions required

`plugins/manifests/explorer.json` enables:

- `explorer_agent`: `read/create/update/delete` + `spawn_child=true` (routing only)
- `explorer_read_agent`: `read=true`, `filesystem_read=true`, `filesystem_write=false`
- `explorer_write_agent`: `read/create/update/delete`, `filesystem_read=true`, `filesystem_write=true`

These permissions allow sandbox chat to request filesystem operations through manager mediation.

## Host machine scope

- Directory operations apply to host paths that are mounted/exposed into the container runtime by manager.
- Always include `scope_dir` to constrain what the plugin may read/write.
- Use explicit `path` for mutations.

## Socket discovery for child agents

When sandbox chat agents need capabilities/docs, they should query socket channels:

1. Read catalog: `plugins:index`
2. Read plugin metadata: `plugin:pinokio.explorer:meta`
3. Read plugin README: `plugin:pinokio.explorer:readme`

## Channel-aware response contract (chat UI vs other clients)

Directory plugin responses are channel-aware so the same plugin call can adapt to different clients:

- `channel`: caller channel id (example: `ui_chat`, `telegram`)
- `response_format`: optional format hint (example: `ui_blocks`)
- `chat_response`: plain text fallback for clients that only support text
- `ui_blocks`: rich preview blocks for UI clients (default in `ui_chat`)

For `/ui/chat`, send:

- `channel: "ui_chat"`
- `response_format: "ui_blocks"`

`explorer_read_agent` then returns a file preview block with card-friendly item metadata:

- `type: "file_grid"`
- `items[]` with `name`, `kind`, `relative_path`, `size`, `modified_at`, `thumbnail`
- `total_count` and `shown_count`

The plugin should default to preview-first behavior for most read/info results in UI chat:

- return `ui_blocks` whenever `channel=ui_chat` (or `response_format=ui_blocks`)
- keep `chat_response` concise and human-readable
- include byte totals in both raw and friendly form (for example `615,065,601 bytes (586.57 MB)`)

For non-UI channels, the same call can ignore `ui_blocks` and use `chat_response`.

## Typical usage from chat/sandbox

Ask for `plugin:explorer_agent` with action `read|create|update|delete`.

The target JSON can include:

- `scope_dir`: allowed base directory
- `path`: explicit file/directory path
- `query`: discovery query if path is not explicit
- `desired_action`: `read|info|create|update|delete`
- `kind`: `file|directory` (for create)
- `operation`: `write|append|rename|move` (for update)
- `operation`: `create_pdf` (for create when generating PDF from text content)
- `content`: text for write/append/create file
- `new_name`, `destination`, `recursive`, `dry_run`
- scripted fields:
  - `extensions`: extension list for `delete_by_extension`
  - `cleanup_profile`: profile string for `cleanup`
  - `min_size_bytes`: threshold for `zip_files_over_size`
  - `archive_destination`: optional directory for zip output
  - `delete_source`: remove source after archive (default false)
  - `script`: object with `steps[]` for `run_script`
  - `require_handoff_matches`: optional bool (default true)

## Example intents

- Display directory contents:
  action `read`, target `{ "scope_dir": "/app", "query": "notes" }`
- Create file:
  action `create`, target `{ "scope_dir": "/app", "path": "notes/todo.md", "kind": "file", "content": "- item", "dry_run": false }`
- Rename file:
  action `update`, target `{ "scope_dir": "/app", "path": "notes/todo.md", "operation": "rename", "new_name": "todo-old.md" }`
- Delete directory recursively:
  action `delete`, target `{ "scope_dir": "/app", "path": "tmp/build-cache", "recursive": true }`
- Folder info/size:
  action `read`, target `{ "scope_dir": "/host/Documents", "path": "/host/Documents", "desired_action": "info" }`
- Readable size conversion follow-up:
  if the user asks "make `615065601 bytes` readable", respond with `615,065,601 bytes (586.57 MB)`
- Delete all `.rar` files in scope:
  action `delete`, target `{ "scope_dir": "/host/Desktop", "desired_action": "delete", "operation": "delete_by_extension", "extensions": ["rar"], "recursive": true }`
- Zip all files larger than 100MB:
  action `update`, target `{ "scope_dir": "/host/Documents", "desired_action": "update", "operation": "zip_files_over_size", "min_size_bytes": 104857600 }`
- Run a custom multi-step script (per read handoff candidate):
  action `update`, target `{ "scope_dir": "/host/Desktop", "desired_action": "update", "operation": "run_script", "query": ".rar", "script": { "steps": [ { "op": "zip_file", "path": "{{match.path}}", "for_each_match": true }, { "op": "delete_path", "path": "{{match.path}}", "for_each_match": true } ] } }`

## `run_script` step ops

Supported step `op` values:

- `mkdir`
- `write_file`
- `append_file`
- `create_pdf`
- `rename`
- `move`
- `copy_file`
- `delete_path`
- `zip_file`
- `ensure_packages` (install container packages with apt/apk/dnf/yum)
- `remove_packages` (uninstall container packages with apt/apk/dnf/yum)
- `restore_packages` (reinstall packages tracked in the local fallback ledger for current scope)

Package operations are guarded by manager policy:

- `manager.container_package_installs_enabled = true` is required
- installs/removals are synced by manager into Postgres (`pinokio_package_ledger` schema)
- local fallback ledger path remains available for container-only restore flow:
  `PINOKIO_PACKAGE_LEDGER_PATH` (default `/app/.pka/package-ledger.json`)

Templating in string fields supports:

- `{{scope_dir}}`
- `{{index}}`
- `{{match.path}}`, `{{match.name}}`, `{{match.kind}}`, `{{match.size}}`

## Example user prompts to sandbox chat

- "Use Directory Plugin to list files under `/app/projects`."
- "Use Directory Plugin to create `/app/projects/todo.md` with checklist content."
- "Use Directory Plugin to rename `/app/projects/todo.md` to `todo-archive.md`."
- "Use Directory Plugin to delete `/app/projects/tmp` recursively."

## Safety defaults

- Use `scope_dir` to constrain paths.
- Use `dry_run=true` first for preview/planning.
- Prefer explicit `path` for mutations to avoid ambiguity.
