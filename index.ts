import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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

export default function plot(pi: ExtensionAPI) {
  function getMode(ctx: ExtensionContext): Mode {
    return findLatest<{ mode?: Mode }>(ctx, "plot-mode")?.mode ?? "execute";
  }

  function getCurrentPlanPath(ctx: ExtensionContext): string | undefined {
    return findLatest<{ path?: string }>(ctx, "plot-plan")?.path;
  }

  function applyMode(mode: Mode, planPath: string | undefined, ctx: ExtensionContext) {
    const label = mode === "plan" ? "Plan mode" : "Normal mode";
    const text = planPath ? `${label} (${relative(ctx.cwd, planPath)})` : label;
    ctx.ui.setWidget("plot", [ctx.ui.theme.fg("accent", text)]);
  }

  function togglePlanMode(ctx: ExtensionContext) {
    const mode = getMode(ctx) === "plan" ? "execute" : "plan";
    pi.appendEntry("plot-mode", { mode });
    applyMode(mode, getCurrentPlanPath(ctx), ctx);

    pi.sendMessage(
      {
        customType: "plot",
        content:
          mode === "plan"
            ? "[Plan mode active] You may only edit/write files under .pi/plans/. Use read and bash freely to explore. When the plan is ready, run /approve."
            : "[Plan mode ended] Full file access restored.",
        display: false,
      },
      { triggerTurn: false },
    );
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

      const planContent = await readFile(planPath, "utf8");
      const parentSession = ctx.sessionManager.getSessionFile();

      await ctx.newSession({
        parentSession: parentSession ?? undefined,
        withSession: async (replacementCtx) => {
          await replacementCtx.sendUserMessage(`implement this plan:\n\n${planContent}`);
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
        "Plan mode: only files under .pi/plans/ can be edited or written. Use read and bash to explore code, then write your plan to .pi/plans/<name>.md, then run /approve.",
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

  pi.on("session_start", async (event, ctx) => {
    // Carry over plan state from previous session on /new
    if (event.reason === "new" && event.previousSessionFile) {
      try {
        const prevSession = await SessionManager.open(event.previousSessionFile);
        const branch = prevSession.getBranch();

        let inheritedMode: Mode | undefined;
        let inheritedPlanPath: string | undefined;

        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry.type === "custom") {
            const ce = entry as CustomEntry;
            if (!inheritedMode && ce.customType === "plot-mode") {
              inheritedMode = (ce.data as { mode?: Mode })?.mode;
            }
            if (!inheritedPlanPath && ce.customType === "plot-plan") {
              inheritedPlanPath = (ce.data as { path?: string })?.path;
            }
            if (inheritedMode && inheritedPlanPath) break;
          }
        }

        if (inheritedMode) {
          pi.appendEntry("plot-mode", { mode: inheritedMode });
        }
        if (inheritedPlanPath) {
          pi.appendEntry("plot-plan", { path: inheritedPlanPath });
        }
      } catch {
        // Previous session unreadable — start fresh, no-op
      }
    }

    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });
}
