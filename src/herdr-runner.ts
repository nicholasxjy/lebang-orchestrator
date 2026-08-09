import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  agentForRole,
  resolveSkillPath,
  type AgentConfig,
  type OrchestratorConfig,
} from "./config.js";
import {
  HerdrAdapter,
  type HerdrAgentSpec,
  type HerdrTeam,
} from "./herdr.js";
import { formatJson } from "./json.js";
import type { PiRunRecord, ResultParser, RunResult } from "./models.js";
import { type RunStore, utcNow } from "./persistence.js";
import {
  AgentRunError,
  RoleTools,
  type AgentRunner,
  type AgentRunRequest,
  type PiRunArtifact,
} from "./runner.js";

export class HerdrRunner implements AgentRunner {
  constructor(
    readonly repoRoot: string,
    readonly store: RunStore,
    readonly config: OrchestratorConfig,
    readonly herdr: HerdrAdapter,
    readonly timeoutMs = 3_600_000,
  ) {}

  async initializeTeam(): Promise<HerdrTeam> {
    return this.herdr.initialize(initialAgents(this.config).map((agent) => this.spec(agent, this.repoRoot)));
  }

  async presentToPlanner(result: RunResult | Error): Promise<void> {
    const planner = agentForRole(this.config, "planner");
    const message = result instanceof Error
      ? [
          "The orchestration stopped with an error.",
          `Error: ${result.message}`,
          "Inspect the persisted .orchestrator state, explain the blocker, and show the next recovery command.",
        ].join("\n")
      : [
          "The orchestration lifecycle has finished.",
          formatJson(result),
          "Present the final goal status concisely. Distinguish completed, blocked, and failed outcomes.",
        ].join("\n");
    await this.herdr.present(this.spec(planner, this.repoRoot), message, this.timeoutMs);
  }

  async run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact]> {
    const runId = randomUUID().replaceAll("-", "");
    const marker = `ORCHESTRATOR_RESULT_${runId.toUpperCase()}`;
    const startTime = utcNow();
    let stdout = "";
    let stderr = "";
    let result: T | undefined;
    try {
      stdout = await this.herdr.runAgent(
        this.spec(request.agent, request.cwd),
        request.prompt,
        marker,
        this.timeoutMs,
      );
      result = parseHerdrResult(stdout, marker, request.parser);
    } catch (error) {
      stderr = errorMessage(error);
    }

    const record: PiRunRecord = {
      runId,
      taskId: request.taskId,
      agent: request.agent.identity,
      role: request.agent.role,
      model: request.agent.model,
      cwd: request.cwd,
      startTime,
      endTime: utcNow(),
      exitCode: result === undefined ? 1 : 0,
      stdout,
      stderr,
      structuredResult: result === undefined
        ? null
        : structuredClone(result) as Record<string, unknown>,
      stateTransition: request.stateTransition ?? null,
    };
    const recordPath = this.store.writeResult(
      request.taskId,
      request.agent.role,
      runId,
      record as unknown as Record<string, unknown>,
    );
    const logPath = this.store.writeLog(
      `${request.taskId}-${request.agent.identity}-${runId}.log`,
      formatLog(record),
    );
    const artifact = { runId, recordPath, logPath };
    if (result === undefined) {
      throw new AgentRunError(`Herdr agent run failed: ${stderr}; run record: ${recordPath}`);
    }
    return [result, artifact];
  }

  private spec(agent: AgentConfig, cwd: string): HerdrAgentSpec {
    return {
      agent,
      cwd,
      sessionDir: join(this.store.runsDir, "panes", agent.identity, "sessions"),
      skillPath: resolveSkillPath(this.repoRoot, agent.skill),
      tools: RoleTools[agent.role],
    };
  }
}

export function parseHerdrResult<T>(
  transcript: string,
  marker: string,
  parser: ResultParser<T>,
): T {
  const begin = `${marker}_BEGIN`;
  const end = `${marker}_END`;
  let offset = 0;
  let last: T | undefined;
  while (offset < transcript.length) {
    const start = transcript.indexOf(begin, offset);
    if (start < 0) break;
    const finish = transcript.indexOf(end, start + begin.length);
    if (finish < 0) break;
    const candidate = transcript.slice(start + begin.length, finish).trim();
    try {
      last = parser(JSON.parse(candidate));
    } catch {
      // The prompt itself contains the markers. Keep scanning for the agent's result.
    }
    offset = finish + end.length;
  }
  if (last === undefined) {
    throw new AgentRunError("Herdr transcript did not contain a valid marked result");
  }
  return last;
}

function initialAgents(config: OrchestratorConfig): AgentConfig[] {
  const fixed = ["planner", "tester", "reviewer", "integrator"] as const;
  const agents = fixed.map((role) => agentForRole(config, role));
  const coders = Object.values(config.agents)
    .filter((agent) => agent.role === "coder")
    .sort((left, right) => {
      if (left.identity === "kd") return -1;
      if (right.identity === "kd") return 1;
      return left.identity.localeCompare(right.identity);
    })
    .slice(0, config.maxWorkers);
  const byIdentity = new Map([...agents, ...coders].map((agent) => [agent.identity, agent]));
  return [...byIdentity.values()];
}

function formatLog(record: PiRunRecord): string {
  const { stdout, stderr, ...metadata } = record;
  return `${formatJson(metadata)}\n--- Herdr transcript ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
