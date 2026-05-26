# plot

A [pi](https://github.com/earendil-works/pi) extension that adds plan mode — a read-only phase where the agent explores the codebase and writes a plan before gaining write access.

## Install

```bash
pi install git:github.com/resolveworks/plot
```

Or try without installing:

```bash
pi -e git:github.com/resolveworks/plot
```

## Usage

Enter plan mode:

```
/plan
```

Or start with the flag:

```bash
pi --plan
```

Or use the shortcut: `Shift+Tab`

Ask the agent to work on something. It will explore the codebase, ask clarifying questions if needed, and write a plan. You review the plan and choose:

- **Approve** — agent gets full tool access and implements the plan
- **Edit** — open the plan in your editor, make changes, then approve
- **Refine** — stay in plan mode, give feedback, agent revises

Toggle `/plan` again at any time to exit plan mode.

## How it works

In plan mode, only read-only tools are available (`read`, `bash`, `grep`, `find`, `ls`) plus `write_plan`. The agent cannot use `edit` or `write` — they are removed from the tool list, not just blocked.

When the agent calls `write_plan`, the plan is saved to `.pi/plans/<name>.md` and you are prompted to review it. Approving transitions to execute mode where all tools are restored.

Plans persist on disk. They survive context compaction and session resume.

## Requirements

None beyond pi.
