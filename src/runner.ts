import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./config.js";
import { resolveSkillPath } from "./config.js";
import { formatJson } from "./json.js";
import {
  SchemaError,
  type PiRunRecord,
  type ResultParser,
} from "./models.js";
import { type RunStore, utcNow } from "./persistence.js";

export class AgentRunError extends Error {
  override readonly name = "AgentRunError";
}

export const RoleTools = {
  planner: ["read", "grep", "find", "ls", "bash"],
  coder: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  tester: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls", "bash"],
  integrator: ["read", "grep", "find", "ls", "bash"],
} as const;

export interface PiRunArtifact {
  runId: string;
  recordPath: string;
  logPath: string;
}

export interface AgentRunRequest<T> {
  agent: AgentConfig;
  taskId: string;
  cwd: string;
  prompt: string;
  parser: ResultParser<T>;
  stateTransition?: string;
}

export interface AgentRunner {
  run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact | undefined]>;
}

export interface SdkSession {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface SdkSessionRequest {
  cwd: string;
  sessionDir: string;
  name: string;
  tools: readonly string[];
  skillPath: string;
  model: string;
  runtime: unknown;
}

export interface PiSdkAdapter {
  createRuntime(): Promise<unknown>;
  createSession(request: SdkSessionRequest): Promise<SdkSession>;
}

let sharedRuntime: Promise<ModelRuntime> | undefined;

export const defaultPiSdk: PiSdkAdapter = {
  createRuntime(): Promise<ModelRuntime> {
    sharedRuntime ??= ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    return sharedRuntime;
  },

  async createSession(request: SdkSessionRequest): Promise<SdkSession> {
    const modelRuntime = request.runtime as ModelRuntime;
    const resolved = resolveCliModel({
      cliModel: request.model,
      modelRuntime,
    });
    if (resolved.error || !resolved.model) {
      throw new AgentRunError(resolved.error ?? `cannot resolve model ${request.model}`);
    }
    const sessionManager = SessionManager.create(request.cwd, request.sessionDir);
    sessionManager.appendSessionInfo(request.name);
    const resourceLoader = await createRoleResourceLoader(request.cwd, request.skillPath);
    const { session } = await createAgentSession({
      cwd: request.cwd,
      modelRuntime,
      model: resolved.model,
      ...(resolved.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: resolved.thinkingLevel }),
      tools: [...request.tools],
      resourceLoader,
      sessionManager,
    });
    return session;
  },
};

export class PiRunner implements AgentRunner {
  private runtimePromise: Promise<unknown> | undefined;

  constructor(
    readonly repoRoot: string,
    readonly store: RunStore,
    readonly timeoutMs = 3_600_000,
    readonly sdk: PiSdkAdapter = defaultPiSdk,
  ) {}

  async run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact]> {
    const runId = randomUUID().replaceAll("-", "");
    const startTime = utcNow();
    const sessionDir = join(
      this.store.runsDir,
      request.taskId,
      request.agent.role,
      "sessions",
    );
    mkdirSync(sessionDir, { recursive: true });
    const events: unknown[] = [];
    let stderr = "";
    let exitCode = 0;
    let session: SdkSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const skillPath = resolveSkillPath(this.repoRoot, request.agent.skill);
      if (!existsSync(skillPath)) {
        throw new AgentRunError(`configured skill does not exist: ${skillPath}`);
      }
      this.runtimePromise ??= this.sdk.createRuntime();
      const runtime = await this.runtimePromise;
      session = await this.sdk.createSession({
        cwd: request.cwd,
        sessionDir,
        name: `${request.taskId}-${request.agent.identity}-${runId.slice(0, 8)}`,
        tools: RoleTools[request.agent.role],
        skillPath,
        model: request.agent.model,
        runtime,
      });
      unsubscribe = session.subscribe((event) => events.push(event));
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void session!.abort().catch(() => undefined);
          reject(new RunnerTimeout());
        }, this.timeoutMs);
      });
      await Promise.race([session.prompt(request.prompt), timeout]);
    } catch (error) {
      if (timedOut || error instanceof RunnerTimeout) {
        exitCode = -1;
        stderr = `Pi timed out after ${Math.floor(this.timeoutMs / 1000)}s`;
      } else {
        exitCode = 1;
        stderr = errorMessage(error);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      session?.dispose();
    }

    const stdout = events.map(serializeEvent).join("\n") + (events.length ? "\n" : "");
    let result: T | undefined;
    let parseError: AgentRunError | undefined;
    if (exitCode === 0) {
      try {
        result = parsePiResult(stdout, request.parser);
      } catch (error) {
        parseError = error instanceof AgentRunError
          ? error
          : new AgentRunError(errorMessage(error));
        stderr = parseError.message;
      }
    }
    const structured = result === undefined
      ? null
      : structuredClone(result) as Record<string, unknown>;
    const record: PiRunRecord = {
      runId,
      taskId: request.taskId,
      agent: request.agent.identity,
      role: request.agent.role,
      model: request.agent.model,
      cwd: request.cwd,
      startTime,
      endTime: utcNow(),
      exitCode,
      stdout,
      stderr,
      structuredResult: structured,
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
    if (exitCode !== 0) {
      throw new AgentRunError(`Pi SDK run exited with ${exitCode}; run record: ${recordPath}`);
    }
    if (parseError) {
      throw new AgentRunError(`${parseError.message}; run record: ${recordPath}`);
    }
    return [result!, artifact];
  }
}

export async function createRoleResourceLoader(
  cwd: string,
  skillPath: string,
): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths: [skillPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  return resourceLoader;
}

export function parsePiResult<T>(stdout: string, parser: ResultParser<T>): T {
  let finalMessage: Record<string, unknown> | undefined;
  let number = 0;
  for (const line of stdout.split(/\r?\n/)) {
    number += 1;
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new AgentRunError(`Pi emitted invalid JSON on line ${number}: ${errorMessage(error)}`);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new AgentRunError(`Pi emitted a non-object event on line ${number}`);
    }
    const object = event as Record<string, unknown>;
    if (object.type === "message_end") {
      const message = object.message;
      if (
        message !== null &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).role === "assistant"
      ) {
        finalMessage = message as Record<string, unknown>;
      }
    }
  }
  if (!finalMessage) {
    throw new AgentRunError("Pi output did not contain a final assistant message_end event");
  }
  if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
    const reason = finalMessage.errorMessage ?? finalMessage.stopReason;
    throw new AgentRunError(`Pi assistant request failed: ${String(reason)}`);
  }
  if (!Array.isArray(finalMessage.content)) {
    throw new AgentRunError("Pi final assistant message has invalid content");
  }
  const text = finalMessage.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === "text" &&
        typeof (item as Record<string, unknown>).text === "string",
    )
    .map((item) => item.text)
    .join("")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgentRunError(`Pi final assistant message is not one JSON object: ${errorMessage(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentRunError("Pi structured result must be an object");
  }
  try {
    return parser(raw);
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new AgentRunError(`Pi structured result failed validation: ${error.message}`);
    }
    throw error;
  }
}

function serializeEvent(event: unknown): string {
  try {
    return JSON.stringify(event);
  } catch (error) {
    return JSON.stringify({ type: "serialization_error", error: errorMessage(error) });
  }
}

function formatLog(record: PiRunRecord): string {
  const { stdout, stderr, ...metadata } = record;
  return `${formatJson(metadata)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RunnerTimeout extends Error {}

export type { AgentSessionEvent };
