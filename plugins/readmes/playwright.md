# Playwright Browser Automation Plugin

`pinokio.playwright` adds browser automation through a split safety model:

- `playwright_read_agent` discovers and plans
- `playwright_write_agent` executes web mutations
- optional `playwright_unsafe_agent` can run unrestricted browser automation when explicitly enabled

This mirrors the explorer safety pattern so one agent is discovery-first and the other performs the risky write actions.

## Safety model

- Default path is read->write split through manager mediation.
- Read agent does:
  - page discovery (DOM summary, network summary, challenge/bot detection)
  - action planning (with LLM when needed)
  - user checkpoint prompts when a manual step is required
- Write agent does:
  - API-first attempts (session-backed browser fetch) when provided
  - then browser action execution
  - optional headful retry if anti-bot flow is detected
- Unsafe mode is separate and off by default:
  - `plugin:playwright_unsafe_agent`
  - requires `PINOKIO_PLAYWRIGHT_UNSAFE_ENABLED=1`

## Manifest permissions

`plugins/manifests/playwright.json` configures:

- `playwright_agent`: routes tasks to read/write/unsafe resources
- `playwright_read_agent`: read/discovery/planning, no direct mutation
- `playwright_write_agent`: mutation execution only
- `playwright_unsafe_agent`: host-only unrestricted browser runtime (explicit opt-in)

## Discovery mode

Read agent runs discovery before mutation:

- title/url snapshot
- interactive element counts
- recent network request summary with normalized API candidates
- anti-bot/challenge hints (Cloudflare/CAPTCHA style checks)
- optional in-page probe overlay (click-to-label fields/buttons for reusable selector hints)

Label overlay data is persisted in the browser context (`localStorage`) and returned as `probe_labels` so LLM planning can target labeled elements instead of brittle selectors.

Action-required responses now include a structured `notify` payload, which the chat UI can surface as browser notifications (OS-level notification center).

If the workflow needs user interaction (login/2FA/challenge), read agent returns a user-step question instead of forcing execution.

For cleanup-style workflows (email/messages/social queues), read agent now enforces:

1. policy clarification (what is junk, scope, protected senders/folders)
2. pilot approval (`PILOT ARCHIVE 1` or `PILOT DELETE 1`)
3. only then mutation planning/execution

This keeps destructive actions gated by explicit user approval.

## Probe + Skill Workflow

Playwright now supports a probe-first loop that can be converted into installable skills:

1. Run discovery in chat (`plugin:playwright_agent` -> read flow).
2. Agent probes page structure/network and asks user clarifying policy questions before risky mutations.
3. User can say things like "convert this probe to a skill" (optionally with a name).
4. Read agent writes a generated markdown skill under:
   - `plugins/skills/playwright/generated/<skill-name>.md`
5. It then attempts `pinokio-agent configure skill-add ...` so the skill appears in `/ui/skills`.

If auto-register fails, the response includes the exact command so user/manager can run it manually.

## API-first strategy

Planner can emit:

- `api_attempts` for direct in-session fetch calls
- `actions` for UI automation fallback

Write agent applies API attempts first, then UI actions.

Discovery output includes `network_summary.candidates` (method/path templates + host/query keys). Planner now gets this explicitly and should prefer API attempts when candidates are viable.

Helpful probe prompts in chat:

- `SHOW CANDIDATES`
- `Enable label mode ...`
- `Use saved labels ...`
- `convert this probe to a skill`

## Notifications

- Plugin side: best-effort host notifications (when runtime allows) for checkpoint/policy/pilot prompts.
- UI side: browser Notification API support for action-required replies from Playwright read-agent.
- Result: users can keep focus in automation windows and still get prompt/next-step alerts.

## User context + stealth

Plugin supports:

- user browser context (`use_user_context`)
- default policy: authenticated tasks use user context + non-headless
- public/non-auth tasks fall back to isolated container browser context
- explicit user-context gate (`allow_user_context=true`)
- domain allowlist gate (`playwright.user_context_domain_allowlist`)
- persistent browser profile directory (`user_data_dir`)
- stealth hardening in worker
- optional OS notifications for user prompts (policy/checkpoint/pilot approvals)
- optional stealth libraries:
  - `playwright-extra`
  - `playwright-extra-plugin-stealth`

Default policy settings are in `[playwright]` in `config/agent.toml`:

- `default_use_user_context = true`
- `default_headless = false`
- `require_user_context_permission = true`
- `container_fallback_non_auth = true`
- `user_context_domain_allowlist = [...]`
- `user_context_dir = "~/.pinokio-agent/playwright-profile"`

## Skills

Attach site-specific workflow skills to the plugin (for example: Gmail triage, Twitch moderation, CRM automation).
Skills should define repeatable action patterns while still using this plugin’s read/write split execution model.

## Socket/plugin discovery for child agents

When sandbox agents need to understand capabilities:

1. Read plugin catalog: `plugins:index`
2. Read plugin metadata: `plugin:pinokio.playwright:meta`
3. Read plugin README: `plugin:pinokio.playwright:readme`

## Example target shape

```json
{
  "url": "https://mail.google.com/",
  "desired_action": "update",
  "plan_with_llm": true,
  "use_user_context": true,
  "headless": false,
  "capture_screenshot": true,
  "skill_hints": [
    "Use inbox filters first",
    "Never send messages without explicit confirmation"
  ]
}
```
