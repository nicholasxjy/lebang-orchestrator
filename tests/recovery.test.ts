import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorEngine } from "../src/engine.js";
import { parseCoderResult } from "../src/models.js";
import { RunStore } from "../src/persistence.js";
import type { AgentRunner, AgentRunRequest, PiRunArtifact } from "../src/runner.js";
import { transitionTask } from "../src/state.js";
import { createRepository, git, makeTask, temporaryDirectory, testConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RecoveryRunner implements AgentRunner {
  readonly roles: string[] = [];

  async run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact | undefined]> {
    this.roles.push(request.agent.role);
    if (request.agent.role === "coder") {
      throw new Error("resume must not rerun a coder with committed evidence");
    }
    if (request.agent.role === "tester") {
      return [request.parser({
        taskId: request.taskId,
        status: "passed",
        testsExecuted: ["node --test"],
        testsAdded: [],
        failures: [],
        commit: null,
      }), undefined];
    }
    if (request.agent.role === "reviewer") {
      return [request.parser({ taskId: request.taskId, status: "approved", issues: [] }), undefined];
    }
    if (request.agent.role === "integrator") {
      const prompt = JSON.parse(request.prompt.slice(request.prompt.indexOf("\n") + 1));
      return [request.parser({
        status: "completed",
        summary: "recovered",
        integratedCommits: prompt.integratedCommits,
        validations: prompt.validationEvidence,
        issues: [],
      }), undefined];
    }
    throw new Error(`unexpected role ${request.agent.role}`);
  }
}

describe("recovery and Python-era compatibility", () => {
  it("reads a Python fixture and continues writing the same camelCase format", () => {
    const root = temporaryDirectory(); roots.push(root);
    cpSync(join(process.cwd(), "tests", "fixtures", "python-orchestrator"), root, { recursive: true });
    const store = new RunStore(root);
    const plan = store.loadPlan();
    expect(plan.goal).toBe("Continue a Python-era run");
    expect(store.loadState().runId).toBe("12345678-1234-5678-1234-567812345678");
    transitionTask(store, plan.tasks[0]!, "ready", "lebang", "continued by TypeScript");
    const persisted = JSON.parse(readFileSync(join(root, "tasks", "T1.json"), "utf8"));
    expect(persisted).toMatchObject({
      assignedAgent: "kd",
      reviewAttempts: 0,
      status: "ready",
      baseCommit: null,
    });
    expect(readFileSync(join(root, "history", "T1.jsonl"), "utf8")).toContain("continued by TypeScript");
  });

  it("resumes committed Python-era coder evidence without rerunning the coder", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new RecoveryRunner();
    const engine = new OrchestratorEngine(root, testConfig(), runner);
    const task = makeTask();
    engine.store.initialize({ goal: "Recover work", baseCommit, tasks: [task] });
    const worktree = await engine.git.prepareTaskWorktree(task, [task], baseCommit);
    writeFileSync(join(worktree, "feature.ts"), "export const value = 1;\n");
    mkdirSync(join(worktree, "tests"));
    writeFileSync(join(worktree, "tests", "feature.test.ts"), "// test\n");
    git(worktree, "add", "feature.ts", "tests/feature.test.ts");
    git(worktree, "commit", "-m", "completed before crash");
    const commit = git(worktree, "rev-parse", "HEAD");
    task.status = "running";
    engine.store.saveTask(task);
    const coderResult = parseCoderResult({
      taskId: "T1",
      status: "completed",
      summary: "done",
      changedFiles: ["feature.ts", "tests/feature.test.ts"],
      testsAdded: ["tests/feature.test.ts"],
      testsRun: ["node --test"],
      testResult: "passed",
      commit,
      blockers: [],
    });
    engine.store.writeResult("T1", "coder", "python-crashed-run", {
      runId: "python-crashed-run",
      taskId: "T1",
      agent: "kd",
      role: "coder",
      model: "example/coder",
      cwd: worktree,
      startTime: "2026-08-01T00:00:00+00:00",
      endTime: "2026-08-01T00:01:00+00:00",
      exitCode: 0,
      stdout: "",
      stderr: "",
      structuredResult: coderResult,
      stateTransition: "running -> self_verifying",
    });
    expect((await engine.resume()).status).toBe("completed");
    expect(runner.roles).not.toContain("coder");
    expect(engine.store.loadPlan().tasks[0]!.status).toBe("completed");
    expect(readFileSync(join(root, ".orchestrator", "history", "T1.jsonl"), "utf8"))
      .toContain('"toStatus":"interrupted"');
  });

  it("retries at independent testing when failed work has valid coder evidence", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new RecoveryRunner();
    const engine = new OrchestratorEngine(root, testConfig(), runner);
    const task = makeTask();
    engine.store.initialize({ goal: "Retry work", baseCommit, tasks: [task] });
    const worktree = await engine.git.prepareTaskWorktree(task, [task], baseCommit);
    writeFileSync(join(worktree, "feature.ts"), "export const value = 1;\n");
    mkdirSync(join(worktree, "tests"));
    writeFileSync(join(worktree, "tests", "feature.test.ts"), "// test\n");
    git(worktree, "add", "feature.ts", "tests/feature.test.ts");
    git(worktree, "commit", "-m", "completed before tester failure");
    const commit = git(worktree, "rev-parse", "HEAD");
    task.status = "failed";
    task.commit = commit;
    engine.store.saveTask(task);
    const coderResult = {
      taskId: "T1",
      status: "completed",
      summary: "done",
      changedFiles: ["feature.ts", "tests/feature.test.ts"],
      testsAdded: ["tests/feature.test.ts"],
      testsRun: ["node --test"],
      testResult: "passed",
      commit,
      blockers: [],
    };
    engine.store.writeResult("T1", "coder", "python-completed-run", {
      exitCode: 0,
      structuredResult: coderResult,
    });
    await engine.retry("T1");
    expect((await engine.run()).status).toBe("completed");
    expect(runner.roles).not.toContain("coder");
  });
});
