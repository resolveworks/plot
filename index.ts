import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "write_plan"];

const SYSTEM_PROMPT = `You are in plan mode — read-only exploration before implementation.

Explore the codebase to understand the task. Ask clarifying questions if needed.
When ready, call write_plan with a concise, actionable plan.

Do not attempt to edit or write files. Use write_plan when you have a plan.`;

export default function plot(pi: ExtensionAPI) {
  let planMode = false;
  let activePlan: string | undefined;

  function updateStatus(ctx: ExtensionContext) {
    if (planMode) {
      ctx.ui.setStatus("plot", ctx.ui.theme.fg("warning", "plan"));
    } else if (activePlan) {
      ctx.ui.setStatus("plot", ctx.ui.theme.fg("accent", activePlan));
    } else {
      ctx.ui.setStatus("plot", undefined);
    }
  }

  function setWidget(ctx: ExtensionContext) {
    if (activePlan) {
      const plansDir = resolve(ctx.cwd, ".pi/plans");
      const planPath = resolve(plansDir, `${activePlan}.md`);
      readFile(planPath, "utf8").then((content) => {
        const lines = content.split("\n").slice(0, 20);
        ctx.ui.setWidget("plot", lines);
      }).catch(() => {});
    } else {
      ctx.ui.setWidget("plot", undefined);
    }
  }

  function togglePlanMode(ctx: ExtensionContext) {
    planMode = !planMode;
    if (planMode) {
      pi.setActiveTools(PLAN_TOOLS);
      ctx.ui.notify("Plan mode — read-only exploration");
    } else {
      pi.setActiveTools(pi.getAllTools().map((t) => t.name));
      ctx.ui.notify("Execute mode — full access restored");
    }
    updateStatus(ctx);
  }

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
    description: "Save a plan and prompt for approval",
    promptSnippet: "Save a markdown plan for user review",
    promptGuidelines: [
      "Use write_plan when you have a complete plan and are ready for user review.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short slug for the plan (used as filename)" }),
      content: Type.String({ description: "Markdown plan content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const plansDir = resolve(ctx.cwd, ".pi/plans");
      const planPath = resolve(plansDir, `${params.name}.md`);
      await mkdir(dirname(planPath), { recursive: true });
      await writeFile(planPath, params.content, "utf8");

      let currentContent = params.content;

      let decided = false;

      while (!decided) {
        const choice = await ctx.ui.select("Plan ready — what next?", [
          "Approve",
          "Edit",
          "Refine",
        ]);

        if (choice === "Approve") {
          decided = true;
        } else if (choice === "Edit") {
          const edited = await ctx.ui.editor("Edit the plan:", currentContent);
          if (edited !== undefined) {
            currentContent = edited;
            await writeFile(planPath, currentContent, "utf8");
          }
        } else {
          // Refine: stay in plan mode, let agent revise
          return {
            content: [{ type: "text", text: `Plan saved to .pi/plans/${params.name}.md — refining` }],
            details: { name: params.name, content: currentContent },
          };
        }
      }

      // Transition to execute mode
      planMode = false;
      activePlan = params.name;
      pi.setActiveTools(pi.getAllTools().map((t) => t.name));
      updateStatus(ctx);
      setWidget(ctx);

      return {
        content: [{ type: "text", text: `Plan saved to .pi/plans/${params.name}.md` }],
        details: { name: params.name, content: currentContent },
      };
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (planMode) {
      return {
        systemPrompt: _event.systemPrompt + "\n\n" + SYSTEM_PROMPT,
      };
    }
  });

  function reconstructPlan(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getEntries();
    const planEntry = [...entries]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === "plot-state") as
      | { data?: { planMode: boolean; activePlan?: string } }
      | undefined;

    if (planEntry?.data) {
      planMode = planEntry.data.planMode;
      activePlan = planEntry.data.activePlan;
    }

    if (planMode) {
      pi.setActiveTools(PLAN_TOOLS);
    }
    updateStatus(ctx);
    if (activePlan) setWidget(ctx);
  }

  pi.on("session_shutdown", async () => {
    pi.appendEntry("plot-state", { planMode, activePlan });
  });

  pi.on("session_start", async (_event, ctx) => {
    planMode = false;
    activePlan = undefined;
    reconstructPlan(ctx);
  });
}
