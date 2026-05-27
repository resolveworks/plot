import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "write_plan"];

const PLAN_PROMPT = `You are in plan mode — read-only exploration before implementation.

Explore the codebase to understand the task. Ask clarifying questions if needed.
When ready, call write_plan with a concise, actionable plan.

Do not attempt to edit or write files. Use write_plan when you have a plan.`;

type Mode = "plan" | "execute";

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error("Plan name must contain at least one alphanumeric character");
  return cleaned.slice(0, 64);
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

  function getActivePlan(ctx: ExtensionContext): string | undefined {
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "message") continue;
      const msg = (entry as { message?: { role?: string; toolName?: string; details?: { name?: string } } }).message;
      if (msg?.role === "toolResult" && msg.toolName === "write_plan") {
        return msg.details?.name;
      }
    }
    return undefined;
  }

  function applyMode(mode: Mode, activePlan: string | undefined, ctx: ExtensionContext) {
    if (mode === "plan") {
      pi.setActiveTools(PLAN_TOOLS);
      ctx.ui.setStatus("plot", ctx.ui.theme.fg("warning", "plan"));
      ctx.ui.setWidget("plot", undefined);
      return;
    }
    pi.setActiveTools(pi.getAllTools().map((t) => t.name).filter((n) => n !== "write_plan"));
    if (activePlan) {
      ctx.ui.setStatus("plot", ctx.ui.theme.fg("accent", activePlan));
      const planPath = resolve(ctx.cwd, ".pi/plans", `${activePlan}.md`);
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
    applyMode(mode, getActivePlan(ctx), ctx);
    ctx.ui.notify(mode === "plan" ? "Plan mode — read-only exploration" : "Execute mode — full access restored");
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

  pi.registerTool({
    name: "write_plan",
    label: "Write Plan",
    description: "Save a plan and prompt for approval. Only callable in plan mode.",
    promptSnippet: "Save a markdown plan for user review (plan mode only)",
    promptGuidelines: [
      "Use write_plan when you have a complete plan and are ready for user review.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short slug for the plan (alphanumeric, dashes, underscores)" }),
      content: Type.String({ description: "Markdown plan content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (getMode(ctx) !== "plan") {
        throw new Error("write_plan can only be called in plan mode");
      }

      const name = sanitizeName(params.name);
      const plansDir = resolve(ctx.cwd, ".pi/plans");
      const planPath = resolve(plansDir, `${name}.md`);
      await mkdir(plansDir, { recursive: true });
      await writeFile(planPath, params.content, "utf8");

      let currentContent = params.content;

      while (true) {
        const choice = await ctx.ui.select("Plan ready — what next?", ["Approve", "Edit", "Refine"]);

        if (choice === "Approve") {
          setMode("execute", ctx);
          return {
            content: [{ type: "text", text: `Plan approved. Saved to .pi/plans/${name}.md — implement it now.` }],
            details: { name, content: currentContent },
          };
        }

        if (choice === "Edit") {
          const edited = await ctx.ui.editor("Edit the plan:", currentContent);
          if (edited !== undefined) {
            currentContent = edited;
            await writeFile(planPath, currentContent, "utf8");
          }
          continue;
        }

        return {
          content: [{ type: "text", text: `Plan saved to .pi/plans/${name}.md — user wants refinement.` }],
          details: { name, content: currentContent },
        };
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (getMode(ctx) === "plan") {
      return { systemPrompt: event.systemPrompt + "\n\n" + PLAN_PROMPT };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    applyMode(getMode(ctx), getActivePlan(ctx), ctx);
  });
}
