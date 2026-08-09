import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.js";
import { parseReviewResult } from "../src/models.js";
import { RunStore } from "../src/persistence.js";
import {
  PiRunner,
  createRoleResourceLoader,
  parsePiResult,
  type PiSdkAdapter,
  type SdkSession,
  type SdkSessionRequest,
} from "../src/runner.js";
import { temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent: AgentConfig = {
  identity: "curry",
  role: "reviewer",
  skill: "reviewer",
  model: "openai-codex/example:high",
};

function assistantEvent(value: unknown, stopReason = "stop"): unknown {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  };
}

class FakeSession implements SdkSession {
  private listener: (event: unknown) => void = () => undefined;
  aborted = false;

  constructor(
    readonly events: unknown[] = [],
    readonly promptAction?: () => Promise<void>,
  ) {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => { this.listener = () => undefined; };
  }

  async prompt(): Promise<void> {
    for (const event of this.events) this.listener(event);
    await this.promptAction?.();
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {}
}

class FakeSdk implements PiSdkAdapter {
  runtimeCount = 0;
  readonly requests: SdkSessionRequest[] = [];

  constructor(readonly factory: (request: SdkSessionRequest) => SdkSession) {}

  async createRuntime(): Promise<unknown> {
    this.runtimeCount += 1;
    return { offline: true };
  }

  async createSession(request: SdkSessionRequest): Promise<SdkSession> {
    this.requests.push(request);
    return this.factory(request);
  }
}

function latestRecord(store: RunStore): Record<string, unknown> {
  const directory = join(store.runsDir, "T1", "reviewer");
  const name = readdirSync(directory).find((candidate) => candidate.endsWith(".json"))!;
  return JSON.parse(readFileSync(join(directory, name), "utf8"));
}

describe("Pi SDK runner", () => {
  it("uses the authoritative final message_end event", () => {
    const review = { taskId: "T1", status: "approved", issues: [] };
    const stdout = [
      JSON.stringify({ type: "session", id: "session-1" }),
      JSON.stringify({ type: "message_update", delta: "not authoritative" }),
      JSON.stringify(assistantEvent(review)),
    ].join("\n");
    expect(parsePiResult(stdout, parseReviewResult)).toEqual(review);
  });

  it("uses strict role settings, persists results, and reuses one offline runtime", async () => {
    const review = { taskId: "T1", status: "approved", issues: [] };
    const sdk = new FakeSdk(() => new FakeSession([assistantEvent(review)]));
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(join(root, ".orchestrator"));
    const runner = new PiRunner(root, store, 1_000, sdk);
    for (let count = 0; count < 2; count += 1) {
      await runner.run({ agent, taskId: "T1", cwd: root, prompt: "Review", parser: parseReviewResult });
    }
    const request = sdk.requests[0]!;
    const record = latestRecord(store);
    expect(sdk.runtimeCount).toBe(1);
    expect(request.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(request.model).toBe(agent.model);
    expect(request.skillPath).toMatch(/skills\/reviewer\/SKILL\.md$/);
    expect(request.sessionDir).toMatch(/runs\/T1\/reviewer\/sessions$/);
    expect(record).toMatchObject({ agent: "curry", role: "reviewer", exitCode: 0 });
    expect(record.structuredResult).toEqual(review);
    expect(String(record.stdout)).toContain('"type":"message_end"');
  });

  it("persists SDK failures with stderr", async () => {
    const sdk = new FakeSdk(() => new FakeSession([], async () => { throw new Error("provider failed"); }));
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(join(root, ".orchestrator"));
    const runner = new PiRunner(root, store, 1_000, sdk);
    await expect(runner.run({
      agent, taskId: "T1", cwd: root, prompt: "Review", parser: parseReviewResult,
    })).rejects.toThrow(/exited with 1/);
    expect(latestRecord(store)).toMatchObject({ exitCode: 1, stderr: "provider failed", structuredResult: null });
  });

  it("persists aborted final messages before reporting failure", async () => {
    const event = {
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted", errorMessage: "cancelled", content: [] },
    };
    const sdk = new FakeSdk(() => new FakeSession([event]));
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(join(root, ".orchestrator"));
    const runner = new PiRunner(root, store, 1_000, sdk);
    await expect(runner.run({
      agent, taskId: "T1", cwd: root, prompt: "Review", parser: parseReviewResult,
    })).rejects.toThrow(/assistant request failed/);
    expect(latestRecord(store)).toMatchObject({ exitCode: 0, structuredResult: null });
    expect(String(latestRecord(store).stderr)).toContain("cancelled");
  });

  it("aborts and persists timed-out sessions", async () => {
    const session = new FakeSession([], () => new Promise<void>(() => undefined));
    const sdk = new FakeSdk(() => session);
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(join(root, ".orchestrator"));
    const runner = new PiRunner(root, store, 10, sdk);
    await expect(runner.run({
      agent, taskId: "T1", cwd: root, prompt: "Review", parser: parseReviewResult,
    })).rejects.toThrow(/exited with -1/);
    expect(session.aborted).toBe(true);
    expect(latestRecord(store)).toMatchObject({ exitCode: -1, structuredResult: null });
    expect(String(latestRecord(store).stderr)).toContain("timed out");
  });

  it("rejects missing final messages and invalid structured output", async () => {
    for (const events of [
      [{ type: "agent_end" }],
      [assistantEvent({ taskId: "T1", status: "approved", issues: [{ bad: true }] })],
    ]) {
      const sdk = new FakeSdk(() => new FakeSession(events));
      const root = temporaryDirectory(); roots.push(root);
      const store = new RunStore(join(root, ".orchestrator"));
      const runner = new PiRunner(root, store, 1_000, sdk);
      await expect(runner.run({
        agent, taskId: "T1", cwd: root, prompt: "Review", parser: parseReviewResult,
      })).rejects.toThrow(/run record/);
      expect(latestRecord(store).structuredResult).toBeNull();
    }
  });

  it("disables extension recursion while retaining the role skill and repository context", async () => {
    const root = temporaryDirectory(); roots.push(root);
    mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(root, ".pi", "extensions", "recursive.ts"), "throw new Error('must not load');\n");
    writeFileSync(join(root, "AGENTS.md"), "# Target context\n");
    const skillPath = join(process.cwd(), "skills", "coder", "SKILL.md");
    const loader = await createRoleResourceLoader(root, skillPath);
    expect(loader.getExtensions().extensions).toHaveLength(0);
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["coder"]);
    expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(root, "AGENTS.md"))).toBe(true);
  });
});
