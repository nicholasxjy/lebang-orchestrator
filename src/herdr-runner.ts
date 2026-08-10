import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  resolveSkillPath,
  type AgentConfig,
  type OrchestratorConfig,
} from "./config.js";
import {
  HerdrAdapter,
  type HerdrAgentSpec,
} from "./herdr.js";
import { formatJson } from "./json.js";
import type { PiRunRecord, ResultParser } from "./models.js";
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

function formatLog(record: PiRunRecord): string {
  const { stdout, stderr, ...metadata } = record;
  return `${formatJson(metadata)}\n--- Herdr transcript ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
