import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

type Mode = "plan" | "execute";

function isInsidePlans(absolutePath: string, plansDir: string): boolean {
  const rel = relative(plansDir, absolutePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export default function plot(pi: ExtensionAPI) {
  function getMode(ctx: ExtensionContext): Mode {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type === "custom" && (entry as { customType?: string }).customType === "plot-mode") {
        return (entry as { data?: { mode?: Mode } }).data?.mode ?? "execute";
      }
    }
    return pi.getFlag("plan") === true ? "plan" : "execute";
  }

  function getCurrentPlanPath(ctx: ExtensionContext): string | undefined {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type === "custom" && (entry as { customType?: string }).customType === "plot-plan") {
        return (entry as { data?: { path?: string } }).data?.path;
      }
    }
    return undefined;
  }

  function applyMode(mode: Mode, planPath: string | undefined, ctx: ExtensionContext) {
    const label = mode === "plan" ? "Plan mode" : "Normal mode";
    const text = planPath ? `${label} (${relative(ctx.cwd, planPath)})` : label;
    ctx.ui.setWidget("plot", [ctx.ui.theme.fg("accent", text)]);
  }

  function setMode(mode: Mode, ctx: ExtensionContext) {
    pi.appendEntry("plot-mode", { mode });
    applyMode(mode, getCurrentPlanPath(ctx), ctx);

    if (mode === "plan") {
      pi.sendMessage(
        {
          customType: "plot",
          content:
            "[Plan mode active] You may only edit/write files under .pi/plans/. Use read and bash freely to explore. When the plan is ready, run /approve.",
          display: true,
        },
        { triggerTurn: false },
      );
    } else {
      pi.sendMessage(
        {
          customType: "plot",
          content: "[Plan mode ended] Full file access restored.",
          display: true,
        },
        { triggerTurn: false },
      );
    }
  }

  function togglePlanMode(ctx: ExtensionContext) {
    setMode(getMode(ctx) === "plan" ? "execute" : "plan", ctx);
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

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
          pi.appendEntry("plot-mode", { mode: "execute" });
          applyMode("execute", planPath, replacementCtx);
          replacementCtx.sendUserMessage(planContent);
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

    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string") return;

    const plansDir = resolve(ctx.cwd, ".pi/plans");
    const absolutePath = resolve(ctx.cwd, rawPath);

    if (!isInsidePlans(absolutePath, plansDir)) {
      return {
        block: true,
        reason:
          "Plan mode: only files under .pi/plans/ can be edited or written. Use read and bash to explore code, then write your plan to .pi/plans/<name>.md, then run /approve.",
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string") return;

    const plansDir = resolve(ctx.cwd, ".pi/plans");
    const absolutePath = resolve(ctx.cwd, rawPath);
    if (!isInsidePlans(absolutePath, plansDir)) return;

    pi.appendEntry("plot-plan", { path: absolutePath });
  });

  pi.on("session_start", async (_event, ctx) => {
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });
}
