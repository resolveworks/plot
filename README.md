# plot

A [pi](https://github.com/earendil-works/pi) extension that adds plan mode — a phase where the agent can only write files inside the project's plan directory, so it explores and drafts a plan before getting full write access.

## Install

```bash
pi install git:github.com/resolveworks/plot
```

Or try without installing:

```bash
pi -e git:github.com/resolveworks/plot
```

## Usage

Enter plan mode with `/plan` or `Shift+Tab`.

Ask the agent to work on something. It will explore the codebase and write a plan to a file inside the project's plan directory. Review the plan, then:

- **`/approve`** — hands off to a fresh execute-mode session seeded with the plan as the first user message
- **`/plan`** (or `Shift+Tab`) — toggle back out of plan mode without approval, e.g. to abandon or revise

## Where plans live

There is one shared plan directory for the whole project:

```
<ctx.sessionManager.getSessionDir()>/plot-plans/
```

`getSessionDir()` is pi's cwd-specific project session storage, e.g. `~/.pi/agent/sessions/<encoded-cwd>/plot-plans/`. Every session in the same project shares this directory, so plans are plain files that survive across sessions. The model is told this absolute path so it can pass it directly to `edit`/`write`.

Ownership of *the current plan* is per session/branch, not per folder: plot stores the latest plan's absolute path as a `plot-plan` custom entry in the session branch. `/new` and `/approve` start sessions with no pointer, so they have no current plan until one is written. `/fork` and `/clone` copy the branch — including its `plot-plan` pointer — and because the plan directory is shared, that pointer still resolves. Since the directory is shared, plans should use distinctive, task-specific Markdown filenames to avoid collisions.

Plan mode **requires a persisted session**. With `--no-session` (in-memory mode) there is no session directory, so entering plan mode fails with a clear notification and no plan-mode entry is written. Execute mode keeps working normally. Plans are never written anywhere else.

## How it works

In plan mode, `edit` and `write` calls are blocked unless the path resolves inside the project's plan directory. Every other tool (`read`, `bash`, etc.) works normally — the agent can explore freely, it just can't modify code yet.

Plans are written with the ordinary built-in `edit`/`write` tools; the location is what makes a file count as a plan. When such a write succeeds, plot records the absolute path as a `plot-plan` custom session entry. Running `/approve` starts a fresh child session in execute mode and sends the plan contents as the opening user message, so the implementation session begins with a clean context.

A `plot-plan` pointer is only honored while it sits under the project's plan directory.

Plans are plain markdown files on disk. They survive context compaction and session resume. pi does not clean them up automatically.

## Soft fence, not a sandbox

Plan mode is a soft fence: it blocks the default write path, but the agent could still write elsewhere by shelling out through `bash`. The goal is to keep exploration read-only by default, not to prevent a determined agent from escaping.

## Requirements

plot itself requires only pi. Plan mode additionally requires a persisted session (pi's normal/default behavior) and is unavailable with `--no-session`.
