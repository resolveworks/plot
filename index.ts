import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

type Mode = "plan" | "execute";

/** Subdirectory plot creates inside the project's session storage directory. */
const PLAN_SUBDIR = "plot-plans";

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

/**
 * The single canonical plan directory, shared across every session in the
 * project:
 *
 *   <ctx.sessionManager.getSessionDir()>/plot-plans/
 *
 * `getSessionDir()` is pi's cwd-specific project session storage (default:
 * ~/.pi/agent/sessions/<encoded-cwd>/). Returns undefined when there is no
 * persisted session (e.g. --no-session / in-memory mode), in which case plan
 * mode is unavailable.
 */
function getPlanDir(ctx: ExtensionContext): string | undefined {
  const sessionDir = ctx.sessionManager.getSessionDir();
  if (!sessionDir) return undefined;
  return resolve(sessionDir, PLAN_SUBDIR);
}

/**
 * Separator-aware containment: true iff `target` resolves to `dir` itself or a
 * path nested below it. Appending the platform separator rejects similarly
 * prefixed siblings (e.g. /a/b vs /a/baz). Empty input never matches.
 */
function isUnderDirectory(target: string, dir: string): boolean {
  if (!target || !dir) return false;
  const t = resolve(target);
  const d = resolve(dir);
  return t === d || t.startsWith(d + sep);
}

/** Abbreviate the user's home directory as ~ for display only. */
function abbreviateHome(p: string): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(home + sep))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extract the `path` argument from an edit/write tool input. */
function toolInputPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const obj = input as { path?: unknown };
  const raw = obj.path;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

/**
 * Resolve an edit/write input path against cwd, then test whether it lands
 * inside the canonical plan directory. The model is always given the absolute
 * plan directory so it passes that path verbatim, keeping plot's resolution
 * consistent with the built-in tools' own path handling. Returns the resolved
 * absolute path when it is a valid plan write, otherwise undefined.
 */
function resolvePlanWrite(input: unknown, ctx: ExtensionContext): string | undefined {
  const planDir = getPlanDir(ctx);
  if (!planDir) return undefined;
  const raw = toolInputPath(input);
  if (!raw) return undefined;
  const absolutePath = resolve(ctx.cwd, raw);
  return isUnderDirectory(absolutePath, planDir) ? absolutePath : undefined;
}

