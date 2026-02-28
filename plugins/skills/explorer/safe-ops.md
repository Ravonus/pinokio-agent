# Explorer Safe Ops Skill

Use this skill with `plugin:explorer_read_agent` and `plugin:explorer_write_agent`.

- Read and verify full paths before any mutation.
- Avoid destructive operations when a move/rename achieves the same goal.
- Keep changes scoped to explicitly requested directories.
- For `run_script`, prefer `for_each_match` + `{{match.path}}` from read handoff over hard-coded absolute paths.
