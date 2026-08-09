import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorEngine } from "../src/engine.js";
import type {
  AgentRunner,
  AgentRunRequest,
  PiRunArtifact,
} from "../src/runner.js";
import { createRepository, git, makeTask, temporaryDirectory, testConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type RunTuple<T> = [T, PiRunArtifact | undefined];

class ApprovedRunner implements AgentRunner {
  readonly roles: string[] = [];

  constructor(readonly baseCommit: string) {}

  async run<T>(request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    this.roles.push(request.agent.role);
    if (request.agent.role === "planner") {
      return this.value(request, {
        goal: "Add a feature",
        baseCommit: this.baseCommit,
        tasks: [makeTask({
          title: "Add feature",
          acceptanceCriteria: ["Feature and direct test are committed"],
        })],
      });
    }
    if (request.agent.role === "coder") {
      writeFileSync(join(request.cwd, "feature.ts"), "export const value = 1;\n");
      mkdirSync(join(request.cwd, "tests"), { recursive: true });
      writeFileSync(join(request.cwd, "tests", "feature.test.ts"), "// direct test\n");
      git(request.cwd, "add", "feature.ts", "tests/feature.test.ts");
      git(request.cwd, "commit", "-m", `${request.taskId} implementation`);
      return this.value(request, {
        taskId: request.taskId,
        status: "completed",
        summary: "implemented and tested",
        changedFiles: ["feature.ts", "tests/feature.test.ts"],
        testsAdded: ["tests/feature.test.ts"],
        testsRun: ["node --test"],
        testResult: "passed",
        commit: git(request.cwd, "rev-parse", "HEAD"),
        blockers: [],
      });
    }
    if (request.agent.role === "tester") {
      return this.value(request, {
        taskId: request.taskId,
        status: "passed",
        testsExecuted: ["node --test"],
        testsAdded: [],
        failures: [],
        commit: null,
      });
    }
    if (request.agent.role === "reviewer") {
      return this.value(request, { taskId: request.taskId, status: "approved", issues: [] });
    }
    if (request.agent.role === "integrator") {
      const prompt = promptPayload(request.prompt);
      return this.value(request, {
        status: "completed",
        summary: "integrated and validated",
        integratedCommits: prompt.integratedCommits,
        validations: prompt.validationEvidence,
        issues: [],
      });
    }
    throw new Error(`unexpected role ${request.agent.role}`);
  }

  protected value<T>(request: AgentRunRequest<T>, value: unknown): RunTuple<T> {
    return [request.parser(value), undefined];
  }
}

class ConcurrentRunner extends ApprovedRunner {
  private coderCount = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolveGate) => { this.release = resolveGate; });

  override async run<T>(request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    if (request.agent.role === "planner") {
      this.roles.push("planner");
      return this.value(request, {
        goal: "Parallel work",
        baseCommit: this.baseCommit,
        tasks: [
          makeTask({ id: "T1", assignedAgent: "kd" }),
          makeTask({ id: "T2", assignedAgent: "harden" }),
        ],
      });
    }
    if (request.agent.role === "coder") {
      this.roles.push("coder");
      this.coderCount += 1;
      if (this.coderCount === 2) this.release();
      await this.gate;
      const source = `${request.taskId.toLowerCase()}.ts`;
      const testFile = `tests/${request.taskId.toLowerCase()}.test.ts`;
      writeFileSync(join(request.cwd, source), `export const value = "${request.taskId}";\n`);
      mkdirSync(join(request.cwd, "tests"), { recursive: true });
      writeFileSync(join(request.cwd, testFile), "// test\n");
      git(request.cwd, "add", source, testFile);
      git(request.cwd, "commit", "-m", request.taskId);
      return this.value(request, {
        taskId: request.taskId,
        status: "completed",
        summary: "done",
        changedFiles: [source, testFile],
        testsAdded: [testFile],
        testsRun: ["node --test"],
        testResult: "passed",
        commit: git(request.cwd, "rev-parse", "HEAD"),
        blockers: [],
      });
    }
    return super.run(request);
  }
}

class UnassignedPlanRunner extends ApprovedRunner {
  override async run<T>(request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    if (request.agent.role !== "planner") return super.run(request);
    return this.value(request, {
      goal: "Route work",
      baseCommit: this.baseCommit,
      tasks: [
        makeTask({ id: "T1", assignedAgent: null }),
        makeTask({ id: "T2", assignedAgent: null }),
        makeTask({ id: "T3", assignedAgent: null }),
      ],
    });
  }
}

class TestReworkRunner extends ApprovedRunner {
  coderCount = 0;
  testerCount = 0;
  reviewCount = 0;

