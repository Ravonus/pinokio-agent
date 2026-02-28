# Database Router Skill

Use this skill when working through `plugin:db_router_agent`.

- Route read-only requests to `plugin:db_read_agent`.
- Route mutating requests to `plugin:db_write_agent`.
- Keep SQL bounded to the requested namespace and target resource.
