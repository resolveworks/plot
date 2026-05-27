import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

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
    if (mode === "plan") {
      ctx.ui.setStatus("plot", ctx.ui.theme.fg("warning", "plan"));
      ctx.ui.setWidget("plot", undefined);
      return;
    }
    if (planPath) {
      ctx.ui.setStatus("plot", ctx.ui.theme.fg("accent", basename(planPath, ".md")));
      readFile(planPath, "utf8").then((content) => {
        ctx.ui.setWidget("plot", content.split("\n").slice(0, 20));
      }).catch(() => ctx.ui.setWidget("plot", undefined));
    } else {
      ctx.ui.setStatus("plot", undefined);
      ctx.ui.setWidget("plot", undefined);
    }
  }

  function setMode(mode: Mode, ctx: ExtensionContext) {
    pi.appendEntry("plot-mode", { mode });
    applyMode(mode, getCurrentPlanPath(ctx), ctx);

    if (mode === "plan") {
      pi.sendMessage(
        {
          customType: "plot-mode-banner",
          content:
            "[Plan mode active] You may only edit/write files under .pi/plans/. Use read and bash freely to explore. When the plan is ready, call exit_planmode for user approval.",
          display: true,
        },
        { triggerTurn: false },
      );
    } else {
      pi.sendMessage(
        {
          customType: "plot-mode-banner",
          content: "[Plan mode ended] Full file access restored.",
          display: true,
        },
        { triggerTurn: false },
      );
    }

    ctx.ui.notify(mode === "plan" ? "Plan mode" : "Execute mode");
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
          "Plan mode: only files under .pi/plans/ can be edited or written. Use read and bash to explore code, then write your plan to .pi/plans/<name>.md, then call exit_planmode.",
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

  pi.registerTool({
    name: "exit_planmode",
    label: "Exit Plan Mode",
    description:
      "Request user approval for the plan you've written, then hand off to a fresh execute-mode session. Only callable in plan mode.",
    promptSnippet: "Request approval and hand off to execute mode (plan mode only).",
    promptGuidelines: [
      "Call exit_planmode when you've written a plan file under .pi/plans/ and the user is ready to implement it.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (getMode(ctx) !== "plan") {
        throw new Error("exit_planmode can only be called while in plan mode.");
      }

      const planPath = getCurrentPlanPath(ctx);
      if (!planPath) {
        throw new Error(
          "No plan file has been written yet. Use the write tool to create a plan under .pi/plans/ first.",
        );
      }

      const planContent = await readFile(planPath, "utf8");
      const ok = await ctx.ui.confirm("Implement this plan?", basename(planPath));

      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text: "User rejected the plan. Ask them what to change, then revise the plan file.",
            },
          ],
          details: { path: planPath, approved: false },
        };
      }

      const parentSession = ctx.sessionManager.getSessionFile();
      await ctx.newSession({
        parentSession: parentSession ?? undefined,
        withSession: async (replacementCtx) => {
          pi.appendEntry("plot-mode", { mode: "execute" });
          applyMode("execute", planPath, replacementCtx);
          replacementCtx.sendUserMessage(planContent);
        },
      });

      return {
        content: [
          { type: "text", text: "Approved. Handed off to a fresh session with the plan as the first message." },
        ],
        details: { path: planPath, approved: true },
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });
}
