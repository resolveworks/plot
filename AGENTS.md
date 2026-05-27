# AGENTS.md

**plot** is a [pi](https://github.com/earendil-works/pi) extension that adds a plan mode — a phase where edits are restricted to `.pi/plans/`, so the agent explores and drafts a plan before getting full write access.

## State Machine

Two modes. Transitions are explicit.

```
                  /plan, Shift+Tab, or --plan
                  ─────────────────────────────►
        EXECUTE                                    PLAN
                  ◄─────────────────────────────
                  /plan or Shift+Tab

PLAN ──/approve──► fresh child session in EXECUTE,
                   seeded with the plan file as the
                   first user message
```

The current mode is stored as a `plot-mode` custom session entry. `getMode` walks the session branch backwards and returns the most recent entry's mode, falling back to the `--plan` flag.

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

Plan mode only. Reads the current plan file, then calls `ctx.newSession({ parentSession, withSession })` to start a fresh child session. Inside `withSession`:

1. Appends a `plot-mode` entry setting mode to `execute`.
2. Calls `applyMode` to update the status line.
3. Calls `sendUserMessage` with the plan contents — the child session's first turn begins with the plan as the user message.

If there's no current plan path, `/approve` notifies the user and aborts.

## Status

`applyMode` writes `Plan mode` or `Normal mode` to the status line via `ctx.ui.setStatus("plot", ...)`. If a plan file is tracked, the basename is appended in parentheses. The status is refreshed on `session_start` and whenever the mode changes.

## Flag

`--plan` (`pi.registerFlag("plan", ...)`) — start in plan mode. Only consulted by `getMode` as a fallback when no `plot-mode` entry exists in the session branch.

## Requirements

None beyond pi. No tmux, no external tools, no network.
