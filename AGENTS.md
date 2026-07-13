# AGENTS.md

**plot** is a [pi](https://github.com/earendil-works/pi) extension that adds a plan mode — a phase where edits are restricted to the project's plan directory, so the agent explores and drafts a plan before getting full write access.

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

## Plan storage

There is exactly one canonical plan directory, shared across every session in the project:

```
<ctx.sessionManager.getSessionDir()>/plot-plans/
```

`getSessionDir()` is pi's cwd-specific project session storage (e.g. `~/.pi/agent/sessions/<encoded-cwd>/plot-plans/`). `getPlanDir` builds it from `getSessionDir()` only; it never hardcodes `~/.pi`, never uses `getAgentDir`, never calls `getSessionId`, and never derives a second project key.

Session/branch ownership of the *current* plan is the `plot-plan` custom pointer in the session branch, not a per-session filesystem folder: all sessions in a project read and write the same directory, and the branch decides which plan is "current". Genuinely fresh sessions — `/new` and the `/approve` child — have no `plot-plan` pointer and therefore no current plan until one is written. `/fork` and `/clone` copy the branch (including its `plot-plan` pointer), and because the plan directory is shared that pointer still resolves. Because the directory is shared, plan files should use distinctive, task-specific Markdown names to avoid collisions.

Plan mode requires a persisted session. In `--no-session` / in-memory mode `getSessionDir()` is empty, so `getPlanDir` returns `undefined`. Entering plan mode then fails cleanly with a clear user notification and **no** `plot-mode` entry is appended; execute mode is unaffected. Plot never writes plans relative to cwd or anywhere else when there is no session directory; a plan-mode turn reached without one reports a clear error.

The plan directory is created (`mkdir -p`) only when entering plan mode, and defensively re-created before a plan-mode turn. Creation failure is reported clearly and blocks entering plan mode. Execute-only sessions never create it.

## Enforcement

Plan mode is enforced by a `tool_call` hook. When the agent calls `edit` or `write` with a path that does not resolve inside the canonical plan directory, the hook returns `{ block: true, reason: ... }` and the call never runs. Containment is separator-aware (`dir` vs `dir + sep`) so similarly prefixed siblings are not mistaken for children, and malformed/missing `path` input is rejected. All other tools (`read`, `bash`, ...) are untouched — the agent explores normally.

This is a soft fence, not a sandbox. The agent could shell out via `bash` to write files; the goal is to make the default path read-only, not to prevent a determined agent from escaping.

## Plan tracking

A `tool_result` hook watches successful `edit`/`write` calls. If the written path resolves inside the canonical plan directory, plot appends a `plot-plan` custom entry with that absolute path and refreshes the widget. `getCurrentPlanPath` returns the most recent such pointer in the current branch.

A `plot-plan` pointer is honored only while it resolves inside the canonical plan directory; one pointing anywhere else is ignored.

There is no dedicated `write_plan` tool — the agent uses ordinary `edit`/`write` and the location decides whether a file counts as a plan.

## Model context

Plan guidance is delivered transiently per provider request and is never persisted into session history. It is injected by a `context` hook (not `before_agent_start`), so plot no longer changes the system prompt or active built-in tool definitions across execute/plan mode. Prefix caching can therefore reuse the stable system/tools/history up to the dynamic tail.

- **execute mode:** the `context` hook adds nothing.
- **plan mode:** the `context` hook appends exactly one request-local trailing guidance message — a hidden `role: "custom"` message with `customType: "plot-plan-guidance"` — to the deep-copied `event.messages` and returns it. Pi converts that custom message to a provider-visible user message after the context transform. The mutation is transient: `event.messages` is a deep copy used only for that single provider request, so nothing is written to session state and no filtering of stale guidance is ever needed. The guidance is investigation/planning, not implementation; `edit`/`write` are restricted to the canonical plan directory and the model is given the exact absolute directory to pass to those tools; read-only exploration tools may all be used; the plan must be a self-contained handoff (goal/constraints, findings, exact files/symbols, ordered changes, validation/tests, risks/open questions); and when ready the model should save the plan and tell the **user** to run `/approve` (the model cannot invoke `/approve` itself). The plan directory is defensively recreated/checked on this call. The authoritative current plan is re-read and included on every call (path and content) so it can be revised; an unreadable current plan is reported in the guidance rather than aborting the call. If there is no session directory, the guidance reports a clear error instead of plan instructions.

The hook runs before every provider request, including tool-loop continuations. This repetition is intentional: providers are stateless and the context mutation is transient, so appending at the tail limits cache divergence to the latest dynamic region (the new/changed guidance) instead of changing the early system-prompt prefix on every mode change or plan revision.

## Commands

### `/plan`

Toggles between plan and execute. When toggling into plan mode it first ensures the canonical plan directory can be created; if there is no session directory or `mkdir` fails, it notifies the user and does **not** append a plan-mode entry. Otherwise it appends a `plot-mode` entry and updates the widget — nothing else. Toggling does **not** inject a message into LLM context and does **not** trigger a model turn; plan-mode guidance is delivered transiently per provider request via the `context` hook (see [Model context](#model-context)). Also bound to `Shift+Tab`.

### `/approve`

Plan mode only. Reads the current plan file, then calls `ctx.newSession({ parentSession, withSession })` to start a fresh child session. If there is no current canonical plan path, or the tracked plan cannot be read, `/approve` notifies the user and aborts.

`withSession` sends a single user message: a kickoff that explains the plan was approved in a separate planning session, that this is execute mode with full normal tool access, that the agent should inspect current repository state before editing (and adapt if assumptions no longer match), then implement the plan and run relevant validation, followed by the plan content. The plan content is captured as a plain string before `ctx.newSession` runs; inside `withSession`, only `replacementCtx` is used.

The child session has no `plot-mode` entries, so `getMode` returns `execute` by default, and `session_start` re-runs `applyMode` from a fresh extension load.

The `withSession` callback must not call methods on the outer `pi` (e.g. `pi.appendEntry`) or the outer command `ctx` — that `pi` is bound to the parent `AgentSession`, which pi disposes before invoking the callback. Use `replacementCtx` for anything that needs to target the child session.

## Display

Absolute plan paths are shown to the user with the home directory abbreviated as `~`. The model is always given the absolute path so it passes it verbatim, keeping plot's enforcement consistent with the built-in tools' own path handling.

## Development and validation

Pi loads extension `.ts` files directly; plot intentionally has no build step, local dependencies, `node_modules`, `tsconfig`, or standalone TypeScript toolchain. Do **not** install dependencies, create TypeScript configuration, add temporary module-resolution symlinks, or run `tsc`/`transpileModule` checks. Validate changes by reviewing them against pi's installed API documentation and types, running repository-provided checks if any exist, using `git diff --check`, and loading the extension through pi when an integration check is appropriate.

## Requirements

None beyond pi. No tmux, no external tools, no network.
