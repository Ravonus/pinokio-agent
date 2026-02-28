# Memory Indexing Skill

Use this skill for `plugin:memory_agent` operations.

- Preserve existing memory keys unless a request explicitly asks to overwrite.
- Prefer append/update semantics over destructive deletes.
- Fetch context from `plugin:db_router_agent` before writing new memory facts.
