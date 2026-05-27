# plot

A [pi](https://github.com/earendil-works/pi) extension that adds plan mode — a phase where the agent can only write files under `.pi/plans/`, so it explores and drafts a plan before getting full write access.

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

Ask the agent to work on something. It will explore the codebase and write a plan to `.pi/plans/<name>.md`. Review the plan, then:

- **`/approve`** — hands off to a fresh execute-mode session seeded with the plan as the first user message
- **`/plan`** (or `Shift+Tab`) — toggle back out of plan mode without approval, e.g. to abandon or revise

## How it works

In plan mode, `edit` and `write` calls are blocked unless the path is under `.pi/plans/`. Every other tool (`read`, `bash`, etc.) works normally — the agent can explore freely, it just can't modify code yet.

When the agent successfully writes a file under `.pi/plans/`, plot remembers it as the current plan. Running `/approve` starts a fresh child session in execute mode and sends the plan contents as the opening user message, so the implementation session begins with a clean context.

Plans are plain markdown files on disk. They survive context compaction and session resume.

## Requirements

None beyond pi.
