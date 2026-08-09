import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { executeCommand, type CommandIo } from "./commands.js";

const statusKey = "lebang-orchestrator";
const progressCommands = new Set(["run", "retry", "review", "integrate", "resume"]);
const longCommands = new Set(["plan", ...progressCommands]);
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const commandSuggestions = [
  ["plan", "Create a task DAG for a goal"],
  ["run", "Run ready tasks through integration"],
  ["status", "Show persisted orchestration status"],
  ["task", "Show one persisted task"],
  ["retry", "Retry a stopped task"],
  ["review", "Rerun review for a task"],
  ["integrate", "Integrate approved task commits"],
  ["resume", "Recover interrupted work"],
  ["graph", "Print the task DAG"],
  ["logs", "Show preserved task logs"],
] as const;
const commandNames = new Set<string>(commandSuggestions.map(([command]) => command));

export default function orchestratorExtension(pi: ExtensionAPI): void {
  pi.registerCommand("orchestrator", {
    description: "Plan, run, inspect, and recover orchestrated coding tasks",
    getArgumentCompletions: (prefix) => {
      const query = prefix.trimStart();
      if (/\s/.test(query)) return null;
      const matches = commandSuggestions
        .filter(([command]) => command.startsWith(query))
        .map(([value, description]) => ({ value, label: value, description }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const output = captureIo();
      const startedAt = Date.now();
      let exitCode = 2;
      let command = args.trim() ? "command" : "help";
      let activity: CommandActivity | undefined;
      try {
        const argv = args.trim() ? splitCommandLine(args) : ["--help"];
        command = commandFrom(argv);
        if (command !== "help") {
          activity = startActivity(ctx, command, repoFrom(argv, ctx.cwd), startedAt);
          if (longCommands.has(command)) {
            ctx.ui.notify(`Orchestrator · ${actionFor(command)} started`, "info");
          }
        }
        exitCode = await executeCommand(argv, {
          cwd: ctx.cwd,
          defaultRepo: ctx.cwd,
          io: output.io,
        });
      } catch (error) {
        exitCode = 2;
        output.io.stderr(`orchestrator: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      activity?.stop();
      const content = `${output.stdout()}${output.stderr()}`.trimEnd();
      pi.sendMessage(
        {
          customType: "lebang-orchestrator",
          content: content || `orchestrator exited with ${exitCode}`,
          display: true,
          details: { exitCode },
        },
        { triggerTurn: false, deliverAs: "followUp" },
      );
      const outcome = classifyOutcome(exitCode, command, output.stdout(), output.stderr());
      ctx.ui.notify(
        `${outcome.symbol} Orchestrator · ${outcome.message} · ${formatDuration(Date.now() - startedAt)}`,
        outcome.notification,
      );
    },
  });
}

interface CommandActivity {
  stop(): void;
}

function startActivity(
  ctx: ExtensionCommandContext,
  command: string,
  repoRoot: string,
  startedAt: number,
): CommandActivity {
  let frame = 0;
  const render = (): void => {
    const spinner = spinnerFrames[frame % spinnerFrames.length]!;
    frame += 1;
    const progress = progressCommands.has(command) ? taskProgress(repoRoot) : undefined;
    const detail = progress === undefined ? actionFor(command) : `${actionFor(command)} · ${progress}`;
    const text = `${spinner} Orchestrator · ${detail} · ${formatDuration(Date.now() - startedAt)}`;
    ctx.ui.setStatus(statusKey, text);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(statusKey, [text], { placement: "belowEditor" });
    }
  };
  render();
  const timer = setInterval(render, 250);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      ctx.ui.setStatus(statusKey, undefined);
      if (ctx.mode === "tui") ctx.ui.setWidget(statusKey, undefined);
    },
  };
}

export function taskProgress(repoRoot: string): string | undefined {
  try {
    const plan = JSON.parse(readFileSync(join(repoRoot, ".orchestrator", "plan.json"), "utf8")) as {
      tasks?: Array<{ id?: unknown; status?: unknown }>;
    };
    const tasks = (plan.tasks ?? []).filter(
      (task): task is { id: string; status: string } =>
        typeof task.id === "string" &&
        typeof task.status === "string" &&
        task.status !== "invalidated",
    );
    if (tasks.length === 0) return undefined;
    const doneStatuses = new Set(["approved", "integrating", "completed"]);
    const done = tasks.filter((task) => doneStatuses.has(task.status)).length;
    const width = 10;
    const filled = Math.round((done / tasks.length) * width);
    const bar = `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${done}/${tasks.length}`;
    const active = tasks
      .filter((task) => !doneStatuses.has(task.status) && task.status !== "pending")
      .slice(0, 2)
      .map((task) => `${task.id} ${task.status}`);
    const state = readJson(join(repoRoot, ".orchestrator", "state.json"));
    const phase = state?.status === "final_validating" ? "Final validation · " : "";
    const activeText = active.length > 0 ? ` · ${active.join(", ")}` : "";
    return `${phase}${bar} tasks${activeText}`;
  } catch {
    return undefined;
  }
}

export function classifyOutcome(
  exitCode: number,
  command: string,
  stdout: string,
  stderr: string,
): { symbol: string; message: string; notification: "info" | "warning" | "error" } {
  const label = completionLabel(command);
  if (exitCode !== 0) {
    const reason = firstLine(stderr).replace(/^orchestrator:\s*/, "");
    return {
      symbol: "✗",
      message: reason ? `${label} failed — ${reason}` : `${label} failed`,
      notification: "error",
    };
  }
  if (progressCommands.has(command)) {
    const status = jsonStatus(stdout);
    if (status === "blocked") {
      return { symbol: "!", message: `${label} blocked`, notification: "warning" };
    }
    if (status === "failed") {
      return { symbol: "✗", message: `${label} failed`, notification: "error" };
    }
  }
  return { symbol: "✓", message: successMessage(command), notification: "info" };
}

function actionFor(command: string): string {
  return {
    plan: "Planning task DAG",
    run: "Running task lifecycle",
    status: "Loading status",
    task: "Loading task",
    retry: "Retrying task",
    review: "Reviewing task",
    integrate: "Integrating approved tasks",
    resume: "Resuming orchestration",
    graph: "Loading task graph",
    logs: "Loading task logs",
  }[command] ?? "Running command";
}

function completionLabel(command: string): string {
  return {
    plan: "Plan",
    run: "Run",
    status: "Status",
    task: "Task",
    retry: "Retry",
    review: "Review",
    integrate: "Integration",
    resume: "Resume",
    graph: "Graph",
    logs: "Logs",
    help: "Help",
  }[command] ?? "Command";
}

function successMessage(command: string): string {
  return {
    plan: "Plan created",
    run: "Run completed",
    status: "Status loaded",
    task: "Task loaded",
    retry: "Retry completed",
    review: "Review completed",
    integrate: "Integration completed",
    resume: "Resume completed",
    graph: "Graph loaded",
    logs: "Logs loaded",
    help: "Help loaded",
  }[command] ?? "Command completed";
}

function commandFrom(argv: string[]): string {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--repo" || value === "--config") {
      index += 1;
      continue;
    }
    if (commandNames.has(value)) return value;
    return "command";
  }
  return "command";
}

function repoFrom(argv: string[], cwd: string): string {
  const index = argv.indexOf("--repo");
  const explicit = index >= 0 ? argv[index + 1] : undefined;
  return resolve(cwd, explicit ?? ".");
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function jsonStatus(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { status?: unknown };
    return typeof value.status === "string" ? value.status : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0.1, milliseconds / 1_000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function splitCommandLine(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        result.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote in /orchestrator arguments");
  if (started) result.push(current);
  return result;
}

function captureIo(): {
  io: CommandIo;
  stdout(): string;
  stderr(): string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(value) { stdout += value; },
      stderr(value) { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