/** Create the canonical plan directory if needed; it is the only location plot uses for plans. */
async function ensurePlanDir(
  ctx: ExtensionContext,
): Promise<{ ok: true; planDir: string } | { ok: false; reason: string }> {
  const planDir = getPlanDir(ctx);
  if (!planDir) {
    return {
      ok: false,
      reason:
        "Plan mode requires a persisted session to store plans, but this session has no session directory (e.g. it is running with --no-session). Start a normal pi session so plans can be saved, then try again.",
    };
  }
  try {
    await mkdir(planDir, { recursive: true });
    return { ok: true, planDir };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not create the plan directory (${abbreviateHome(planDir)}): ${errorMessage(error)}`,
    };
  }
}

function buildPlanInstructions(planDir: string): string {
  return `# Plan mode active

You are in PLAN mode: investigate and plan, do not implement. Produce a plan that a separate, fresh implementation agent can execute from a cold start.

Rules
- edit/write are restricted: you may ONLY write files under ${planDir}. Edits and writes anywhere else are blocked. Use the absolute path shown here.
- All read-only exploration tools are available (read, bash, grep, find, ls, and any others) — use whichever helps you investigate, not just read and bash.
- Do not implement the change or modify source files now.

The plan you write to ${planDir}/<name>.md must be a self-contained handoff. The plan directory is shared across sessions in this project, so pick a distinctive, task-specific Markdown filename. Include:
- Goal and constraints (what "done" looks like).
- Key findings from exploration (architecture, relevant behavior, gotchas).
- Exact files and symbols to change, with paths.
- Ordered, concrete implementation steps.
- How to validate (tests to run or add, type-checks, build steps).
- Risks, assumptions, and open questions for the reviewer.

When the plan is ready: SAVE it under ${planDir}/, then tell the USER to review it and run /approve. You cannot run /approve yourself — only the user can approve and start the implementation session.`;
}

export default function plot(pi: ExtensionAPI) {
  function getMode(ctx: ExtensionContext): Mode {
    return findLatest<{ mode?: Mode }>(ctx, "plot-mode")?.mode ?? "execute";
  }

  // The "current plan" is the most recent `plot-plan` pointer in this session's
  // branch, kept only if it resolves inside the project's shared plan directory.
  // The directory itself is shared across every session in the project, so a
  // pointer copied into a branch by fork/clone stays valid; the branch (not the
  // filesystem) decides ownership.
  function getCurrentPlanPath(ctx: ExtensionContext): string | undefined {
    const planDir = getPlanDir(ctx);
    if (!planDir) return undefined;
    const path = findLatest<{ path?: string }>(ctx, "plot-plan")?.path;
    if (!path) return undefined;
    return isUnderDirectory(path, planDir) ? path : undefined;
  }

  /**
   * Build the trailing plan-mode guidance string for a single provider request.
   *
   * Defensively recreates/checks the plan directory each call and re-reads the
   * authoritative current plan, so resume, compaction, /tree, fork/clone,
   * external file changes, and tool-loop plan revisions all stay correct. Used
   * only to construct the transient context-hook message; it never touches
   * session state.
   */
  async function buildPlanGuidance(ctx: ExtensionContext): Promise<string> {
    const result = await ensurePlanDir(ctx);
    if (!result.ok) {
      return `# Plan mode unavailable\n\n${result.reason}\n\nPlan mode cannot proceed this turn. Ask the user to leave plan mode (/plan or Shift+Tab) or restart pi in a normal persisted session.`;
    }

    const instructions = buildPlanInstructions(result.planDir);
    const planPath = getCurrentPlanPath(ctx);
    if (!planPath) {
      return instructions;
    }

    const display = abbreviateHome(planPath);
    try {
      const content = await readFile(planPath, "utf8");
      return `${instructions}\n\nCurrent plan (${display}) — revise it in place or extend it:\n\n${content}`;
    } catch (error) {
      return `${instructions}\n\nThe current plan (${display}) could not be read: ${errorMessage(error)}. Save a new plan before asking the user to approve it.`;
    }
  }

  function applyMode(mode: Mode, planPath: string | undefined, ctx: ExtensionContext) {
    const label = mode === "plan" ? "Plan mode" : "Execute mode";
    const text = planPath ? `${label} (${abbreviateHome(planPath)})` : label;
    ctx.ui.setWidget("plot", [ctx.ui.theme.fg("accent", text)]);
  }

  // Persisted state + UI only. No model turn is triggered by toggling.
  async function togglePlanMode(ctx: ExtensionContext) {
    const next: Mode = getMode(ctx) === "plan" ? "execute" : "plan";
    if (next === "plan") {
      const result = await ensurePlanDir(ctx);
      if (!result.ok) {
        ctx.ui.notify(`Could not enter plan mode: ${result.reason}`, "error");
        return; // do not append a plan-mode entry
      }
    }
    pi.appendEntry("plot-mode", { mode: next });
    applyMode(next, getCurrentPlanPath(ctx), ctx);
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
        const planDir = getPlanDir(ctx);
        const where = planDir ? ` under ${abbreviateHome(planDir)}` : "";
        ctx.ui.notify(`No current plan has been written yet. Write one${where} first.`, "error");
        return;
      }

      let planContent: string;
      try {
        planContent = await readFile(planPath, "utf8");
      } catch (error) {
        ctx.ui.notify(
          `Could not read the current plan (${abbreviateHome(planPath)}): ${errorMessage(error)}`,
          "error",
        );
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

    if (resolvePlanWrite(event.input, ctx)) return;

    const planDir = getPlanDir(ctx);
    const where = planDir
      ? `under ${planDir}`
      : "under the project's plan directory, but this session has no session directory (e.g. --no-session)";
    return {
      block: true,
      reason: `Plan mode: only files ${where} can be edited or written. Use read-only tools (read, bash, grep, find, etc.) to explore code, then write your plan to the plan directory, then ask the user to run /approve.`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const absolutePath = resolvePlanWrite(event.input, ctx);
    if (!absolutePath) return;

    pi.appendEntry("plot-plan", { path: absolutePath });
    applyMode(getMode(ctx), absolutePath, ctx);
  });

  // Inject dynamic plan-mode guidance as a transient trailing message before
  // each provider request (including tool-loop continuations). Execute mode adds
  // nothing. The guidance is appended to the deep-copied event.messages, which
  // Pi uses only for this request and never persists to session state, so the
  // system prompt and active tool definitions stay byte-stable across
  // execute/plan mode and prefix caching can reuse everything up to this tail.
  // Pi converts the custom message to a provider-visible user message after the
  // context transform. This repetition per provider call is intentional:
  // providers are stateless and the mutation is transient, so appending at the
  // tail limits cache divergence to the latest dynamic region.
  pi.on("context", async (event, ctx) => {
    if (getMode(ctx) !== "plan") return;
    const guidance = await buildPlanGuidance(ctx);
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: "plot-plan-guidance",
          content: guidance,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    // Fresh sessions (/new, /approve child) start in execute mode by default:
    // they have no plot-mode entries, so getMode returns "execute". Resume/fork
    // restore whatever state already exists in that session. We do NOT copy
    // state from previousSessionFile.
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    applyMode(getMode(ctx), getCurrentPlanPath(ctx), ctx);
  });
}

function buildKickoffMessage(planContent: string): string {
  return `A plan was approved in a separate planning session. You are now in a fresh EXECUTE-mode session with full normal tool access (edit, write, bash, read, grep, and any others).

Before changing anything, inspect the current repository state (e.g. \`git status\`, \`git diff\`, and the files the plan touches) so you understand what actually exists right now. This plan was drafted during planning, so its assumptions may not match the current code — verify against the real state of the repository and adapt rather than following it blindly.

Then implement the plan, and run the relevant validation (tests, type-checks, linters, build) to confirm your changes work.

=== APPROVED PLAN ===

${planContent}`;
}
