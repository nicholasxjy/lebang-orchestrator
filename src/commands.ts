import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, resolveConfigPath } from "./config.js";
import { EngineError, OrchestratorEngine } from "./engine.js";
import { formatJson } from "./json.js";
import { SchemaError } from "./models.js";
import { RunStore, StoreError } from "./persistence.js";
import { runProcess } from "./process.js";

export interface CommandIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CommandOptions {
  cwd?: string;
  defaultRepo?: string;
  io?: CommandIo;
}

interface ParsedArguments {
  repo?: string;
  config?: string;
  command?: string;
  values: string[];
  help: boolean;
}

const commands = new Set([
  "init", "plan", "run", "status", "task", "retry", "review", "integrate", "resume", "graph", "logs",
]);

export const helpText = `usage: orchestrator [--repo PATH] [--config PATH] COMMAND [ARG]

commands:
  init GOAL    start the Herdr team and run a goal from planner to completion
  plan GOAL    plan a user goal through lebang
  run          run ready tasks through the full lifecycle
  status       show persisted orchestration status
  task ID      show one persisted task
  retry ID     retry a stopped task with its owner
  review ID    rerun review for a task
  integrate    integrate approved task commits
  resume       recover interrupted orchestration state
  graph        print the task DAG in DOT format
  logs ID      print preserved agent logs for a task
`;

export async function executeCommand(
  argv: readonly string[],
  options: CommandOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdout: (value: string) => process.stdout.write(value),
    stderr: (value: string) => process.stderr.write(value),
  };
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      io.stdout(helpText);
      return 0;
    }
    if (!parsed.command) throw new EngineError("a command is required");
    validateCommandValues(parsed.command, parsed.values);
    const cwd = resolve(options.cwd ?? process.cwd());
    const repo = resolve(
      parsed.repo ?? options.defaultRepo ?? await gitRoot(cwd),
    );
    const store = new RunStore(join(repo, ".orchestrator"));
    if (parsed.command === "status") {
      io.stdout(printStatus(store));
      return 0;
    }
    if (parsed.command === "task") {
      const task = store.loadPlan().tasks.find((candidate) => candidate.id === parsed.values[0]);
      if (!task) throw new SchemaError(`unknown task: ${parsed.values[0]}`);
      io.stdout(`${formatJson(task)}\n`);
      return 0;
    }
    if (parsed.command === "graph") {
      io.stdout(printGraph(store));
      return 0;
    }
    if (parsed.command === "logs") {
      io.stdout(printLogs(store, parsed.values[0]!));
      return 0;
    }
    const configPath = resolveConfigPath(
      repo,
      parsed.config === undefined ? undefined : resolve(cwd, parsed.config),
    );
    const engine = new OrchestratorEngine(repo, loadConfig(configPath));
    let value: unknown;
    switch (parsed.command) {
      case "init": {
        const team = await engine.initializeTeam();
        try {
          const plan = await engine.planGoal(parsed.values[0]!);
          const result = await engine.run();
          await engine.presentToPlanner(result);
          value = { status: result.status, team, plan, result };
        } catch (error) {
          await engine.presentToPlanner(
            error instanceof Error ? error : new Error(String(error)),
          ).catch(() => undefined);
          throw error;
        }
        break;
      }
      case "plan":
        value = await engine.planGoal(parsed.values[0]!);
        break;
      case "run":
        value = await engine.run();
        break;
      case "integrate":
        value = await engine.integrate();
        break;
      case "retry":
        await engine.retry(parsed.values[0]!);
        value = await engine.run();
        break;
      case "review":
        await engine.reviewTask(parsed.values[0]!);
        value = await engine.run();
        break;
      case "resume":
        value = await engine.resume();
        break;
      default:
        throw new EngineError(`unsupported command: ${parsed.command}`);
    }
    io.stdout(`${formatJson(value)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`orchestrator: ${errorMessage(error)}\n`);
    return 2;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = { values: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (value === "--repo" || value === "--config") {
      const next = argv[index + 1];
      if (!next) throw new EngineError(`${value} requires a path`);
      if (value === "--repo") parsed.repo = next;
      else parsed.config = next;
      index += 1;
      continue;
    }
    if (!parsed.command) {
      if (!commands.has(value)) throw new EngineError(`unknown command: ${value}`);
      parsed.command = value;
    } else {
      parsed.values.push(value);
    }
  }
  return parsed;
}

function validateCommandValues(command: string, values: string[]): void {
  const needsOne = new Set(["init", "plan", "task", "retry", "review", "logs"]);
  const expected = needsOne.has(command) ? 1 : 0;
  if (values.length !== expected) {
    const label = command === "plan" || command === "init" ? "goal" : "argument";
    throw new EngineError(`${command} requires ${expected === 1 ? `exactly one ${label}` : "no arguments"}`);
  }
}

async function gitRoot(cwd: string): Promise<string> {
  const result = await runProcess(["git", "rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0) {
    throw new EngineError("current directory is not inside a Git repository");
  }
  return result.stdout.trim();
}

function printStatus(store: RunStore): string {
  const plan = store.loadPlan();
  const state = store.loadState();
  const headers = [
    "ID", "TITLE", "STATUS", "AGENT", "DEPENDENCIES", "BRANCH", "REVIEWS", "BLOCKER",
  ];
  const rows = plan.tasks.map((task) => [
    task.id,
    task.title,
    task.status,
    task.assignedAgent ?? "-",
    task.dependencies.join(",") || "-",
    task.branch ?? "-",
    String(task.reviewAttempts),
    ["blocked", "failed", "interrupted"].includes(task.status)
      ? store.latestHistoryReason(task.id) ?? "-"
      : "-",
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const lines = [
    `run=${state.runId} status=${state.status}`,
    headers.map((value, index) => value.padEnd(widths[index]!)).join("  "),
    ...rows.map((row) => row.map((value, index) => value.padEnd(widths[index]!)).join("  ")),
  ];
  const counts = new Map<string, number>();
  for (const task of plan.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  lines.push(
    `summary ${[...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key}=${count}`).join(" ")}`,
  );
  return `${lines.join("\n")}\n`;
}

function printGraph(store: RunStore): string {
  const lines = ["digraph tasks {"];
  for (const task of store.loadPlan().tasks) {
    lines.push(`  "${task.id}" [label="${task.id}: ${task.title}\\n${task.status}"];`);
    for (const dependency of task.dependencies) {
      lines.push(`  "${dependency}" -> "${task.id}";`);
    }
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function printLogs(store: RunStore, taskId: string): string {
  if (!existsSync(store.logsDir)) throw new StoreError(`no logs found for task ${taskId}`);
  const names = readdirSync(store.logsDir)
    .filter((name) => name.startsWith(`${taskId}-`) && name.endsWith(".log"))
    .sort();
  if (names.length === 0) throw new StoreError(`no logs found for task ${taskId}`);
  return names.map((name) => `== ${name} ==\n${readFileSync(join(store.logsDir, name), "utf8")}`).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
