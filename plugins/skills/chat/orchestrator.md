# Chat Orchestrator Skill

Use this skill when routing chat tasks through `plugin:chat_agent` and `plugin:chat_worker_agent`.

- Keep user-facing replies concise.
- Delegate heavy tool work to `plugin:chat_worker_agent` with explicit child requests.
- Never escalate to `plugin:unsafe_host_agent` unless manager policy and task scope explicitly allow it.
