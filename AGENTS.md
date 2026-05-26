# AGENTS.md

**plot** is a [pi](https://github.com/earendil-works/pi) extension that adds a plan mode — a read-only phase where the agent explores the codebase and writes a plan before gaining write access.

## State Machine

Two modes. Transitions are deterministic.

```
/plan ──────────────► PLAN
                      │
                      │  tools: read, bash, grep, find, ls, write_plan
                      │  system prompt: explore, ask questions, call write_plan
                      │
                      │  agent calls write_plan(markdown)
                      │  ├─ extension writes .pi/plans/<name>.md
                      │  ├─ extension shows plan to user
                      │  └─ user approves ──────────────► EXECUTE
                      │                                   │
                      │                                   │  tools: everything
                      │                                   │
/plan ◄───────────────────────────────────────────────────┘
```

- `/plan` toggles between modes.
- `--plan` flag starts in plan mode.
- `Shift+Tab` shortcut toggles.
- Approving a plan transitions to execute mode automatically.
- Calling `/plan` during execute returns to plan mode (for replanning).

## Tools

### `write_plan`

The only plan-specific tool. Agent calls it with a markdown plan.

**Parameters:**
- `name` — short slug for the plan (used as filename)
- `content` — markdown plan

**Behavior:**
1. Writes `content` to `.pi/plans/<name>.md`
2. Shows the plan to the user via `ctx.ui.select` with options: Approve / Edit / Refine
3. If Edit: opens `ctx.ui.editor()` prefilled with the plan, writes edits back to file
4. If Approve: transitions to execute mode, restores full tools, injects execution prompt
5. If Refine: stays in plan mode

The tool does not return to the LLM until the user has acted. The approval is part of the tool execution.

## Enforcement

`setActiveTools` controls which tools exist. In plan mode, `edit` and `write` are not available — not filtered, not blocked, absent. The agent cannot write files. It can read, search, and call `write_plan`.

Bash is available in plan mode. `cat`, `rg`, `git log` are useful for exploration. The agent could technically write files via `bash` — this is acceptable. The point is to make the default path read-only, not to build a sandbox.

## Plan File

Location: `.pi/plans/<name>.md` (project-local, gitignorable).

The file is the source of truth. It persists across compaction and session resume. On session start, if a plan file exists and we're in execute mode, the extension reads it back and shows a status widget.

## System Prompt

Injected via `before_agent_start` when in plan mode. Short:

```
You are in plan mode — read-only exploration before implementation.

Explore the codebase to understand the task. Ask clarifying questions if needed.
When ready, call write_plan with a concise, actionable plan.

Do not attempt to edit or write files. Use write_plan when you have a plan.
```

## Status

- Plan mode: footer shows `plan` indicator
- Execute mode with active plan: footer shows plan name
- Widget: shows plan file contents (collapsed) during execute

## Requirements

None beyond pi. No tmux, no external tools, no network.