  override async run<T>(request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    if (request.agent.role === "coder") {
      this.coderCount += 1;
      return super.run(request);
    }
    if (request.agent.role === "tester") {
      this.roles.push("tester");
      this.testerCount += 1;
      if (this.testerCount === 1) {
        return this.value(request, {
          taskId: request.taskId,
          status: "passed",
          testsExecuted: ["node --test"],
          testsAdded: [],
          failures: [],
          commit: null,
        });
      }
      writeFileSync(join(request.cwd, "tests", "regression.test.ts"), "// regression\n");
      git(request.cwd, "add", "tests/regression.test.ts");
      git(request.cwd, "commit", "-m", "westbrook regression");
      return this.value(request, {
        taskId: request.taskId,
        status: "passed",
        testsExecuted: ["node --test"],
        testsAdded: ["tests/regression.test.ts"],
        failures: [],
        commit: git(request.cwd, "rev-parse", "HEAD"),
      });
    }
    if (request.agent.role === "reviewer") {
      this.roles.push("reviewer");
      this.reviewCount += 1;
      if (this.reviewCount === 1) {
        return this.value(request, {
          taskId: request.taskId,
          status: "changes_requested",
          issues: [{
            severity: "medium",
            scope: "test",
            description: "Missing regression coverage",
            expected: "Add a regression test",
            ownerTaskId: request.taskId,
          }],
        });
      }
      return this.value(request, { taskId: request.taskId, status: "approved", issues: [] });
    }
    return super.run(request);
  }
}

class ProductionReworkRunner extends ApprovedRunner {
  readonly coderIdentities: string[] = [];
  reviewCount = 0;

  override async run<T>(request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    if (request.agent.role === "coder") {
      this.coderIdentities.push(request.agent.identity);
      if (this.coderIdentities.length === 1) return super.run(request);
      this.roles.push("coder");
      writeFileSync(join(request.cwd, "feature.ts"), "export const value = 2;\n");
      writeFileSync(join(request.cwd, "tests", "feature.test.ts"), "// corrected direct test\n");
      git(request.cwd, "add", "feature.ts", "tests/feature.test.ts");
      git(request.cwd, "commit", "-m", "production rework");
      return this.value(request, {
        taskId: request.taskId,
        status: "completed",
        summary: "reworked",
        changedFiles: ["feature.ts", "tests/feature.test.ts"],
        testsAdded: ["tests/feature.test.ts"],
        testsRun: ["node --test"],
        testResult: "passed",
        commit: git(request.cwd, "rev-parse", "HEAD"),
        blockers: [],
      });
    }
    if (request.agent.role === "reviewer") {
      this.roles.push("reviewer");
      this.reviewCount += 1;
      if (this.reviewCount === 1) {
        return this.value(request, {
          taskId: request.taskId,
          status: "changes_requested",
          issues: [{
            severity: "high",
            scope: "task",
            description: "Production behavior needs correction",
            expected: "Return the corrected value",
            ownerTaskId: request.taskId,
          }],
        });
      }
      return this.value(request, { taskId: request.taskId, status: "approved", issues: [] });
    }
    return super.run(request);
  }
}

class ReplanRunner extends ApprovedRunner {
  planCount = 0;
  reviewCount = 0;

  override async run<T>(request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    if (request.agent.role === "planner") {
      this.planCount += 1;
      if (this.planCount === 1) return super.run(request);
      this.roles.push("planner");
      const current = promptPayload(request.prompt).currentPlan as { tasks: ReturnType<typeof makeTask>[] };
      const old = { ...current.tasks[0]!, status: "invalidated" };
      return this.value(request, {
        goal: "Add a feature",
        baseCommit: this.baseCommit,
        tasks: [old, makeTask({ id: "T2", title: "Replacement", assignedAgent: "kd" })],
      });
    }
    if (request.agent.role === "coder" && request.taskId === "T2") {
      this.roles.push("coder");
      writeFileSync(join(request.cwd, "replacement.ts"), "export const value = 2;\n");
      mkdirSync(join(request.cwd, "tests"), { recursive: true });
      writeFileSync(join(request.cwd, "tests", "replacement.test.ts"), "// test\n");
      git(request.cwd, "add", "replacement.ts", "tests/replacement.test.ts");
      git(request.cwd, "commit", "-m", "replacement");
      return this.value(request, {
        taskId: "T2",
        status: "completed",
        summary: "replacement complete",
        changedFiles: ["replacement.ts", "tests/replacement.test.ts"],
        testsAdded: ["tests/replacement.test.ts"],
        testsRun: ["node --test"],
        testResult: "passed",
        commit: git(request.cwd, "rev-parse", "HEAD"),
        blockers: [],
      });
    }
    if (request.agent.role === "reviewer") {
      this.roles.push("reviewer");
      this.reviewCount += 1;
      if (this.reviewCount === 1) {
        return this.value(request, {
          taskId: "T1",
          status: "replan_required",
          issues: [{
            severity: "high",
            scope: "plan",
            description: "The task decomposition is incomplete",
            expected: "Replace the invalid task",
            ownerTaskId: "T1",
          }],
        });
      }
      return this.value(request, { taskId: request.taskId, status: "approved", issues: [] });
    }
    return super.run(request);
  }
}

class UnexpectedRunner implements AgentRunner {
  async run<T>(_request: AgentRunRequest<T>): Promise<RunTuple<T>> {
    throw new Error("agent must not run after a mechanical integration conflict");
  }
}

