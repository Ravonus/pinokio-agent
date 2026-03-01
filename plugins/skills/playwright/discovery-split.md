# Playwright Discovery Split

Use this skill when automating websites through `pinokio.playwright`.

## Core contract

1. `playwright_read_agent` discovers and plans.
2. `playwright_write_agent` executes only approved actions.
3. Prefer API/session-backed actions before UI clicks/forms.
4. If anti-bot or manual checkpoints appear, request a user step with clear instructions.

## Planning order

1. Identify goal and target URL.
2. Run discovery snapshot.
3. Attempt network/API plan first.
4. Add UI fallback actions with explicit selectors and waits.
5. Validate with an extract/assert action before and after mutation.

## Action style

- deterministic selectors
- explicit waits
- small action batches
- no hidden side effects

## Safety defaults

- do not execute write actions from read agent
- require explicit user confirmation for destructive mutations
- keep credentials/session in browser context only
- avoid arbitrary evaluate code unless unsafe mode is explicitly enabled
