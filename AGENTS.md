# AGENTS.md

**plot** is a [pi](https://github.com/earendil-works/pi) extension that adds a plan mode — a phase where edits are restricted to `.pi/plans/`, so the agent explores and drafts a plan before getting full write access.

## State Machine

Two modes. Transitions are explicit.

```
                  /plan or Shift+Tab
                  ─────────────────────────────►
        EXECUTE                                    PLAN
                  ◄─────────────────────────────
                  /plan or Shift+Tab

PLAN ──/approve──► fresh child session in EXECUTE,
                   seeded with the plan file as the
                   first user message
```

The current mode is stored as a `plot-mode` custom session entry. `getMode` walks the session branch backwards and returns the most recent entry's mode, defaulting to `execute` when no entry exists. Sessions always start in execute mode; the user opts into plan mode explicitly.

## Enforcement

Plan mode is enforced by a `tool_call` hook. When the agent calls `edit` or `write` with a path outside `.pi/plans/`, the hook returns `{ block: true, reason: ... }` and the call never runs. All other tools (`read`, `bash`, ...) are untouched — the agent explores normally.

This is a soft fence, not a sandbox. The agent could shell out via `bash` to write files; the goal is to make the default path read-only, not to prevent a determined agent from escaping.

## Plan tracking

A `tool_result` hook watches successful `edit`/`write` calls. If the written path is under `.pi/plans/`, plot appends a `plot-plan` custom entry pointing at the absolute path. `getCurrentPlanPath` returns the most recent one.

There is no dedicated `write_plan` tool — the agent uses ordinary `write`/`edit` and the location decides whether it counts as a plan.

## Commands

### `/plan`

Toggles between plan and execute. Appends a `plot-mode` entry and sends a `customType: "plot"` system message (`triggerTurn: false`) announcing the change. Also bound to `Shift+Tab`.

### `/approve`

Plan mode only. Reads the current plan file, then calls `ctx.newSession({ parentSession, withSession })` to start a fresh child session. `withSession` only calls `sendUserMessage(planContent)` — the child session has no `plot-mode` entries, so `getMode` returns `execute` by default, and `session_start` re-runs `applyMode` from a fresh extension load.

The `withSession` callback must not call methods on the outer `pi` (e.g. `pi.appendEntry`) — that `pi` is bound to the parent `AgentSession`, which pi disposes before invoking the callback. Use `replacementCtx` for anything that needs to target the child session.

If there's no current plan path, `/approve` notifies the user and aborts.

## Requirements

None beyond pi. No tmux, no external tools, no network.