describe("engine lifecycle", () => {
  it("runs every role and finishes on an isolated integration branch", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new ApprovedRunner(baseCommit);
    const engine = new OrchestratorEngine(root, testConfig(), runner);
    await engine.planGoal("Add a feature");
    const result = await engine.run();
    const state = engine.store.loadState();
    expect(result.status).toBe("completed");
    expect(engine.store.loadPlan().tasks[0]!.status).toBe("completed");
    expect(state.integrationWorktree).not.toBeNull();
    expect(git(state.integrationWorktree!, "branch", "--show-current")).toBe(state.integrationBranch);
    expect(runner.roles).toEqual(["planner", "coder", "tester", "reviewer", "integrator"]);
  });

  it("runs independent tasks with different owners concurrently", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const config = testConfig();
    config.agents.harden = { ...config.agents.kd!, identity: "harden" };
    const engine = new OrchestratorEngine(root, config, new ConcurrentRunner(baseCommit));
    await engine.planGoal("Parallel work");
    expect((await engine.run()).status).toBe("completed");
  });

  it("routes unassigned tasks across the configured Herdr coder capacity", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const config = testConfig({ maxWorkers: 2 });
    config.agents.harden = { ...config.agents.kd!, identity: "harden" };
    const engine = new OrchestratorEngine(root, config, new UnassignedPlanRunner(baseCommit));
    const plan = await engine.planGoal("Route work");
    expect(plan.tasks.map((task) => task.assignedAgent)).toEqual(["kd", "harden", "kd"]);
  });

  it("returns test-only review issues to westbrook without rerunning the coder", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new TestReworkRunner(baseCommit);
    const engine = new OrchestratorEngine(root, testConfig(), runner);
    await engine.planGoal("Add a feature");
    expect((await engine.run()).status).toBe("completed");
    expect(runner.coderCount).toBe(1);
    expect(runner.testerCount).toBe(2);
    expect(engine.store.loadPlan().tasks[0]).toMatchObject({ assignedAgent: "kd", reviewAttempts: 1 });
  });

  it("returns production rework to the original coder", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new ProductionReworkRunner(baseCommit);
    const engine = new OrchestratorEngine(root, testConfig(), runner);
    await engine.planGoal("Add a feature");
    expect((await engine.run()).status).toBe("completed");
    expect(runner.coderIdentities).toEqual(["kd", "kd"]);
    expect(engine.store.loadPlan().tasks[0]).toMatchObject({ assignedAgent: "kd", reviewAttempts: 1 });
  });

  it("returns replan-required work to lebang and continues with the updated DAG", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new ReplanRunner(baseCommit);
    const engine = new OrchestratorEngine(root, testConfig(), runner);
    await engine.planGoal("Add a feature");
    expect((await engine.run()).status).toBe("completed");
    const tasks = Object.fromEntries(engine.store.loadPlan().tasks.map((task) => [task.id, task]));
    expect(runner.planCount).toBe(2);
    expect(tasks.T1!.status).toBe("invalidated");
    expect(tasks.T2!.status).toBe("completed");
  });

  it("stops review retries at the configured limit", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const { root, baseCommit } = createRepository(join(parent, "repo"));
    const runner = new TestReworkRunner(baseCommit);
    const engine = new OrchestratorEngine(root, testConfig({ maxReviewAttempts: 1 }), runner);
    await engine.planGoal("Add a feature");
    expect((await engine.run()).status).toBe("blocked");
    expect(engine.store.loadPlan().tasks[0]).toMatchObject({ status: "blocked", reviewAttempts: 1 });
    expect(runner.testerCount).toBe(1);
    expect(runner.roles).not.toContain("integrator");
  });

  it("persists mechanical integration conflicts as failed results", async () => {
    const parent = temporaryDirectory(); roots.push(parent);
    const root = join(parent, "repo");
    const { baseCommit } = createRepository(root);
    writeFileSync(join(root, "value.txt"), "base\n");
    git(root, "add", "value.txt");
    git(root, "commit", "-m", "value base");
    const actualBase = git(root, "rev-parse", "HEAD");
    const config = testConfig();
    config.agents.harden = { ...config.agents.kd!, identity: "harden" };
    const tasks = [
      makeTask({ id: "T1", assignedAgent: "kd" }),
      makeTask({ id: "T2", assignedAgent: "harden" }),
    ];
    const engine = new OrchestratorEngine(root, config, new UnexpectedRunner());
    engine.store.initialize({ goal: "Conflicting work", baseCommit: actualBase, tasks });
    for (const [task, content] of [[tasks[0]!, "one\n"], [tasks[1]!, "two\n"]] as const) {
      const worktree = await engine.git.prepareTaskWorktree(task, tasks, actualBase);
      writeFileSync(join(worktree, "value.txt"), content);
      git(worktree, "add", "value.txt");
      git(worktree, "commit", "-m", task.id);
      task.commit = git(worktree, "rev-parse", "HEAD");
      task.status = "approved";
      engine.store.saveTask(task);
    }
    const result = await engine.integrate();
    expect(baseCommit).toBeTruthy();
    expect(result.status).toBe("failed");
    expect(result.issues[0]!.scope).toBe("integration");
    expect(engine.store.loadState().status).toBe("failed");
  });
});

function promptPayload(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
}
