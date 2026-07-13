import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

type Mode = "plan" | "execute";

function findLatest<T>(ctx: ExtensionContext, customType: string): T | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === customType) {
      return (entry as CustomEntry<T>).data;
    }
  }
  return undefined;
}

function planPathFromToolInput(input: unknown, ctx: ExtensionContext): string | undefined {
  const absolutePath = resolve(ctx.cwd, (input as { path: string }).path);
  const plansDir = resolve(ctx.cwd, ".pi/plans");
  return absolutePath.startsWith(plansDir + sep) ? absolutePath : undefined;
}

const PLAN_INSTRUCTIONS = `# Plan mode active

You are in PLAN mode: investigate and plan, do not implement. Produce a plan that a separate, fresh implementation agent can execute from a cold start.

Rules
- edit/write are restricted: you may only write files under .pi/plans/. Edits anywhere else are blocked.
- All read-only exploration tools are available (read, bash, grep, find, ls, and any others) — use whichever helps you investigate, not just read and bash.
- Do not implement the change or modify source files now.

The plan you write to .pi/plans/<name>.md must be a self-contained handoff. Include:
- Goal and constraints (what "done" looks like).
- Key findings from exploration (architecture, relevant behavior, gotchas).
- Exact files and symbols to change, with paths.
- Ordered, concrete implementation steps.
- How to validate (tests to run or add, type-checks, build steps).
- Risks, assumptions, and open questions for the reviewer.

When the plan is ready: SAVE it under .pi/plans/, then tell the USER to review it and run /approve. You cannot run /approve yourself — only the user can approve and start the implementation session.`;

export default function plot(pi: ExtensionAPI) {
  function getMode(ctx: ExtensionContext): Mode {
    return findLatest<{ mode?: Mode }>(ctx, "plot-mode")?.mode ?? "execute";
  }

  function getCurrentPlanPath(ctx: ExtensionContext): string | undefined {
    return findLatest<{ path?: string }>(ctx, "plot-plan")?.path;
  }

  function applyMode(mode: Mode, planPath: string | undefined, ctx: ExtensionContext) {
    const label = mode === "plan" ? "Plan mode" : "Execute mode";
    const text = planPath ? `${label} (${relative(ctx.cwd, planPath)})` : label;
    ctx.ui.setWidget("plot", [ctx.ui.theme.fg("accent", text)]);
  }

  // Dynamic, per-turn plan-mode context appended to the system prompt.
  async function buildPlanSystemContext(ctx: ExtensionContext): Promise<string> {
    const planPath = getCurrentPlanPath(ctx);
    if (!planPath) return PLAN_INSTRUCTIONS;

    const rel = relative(ctx.cwd, planPath);
    try {
      const content = await readFile(planPath, "utf8");
      return `${PLAN_INSTRUCTIONS}\n\nCurrent plan (${rel}) — revise it in place or extend it:\n\n${content}`;
    } catch (error) {
      return `${PLAN_INSTRUCTIONS}\n\nThe tracked plan (${rel}) could not be read: ${errorMessage(error)}. Save a new plan before asking the user to approve it.`;
    }
  }

  // Persisted state + UI only. No model turn is triggered by toggling.
  function togglePlanMode(ctx: ExtensionContext) {
    const mode = getMode(ctx) === "plan" ? "execute" : "plan";
    pi.appendEntry("plot-mode", { mode });
    applyMode(mode, getCurrentPlanPath(ctx), ctx);
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("approve", {
    description: "Approve the current plan and hand off to a fresh execute-mode session",
    handler: async (_args, ctx) => {
      if (getMode(ctx) !== "plan") {
        ctx.ui.notify("/approve only works in plan mode.", "error");
        return;
      }

      const planPath = getCurrentPlanPath(ctx);
      if (!planPath) {
        ctx.ui.notify("No plan file has been written yet. Write one under .pi/plans/ first.", "error");
        return;
      }

      let planContent: string;
      try {
        planContent = await readFile(planPath, "utf8");
      } catch (error) {
        ctx.ui.notify(`Could not read the current plan: ${errorMessage(error)}`, "error");
        return;
      }

      // Capture plain data before replacement; withSession must only use replacementCtx.
      const kickoff = buildKickoffMessage(planContent);
      const parentSession = ctx.sessionManager.getSessionFile();

      await ctx.newSession({
        parentSession: parentSession ?? undefined,
        withSession: async (replacementCtx) => {
          await replacementCtx.sendUserMessage(kickoff);
        },
      });
    },
  });

  pi.registerShortcut(Key.shift("tab"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  pi.on("tool_call", async (event, ctx) => {
    if (getMode(ctx) !== "plan") return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (planPathFromToolInput(event.input, ctx)) return;

    return {
      block: true,
      reason:
        "Plan mode: only files under .pi/plans/ can be edited or written. Use read-only tools (read, bash, grep, find, etc.) to explore code, then write your plan to .pi/plans/<name>.md, then ask the user to run /approve.",
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const absolutePath = planPathFromToolInput(event.input, ctx);
    if (!absolutePath) return;

    pi.appendEntry("plot-plan", { path: absolutePath });
    applyMode(getMode(ctx), absolutePath, ctx);
  });

  // Hide announcements persisted by older plot versions. Current mode guidance
  // comes exclusively from before_agent_start below.
  pi.on("context", async (event) => ({
    messages: event.messages.filter(
      (message) => message.role !== "custom" || message.customType !== "plot",
    ),
  }));

  // Inject dynamic plan-mode guidance per turn. Execute mode adds nothing.
  pi.on("before_agent_start", async (event, ctx) => {
    if (getMode(ctx) !== "plan") return;
    const planContext = await buildPlanSystemContext(ctx);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${planContext}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    // Fresh sessions (/new, /approve child) start in execute mode by default:
    // they have no plot-mode entries, so getMode returns "execute". Resume/fork
    // restore whatever state already exists in that session. We do NOT copy state
    // from previousSessionFile.
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildKickoffMessage(planContent: string): string {
  return `A plan was approved in a separate planning session. You are now in a fresh EXECUTE-mode session with full normal tool access (edit, write, bash, read, grep, and any others).

Before changing anything, inspect the current repository state (e.g. \`git status\`, \`git diff\`, and the files the plan touches) so you understand what actually exists right now. This plan was drafted during planning, so its assumptions may not match the current code — verify against the real state of the repository and adapt rather than following it blindly.

Then implement the plan, and run the relevant validation (tests, type-checks, linters, build) to confirm your changes work.

=== APPROVED PLAN ===

${planContent}`;
}
