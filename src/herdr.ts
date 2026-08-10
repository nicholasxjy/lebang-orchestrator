import type { AgentConfig } from "./config.js";
import type { ProcessOptions, ProcessResult } from "./process.js";
import { runProcess } from "./process.js";

const agentPaneReadyAttempts = 40;
const agentPaneReadyDelayMs = 250;

export class HerdrError extends Error {
  override readonly name = "HerdrError";
}

export interface HerdrAgentSpec {
  agent: AgentConfig;
  cwd: string;
  sessionDir: string;
  skillPath: string;
  tools: readonly string[];
}

export interface HerdrAgentLocation {
  paneId: string;
  reused: boolean;
}

export class HerdrAdapter {
  constructor(
    readonly enabled: boolean,
    readonly command: string,
    readonly repoRoot: string,
    readonly execute: (
      command: readonly string[],
      cwd: string,
      options?: ProcessOptions,
    ) => Promise<ProcessResult> = runProcess,
    readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async runAgent(
    spec: HerdrAgentSpec,
    prompt: string,
    marker: string,
    timeoutMs: number,
  ): Promise<string> {
    this.assertSession();
    await this.ensureAgent(spec);
    const transportPrompt = [
      prompt,
      "",
      "Herdr result transport:",
      `End the response with ${marker}_BEGIN on its own line, then one compact JSON object on one line, then ${marker}_END on its own line.`,
      "Do not place any text after the end marker.",
    ].join("\n");
    await this.run(
      [
        this.command,
        "agent",
        "prompt",
        spec.agent.identity,
        transportPrompt,
        "--wait",
        "--timeout",
        String(timeoutMs),
      ],
      spec.cwd,
      timeoutMs + 5_000,
      `prompt ${spec.agent.identity}`,
    );
    const read = await this.run(
      [
        this.command,
        "agent",
        "read",
        spec.agent.identity,
        "--source",
        "recent-unwrapped",
        "--lines",
        "1000",
      ],
      spec.cwd,
      30_000,
      `read ${spec.agent.identity}`,
    );
    return responseText(read.stdout);
  }

  private assertSession(): void {
    if (!this.enabled) {
      throw new HerdrError("Herdr is disabled in the orchestrator configuration");
    }
    if (this.environment.HERDR_ENV !== "1") {
      throw new HerdrError("orchestrator must run inside a Herdr-managed pane");
    }
  }

  private async ensureAgent(spec: HerdrAgentSpec): Promise<HerdrAgentLocation> {
    const existing = await this.existingAgent(spec);
    if (existing !== undefined) return existing;
    const tab = await this.createTab(spec.cwd, `orchestrator-${spec.agent.identity}`);
    await this.startAgent(spec, tab.rootPaneId);
    return { paneId: tab.rootPaneId, reused: false };
  }

  private async existingAgent(spec: HerdrAgentSpec): Promise<HerdrAgentLocation | undefined> {
    const existing = await this.execute(
      [this.command, "agent", "get", spec.agent.identity],
      spec.cwd,
      { timeoutMs: 30_000 },
    );
    if (existing.exitCode === 0) {
      const cwd = responseCwd(existing.stdout);
      if (cwd !== undefined && cwd !== this.repoRoot && !cwd.startsWith(`${this.repoRoot}/.worktrees/`)) {
        throw new HerdrError(
          `Herdr agent name ${spec.agent.identity} is already used by a different repository: ${cwd}`,
        );
      }
      const paneId = responsePaneId(existing.stdout) ?? spec.agent.identity;
      return { paneId, reused: true };
    }
    return undefined;
  }

  private async createTab(
    cwd: string,
    label: string,
  ): Promise<{ tabId: string; rootPaneId: string }> {
    const workspaceId = this.environment.HERDR_WORKSPACE_ID;
    if (!workspaceId) throw new HerdrError("Herdr did not provide HERDR_WORKSPACE_ID");
    const result = await this.run(
      [
        this.command,
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ],
      cwd,
      30_000,
      `create tab ${label}`,
    );
    const tabId = responseTabId(result.stdout);
    const rootPaneId = responsePaneId(result.stdout);
    if (!tabId || !rootPaneId) {
      throw new HerdrError(`Herdr tab create for ${label} returned incomplete identifiers`);
    }
    return { tabId, rootPaneId };
  }

  private async startAgent(spec: HerdrAgentSpec, paneId: string): Promise<void> {
    const command = [
      this.command,
      "agent",
      "start",
      spec.agent.identity,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--",
      "--mode",
      "text",
      "--model",
      spec.agent.model,
      "--skill",
      spec.skillPath,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools",
      spec.tools.join(","),
      "--session-dir",
      spec.sessionDir,
      "--name",
      spec.agent.identity,
    ];
    for (let attempt = 1; attempt <= agentPaneReadyAttempts; attempt += 1) {
      const result = await this.execute(command, spec.cwd, { timeoutMs: 60_000 });
      if (result.exitCode === 0) return;
      if (
        responseErrorCode(result) !== "agent_pane_busy" ||
        attempt === agentPaneReadyAttempts
      ) {
        const detail = processResultDetail(result);
        throw new HerdrError(
          `Herdr start ${spec.agent.identity} failed with ${result.exitCode}: ${detail}`,
        );
      }
      await delay(agentPaneReadyDelayMs);
    }
  }

  private async run(
    command: readonly string[],
    cwd: string,
    timeoutMs: number,
    action: string,
  ): Promise<ProcessResult> {
    const result = await this.execute(command, cwd, { timeoutMs });
    if (result.exitCode !== 0) {
      const detail = processResultDetail(result);
      throw new HerdrError(`Herdr ${action} failed with ${result.exitCode}: ${detail}`);
    }
    return result;
  }
}

function responseErrorCode(result: ProcessResult): string | undefined {
  for (const output of [result.stderr, result.stdout]) {
    if (!output.trim()) continue;
    try {
      const response = JSON.parse(output) as { error?: { code?: unknown } };
      if (typeof response.error?.code === "string") return response.error.code;
    } catch {
      // Non-JSON errors are handled as ordinary Herdr command failures.
    }
  }
  return undefined;
}

function processResultDetail(result: ProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || "no output";
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function responsePaneId(stdout: string): string | undefined {
  const response = parseResponse(stdout);
  return findString(response, new Set(["pane_id", "paneId"]));
}

function responseTabId(stdout: string): string | undefined {
  const response = parseResponse(stdout);
  return findString(response, new Set(["tab_id", "tabId"]));
}

function responseCwd(stdout: string): string | undefined {
  const response = parseResponse(stdout);
  return findString(response, new Set(["cwd"]));
}

function responseText(stdout: string): string {
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const values: string[] = [];
  collectStrings(response, values);
  values.sort((left, right) => right.length - left.length);
  return values.join("\n");
}

function parseResponse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new HerdrError(`Herdr returned malformed JSON: ${errorMessage(error)}`);
  }
}

function findString(value: unknown, keys: Set<string>): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string") return item;
    const found = findString(item, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectStrings(value: unknown, target: string[]): void {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(item, target);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
