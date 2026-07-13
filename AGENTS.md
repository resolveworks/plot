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

The current mode is stored as a `plot-mode` custom session entry. `getMode` walks the session branch backwards and returns the most recent entry's mode, defaulting to `execute` when no entry exists.

Genuinely fresh sessions start in execute mode — `/new` and the child session created by `/approve` have no `plot-mode` entries, so `getMode` returns `execute`. Plot never copies plan state out of a previous session on `session_start`. `/resume` and pi's fork/clone behavior simply restore whatever entries already exist in the target session. The user opts into plan mode explicitly.

## Enforcement

Plan mode is enforced by a `tool_call` hook. When the agent calls `edit` or `write` with a path outside `.pi/plans/`, the hook returns `{ block: true, reason: ... }` and the call never runs. All other tools (`read`, `bash`, ...) are untouched — the agent explores normally.

This is a soft fence, not a sandbox. The agent could shell out via `bash` to write files; the goal is to make the default path read-only, not to prevent a determined agent from escaping.

## Plan tracking

A `tool_result` hook watches successful `edit`/`write` calls. If the written path is under `.pi/plans/`, plot appends a `plot-plan` custom entry pointing at the absolute path. `getCurrentPlanPath` returns the most recent one.

There is no dedicated `write_plan` tool — the agent uses ordinary `write`/`edit` and the location decides whether it counts as a plan.

## Model context

Plan guidance is delivered dynamically per turn, never persisted into LLM context. A `context` hook filters mode announcements persisted by older plot versions from outgoing model context.

- **execute mode:** adds no plot system text at all.
- **plan mode:** `before_agent_start` appends a concise, strong instruction to the system prompt for that turn only — it is investigation/planning, not implementation; `edit`/`write` are restricted to `.pi/plans/`; read-only exploration tools may all be used; the plan must be a self-contained handoff (goal/constraints, findings, exact files/symbols, ordered changes, validation/tests, risks/open questions); and when ready the model should save the plan and tell the **user** to run `/approve` (the model cannot invoke `/approve` itself). If a current plan exists, its path and content are included so it can be revised. Missing or unreadable tracked plans are reported in the guidance rather than aborting the turn.

## Commands

### `/plan`

Toggles between plan and execute. It appends a `plot-mode` entry and updates the widget — nothing else. Toggling does **not** inject a message into LLM context and does **not** trigger a model turn; plan-mode guidance is delivered dynamically per turn (see [Model context](#model-context)). Also bound to `Shift+Tab`.

### `/approve`

Plan mode only. Reads the current plan file, then calls `ctx.newSession({ parentSession, withSession })` to start a fresh child session. If there is no current plan path, or the tracked plan cannot be read, `/approve` notifies the user and aborts.

`withSession` sends a single user message: a kickoff that explains the plan was approved in a separate planning session, that this is execute mode with full normal tool access, that the agent should inspect current repository state before editing (and adapt if assumptions no longer match), then implement the plan and run relevant validation, followed by the plan content. The plan content is captured as a plain string before `ctx.newSession` runs; inside `withSession`, only `replacementCtx` is used.

The child session has no `plot-mode` entries, so `getMode` returns `execute` by default, and `session_start` re-runs `applyMode` from a fresh extension load.

The `withSession` callback must not call methods on the outer `pi` (e.g. `pi.appendEntry`) or the outer command `ctx` — that `pi` is bound to the parent `AgentSession`, which pi disposes before invoking the callback. Use `replacementCtx` for anything that needs to target the child session.

## Requirements

None beyond pi. No tmux, no external tools, no network.
