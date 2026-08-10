import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  agentForRole,
  selectCoder,
  type AgentConfig,
  type OrchestratorConfig,
} from "./config.js";
import { GitError, GitManager, isTestSupportPath } from "./git.js";
import { HerdrAdapter } from "./herdr.js";
import { HerdrRunner } from "./herdr-runner.js";
import {
  SchemaError,
  parseCoderResult,
  parsePlan,
  parseReviewResult,
  parseRunResult,
  parseTestResult,
  type CoderResult,
  type Issue,
  type Plan,
  type ReviewResult,
  type RunResult,
  type Task,
  type TestResult,
  type ValidationResult,
} from "./models.js";
import { RunStore, StoreError, utcNow } from "./persistence.js";
import { runProcess } from "./process.js";
import {
  coderPrompt,
  integratorPrompt,
  plannerPrompt,
  replanPrompt,
  reviewerPrompt,
  testerPrompt,
} from "./prompts.js";
import { AgentRunError, PiRunner, type AgentRunner } from "./runner.js";
import { AllowedTransitions, readyTaskIds, transitionTask } from "./state.js";

export class EngineError extends Error {
  override readonly name = "EngineError";
}

export class OrchestratorEngine {
  readonly repoRoot: string;
  readonly store: RunStore;
  readonly git: GitManager;
  readonly herdr: HerdrAdapter;
  readonly herdrRunner: HerdrRunner | undefined;
  readonly runner: AgentRunner;

  constructor(
    repoRoot: string,
    readonly config: OrchestratorConfig,
    runner?: AgentRunner,
  ) {
    this.repoRoot = resolve(repoRoot);
    this.store = new RunStore(join(this.repoRoot, ".orchestrator"));
    this.git = new GitManager(this.repoRoot, join(this.repoRoot, ".worktrees"));
    this.herdr = new HerdrAdapter(config.herdr.enabled, config.herdr.command, this.repoRoot);
    this.herdrRunner = config.herdr.enabled
      ? new HerdrRunner(this.repoRoot, this.store, config, this.herdr)
      : undefined;
    this.runner = runner ?? this.herdrRunner ?? new PiRunner(this.repoRoot, this.store);
  }

  async planGoal(goal: string): Promise<Plan> {
    if (!goal.trim()) throw new EngineError("goal must not be empty");
    const baseCommit = await this.git.currentCommit();
    const planner = agentForRole(this.config, "planner");
    const [raw] = await this.runner.run({
      agent: planner,
      taskId: "PLAN",
      cwd: this.repoRoot,
      prompt: plannerPrompt(
        goal,
        baseCommit,
        this.repoRoot,
        Object.values(this.config.agents)
          .filter((agent) => agent.role === "coder")
          .map((agent) => agent.identity),
        this.config.maxWorkers,
      ),
      parser: parsePlan,
      stateTransition: "unplanned -> planned",
    });
    const result = parsePlan(raw);
    if (result.baseCommit !== baseCommit) {
      throw new EngineError(`planner returned baseCommit ${result.baseCommit}, expected ${baseCommit}`);
    }
    assignUnownedTasks(this.config, result.tasks);
    for (const task of result.tasks) {
      if (task.workerRole !== "coder") {
        throw new EngineError(
          `planned task ${task.id} uses workerRole ${task.workerRole}; MVP DAG tasks must use coder`,
        );
      }
      if (task.assignedAgent === null) {
        throw new EngineError(`planned task ${task.id} has no available coder`);
      } else if (!this.config.agents[task.assignedAgent]) {
        throw new EngineError(`planned task ${task.id} references unknown agent ${task.assignedAgent}`);
      }
      selectCoder(this.config, task, new Set());
    }
    this.store.initialize(result);
    return result;
  }

  async run(): Promise<RunResult> {
    let state = this.store.loadState();
    const plannerIdentity = agentForRole(this.config, "planner").identity;
    if (state.status === "completed" && state.result !== null) {
      return parseRunResult(state.result);
    }
    state.status = "running";
    this.store.saveState(state);

    for (;;) {
      let plan = this.store.loadPlan();
      const active = plan.tasks.filter((task) => task.status !== "invalidated");
      if (
        active.length > 0 &&
        active.every((task) => task.status === "approved" || task.status === "completed")
      ) {
        return this.integrate();
      }
      for (const taskId of readyTaskIds(plan.tasks)) {
        const task = plan.tasks.find((item) => item.id === taskId)!;
        transitionTask(this.store, task, "ready", plannerIdentity, "all dependencies are approved");
      }
      plan = this.store.loadPlan();
      const ready = plan.tasks.filter((task) => task.status === "ready");
      if (ready.length > 0) {
        const batch: Task[] = [];
        const owners = new Set<string>();
        for (const task of ready.sort((left, right) => left.id.localeCompare(right.id))) {
          if (task.assignedAgent !== null && owners.has(task.assignedAgent)) continue;
          batch.push(task);
          if (task.assignedAgent !== null) owners.add(task.assignedAgent);
          if (batch.length >= this.config.maxWorkers) break;
        }
        await Promise.all(batch.map((task) => this.executeTask(task.id)));
        continue;
      }
      return this.terminalResult(plan);
    }
  }

  private async executeTask(taskId: string): Promise<void> {
    await this.store.withTaskLock(taskId, async () => {
      const plan = this.store.loadPlan();
      const task = OrchestratorEngine.task(plan, taskId);
      if (task.status !== "ready") throw new EngineError(`task ${task.id} is not ready: ${task.status}`);
      if (task.assignedAgent === null) throw new EngineError(`task ${task.id} has no assigned agent`);
      const coder = this.config.agents[task.assignedAgent]!;
      const plannerIdentity = agentForRole(this.config, "planner").identity;
      try {
        const worktree = await this.git.prepareTaskWorktree(task, plan.tasks, plan.baseCommit);
        this.store.saveTask(task);
        transitionTask(this.store, task, "running", coder.identity, "coder execution started");
        const coderResult = await this.runCoder(plan, task, worktree, coder);
        await this.testAndReview(plan, task, worktree, coder, coderResult);
      } catch (error) {
        const current = OrchestratorEngine.task(this.store.loadPlan(), taskId);
        const reason = errorMessage(error);
        if (AllowedTransitions[current.status].has("failed")) {
          transitionTask(
            this.store,
            current,
            "failed",
            current.assignedAgent ?? plannerIdentity,
            reason,
          );
        } else {
          this.store.appendHistory(taskId, {
            event: "execution_error",
            agent: current.assignedAgent ?? plannerIdentity,
            reason,
          });
        }
      }
    });
  }

  private async testAndReview(
    plan: Plan,
    task: Task,
    worktree: string,
    coder: AgentConfig,
    initialCoderResult: CoderResult,
  ): Promise<void> {
    let coderResult = initialCoderResult;
    while (task.status === "testing") {
      const testResult = await this.runTester(plan, task, worktree, coderResult);
      if ((task.status as Task["status"]) !== "reviewing") return;
      const review = await this.runReviewer(task, worktree, coderResult, testResult);
      if (review.status === "approved") {
        transitionTask(
          this.store,
          task,
          "approved",
          agentForRole(this.config, "reviewer").identity,
          "review approved",
        );
        return;
      }
      task.reviewAttempts += 1;
      this.store.saveTask(task);
      if (task.reviewAttempts >= this.config.maxReviewAttempts) {
        transitionTask(
          this.store,
          task,
          "blocked",
          agentForRole(this.config, "planner").identity,
          "review attempt limit reached",
        );
        return;
      }
      if (review.status === "replan_required") {
        await this.handleReplan(plan, review);
        return;
      }
      transitionTask(
        this.store,
        task,
        "changes_requested",
        agentForRole(this.config, "reviewer").identity,
        "review requested task-level changes",
      );
      const testOnly = review.issues.length > 0 && review.issues.every((issue) => issue.scope === "test");
      if (testOnly) {
        const tester = agentForRole(this.config, "tester");
        transitionTask(this.store, task, "reworking", tester.identity, "test-only rework assigned to tester");
        transitionTask(
          this.store,
          task,
          "testing",
          tester.identity,
          "tester rework ready for independent execution",
        );
        continue;
      }
      transitionTask(this.store, task, "reworking", coder.identity, "returned to original coder");
      coderResult = await this.runCoder(
        plan,
        task,
        worktree,
        coder,
        review.issues.map((issue) => ({ ...issue })),
      );
    }
  }

  private async runCoder(
    plan: Plan,
    task: Task,
    worktree: string,
    coder: AgentConfig,
    reworkIssues?: Record<string, unknown>[],
  ): Promise<CoderResult> {
    const dependencies = Object.fromEntries(
      plan.tasks
        .filter((dependency) => task.dependencies.includes(dependency.id))
        .map((dependency) => [
          dependency.id,
          { commit: dependency.commit, status: dependency.status },
        ]),
    );
    const [result] = await this.runner.run({
      agent: coder,
      taskId: task.id,
      cwd: worktree,
      prompt: coderPrompt(
        plan.goal,
        task,
        worktree,
        dependencies,
        reworkIssues,
        coder.identity,
        coder.role,
      ),
      parser: parseCoderResult,
      stateTransition: `${task.status} -> self_verifying`,
    });
    if (result.taskId !== task.id) {
      throw new EngineError(`coder returned taskId ${result.taskId}, expected ${task.id}`);
    }
    if (result.status !== "completed") {
      transitionTask(
        this.store,
        task,
        result.status === "blocked" ? "blocked" : "failed",
        coder.identity,
        result.summary || result.blockers.join("; "),
      );
      return result;
    }
    await this.acceptCoderEvidence(task, worktree, result);
    transitionTask(this.store, task, "self_verifying", coder.identity, "coder result verified");
    transitionTask(this.store, task, "testing", coder.identity, "coder self-verification passed");
    return result;
  }

  private async acceptCoderEvidence(
    task: Task,
    worktree: string,
    result: CoderResult,
  ): Promise<void> {
    if (result.taskId !== task.id) {
      throw new EngineError(`coder returned taskId ${result.taskId}, expected ${task.id}`);
    }
    if (result.status !== "completed") throw new EngineError("coder evidence is not completed");
    const head = await this.git.currentCommit(worktree);
    if (result.commit !== head) {
      throw new EngineError(`coder returned commit ${result.commit}, but worktree HEAD is ${head}`);
    }
    if (!(await this.git.headIsClean(worktree))) {
      throw new EngineError("coder returned with uncommitted worktree changes");
    }
    task.commit = head;
    const changedFiles = await this.git.changedFiles(task);
    if (!sameSet(changedFiles, result.changedFiles)) {
      throw new EngineError("coder changedFiles does not match the committed task diff");
    }
    if ((task.type === "implementation" || task.type === "refactor") && result.testsAdded.length === 0) {
      throw new EngineError("production task completed without direct task-local tests");
    }
    if (!result.testsAdded.every((path) => changedFiles.includes(path))) {
      throw new EngineError("coder testsAdded contains files outside the task diff");
    }
    if (result.testsRun.length === 0) {
      throw new EngineError("coder completed without reporting self-test commands");
    }
    this.store.saveTask(task);
  }

  private async runTester(
    plan: Plan,
    task: Task,
    worktree: string,
    coderResult: CoderResult,
  ): Promise<TestResult> {
    const tester = agentForRole(this.config, "tester");
    const before = task.commit;
    if (before === null) throw new EngineError(`task ${task.id} has no coder commit`);
    const [result] = await this.runner.run({
      agent: tester,
      taskId: task.id,
      cwd: worktree,
      prompt: testerPrompt(plan.goal, task, coderResult, await this.git.taskDiff(task)),
      parser: parseTestResult,
      stateTransition: "testing -> reviewing",
    });
    if (result.taskId !== task.id) {
      throw new EngineError(`tester returned taskId ${result.taskId}, expected ${task.id}`);
    }
    if (result.testsExecuted.length === 0) {
      throw new EngineError("tester returned without independent test commands");
    }
    const after = await this.git.currentCommit(worktree);
    if (result.commit === null) {
      if (after !== before || !(await this.git.headIsClean(worktree))) {
        throw new EngineError("tester changed the worktree without returning a commit");
      }
    } else {
      if (result.commit !== after || !(await this.git.headIsClean(worktree))) {
        throw new EngineError("tester commit does not match a clean worktree HEAD");
      }
      const changedFiles = await this.git.changedFilesBetween(before, after);
      if (!changedFiles.every((path) => result.testsAdded.includes(path))) {
        throw new EngineError("tester commit contains files not declared in testsAdded");
      }
      const productionPaths = changedFiles.filter((path) => !isTestSupportPath(path));
      if (productionPaths.length > 0) {
        throw new EngineError(`tester modified production paths: ${productionPaths.join(", ")}`);
      }
      task.commit = after;
      this.store.saveTask(task);
    }
    if (result.status === "blocked") {
      transitionTask(this.store, task, "blocked", tester.identity, "independent testing blocked");
      return result;
    }
    transitionTask(
      this.store,
      task,
      "reviewing",
      tester.identity,
      `independent testing ${result.status}`,
    );
    return result;
  }

  private async runReviewer(
    task: Task,
    worktree: string,
    coderResult: CoderResult,
    testResult: TestResult,
  ): Promise<ReviewResult> {
    const reviewer = agentForRole(this.config, "reviewer");
    const [result] = await this.runner.run({
      agent: reviewer,
      taskId: task.id,
      cwd: worktree,
      prompt: reviewerPrompt(task, coderResult, testResult, await this.git.taskDiff(task)),
      parser: parseReviewResult,
      stateTransition: `reviewing -> ${task.status}`,
    });
    if (result.taskId !== task.id) {
      throw new EngineError(`reviewer returned taskId ${result.taskId}, expected ${task.id}`);
    }
    return result;
  }

  async resume(): Promise<RunResult> {
    const plan = this.store.loadPlan();
    let state = this.store.loadState();
    const plannerIdentity = agentForRole(this.config, "planner").identity;
    if (
      plan.tasks.some((task) => task.status === "integrating") ||
      state.status === "final_validating"
    ) {
      return this.integrate();
    }
    for (const snapshot of plan.tasks) {
      if ([
        "approved", "completed", "pending", "ready", "invalidated", "blocked", "failed",
      ].includes(snapshot.status)) continue;
      await this.store.withTaskLock(snapshot.id, async () => {
        const currentPlan = this.store.loadPlan();
        const task = OrchestratorEngine.task(currentPlan, snapshot.id);
        const originalStatus = task.status;
        if (AllowedTransitions[task.status].has("interrupted")) {
          transitionTask(
            this.store,
            task,
            "interrupted",
            plannerIdentity,
            `recovering task left in ${originalStatus}`,
          );
        }
        if (!["running", "self_verifying", "testing"].includes(originalStatus)) return;
        const coderResult = this.store.latestStructuredResult(task.id, "coder", parseCoderResult);
        if (!coderResult || task.worktree === null) return;
        try {
          await this.acceptCoderEvidence(task, task.worktree, coderResult);
        } catch (error) {
          if (error instanceof EngineError) return;
          throw error;
        }
        transitionTask(this.store, task, "testing", plannerIdentity, "recovered committed coder result");
        if (task.assignedAgent === null) return;
        await this.testAndReview(
          currentPlan,
          task,
          task.worktree,
          this.config.agents[task.assignedAgent]!,
          coderResult,
        );
      });
    }
    state = this.store.loadState();
    if (state.status !== "completed") {
      state.status = "running";
      state.result = null;
      this.store.saveState(state);
    }
    return this.run();
  }

  async retry(taskId: string): Promise<void> {
    const plan = this.store.loadPlan();
    const task = OrchestratorEngine.task(plan, taskId);
    if (!["failed", "blocked", "interrupted"].includes(task.status)) {
      throw new EngineError(`task ${task.id} cannot be retried from status ${task.status}`);
    }
    if (task.status === "blocked" && task.reviewAttempts >= this.config.maxReviewAttempts) {
      throw new EngineError(`task ${task.id} exhausted review attempts; replan or reassign it`);
    }
    const byId = new Map(plan.tasks.map((candidate) => [candidate.id, candidate]));
    const unsatisfied = task.dependencies.filter(
      (dependency) => !["approved", "completed"].includes(byId.get(dependency)!.status),
    );
    if (unsatisfied.length > 0) {
      throw new EngineError(`task ${task.id} has unsatisfied dependencies: ${unsatisfied.join(", ")}`);
    }
    const state = this.store.loadState();
    state.status = "running";
    state.result = null;
    this.store.saveState(state);
    let coderResult = this.store.latestStructuredResult(task.id, "coder", parseCoderResult);
    if (coderResult && task.worktree !== null) {
      try {
        await this.acceptCoderEvidence(task, task.worktree, coderResult);
      } catch (error) {
        if (error instanceof EngineError) coderResult = undefined;
        else throw error;
      }
    }
    if (coderResult && task.worktree !== null) {
      const tester = agentForRole(this.config, "tester");
      if (task.status === "failed" || task.status === "blocked") {
        transitionTask(
          this.store,
          task,
          "reworking",
          tester.identity,
          "retry recovered committed coder evidence",
        );
      }
      transitionTask(
        this.store,
        task,
        "testing",
        tester.identity,
        "retry resumed independent testing",
      );
      if (task.assignedAgent === null) throw new EngineError(`task ${task.id} has no assigned agent`);
      try {
        await this.testAndReview(
          plan,
          task,
          task.worktree,
          this.config.agents[task.assignedAgent]!,
          coderResult,
        );
      } catch (error) {
        const current = OrchestratorEngine.task(this.store.loadPlan(), task.id);
        if (AllowedTransitions[current.status].has("failed")) {
          transitionTask(this.store, current, "failed", tester.identity, errorMessage(error));
        }
      }
      return;
    }
    transitionTask(
      this.store,
      task,
      "ready",
      task.assignedAgent ?? agentForRole(this.config, "planner").identity,
      "explicit retry requested",
    );
  }

  async reviewTask(taskId: string): Promise<void> {
    const plan = this.store.loadPlan();
    const task = OrchestratorEngine.task(plan, taskId);
    if (task.status !== "reviewing") {
      throw new EngineError(`task ${task.id} cannot be reviewed from status ${task.status}`);
    }
    const coderResult = this.store.latestStructuredResult(task.id, "coder", parseCoderResult);
    if (!coderResult || task.worktree === null) {
      throw new EngineError(`task ${task.id} has no recoverable coder evidence`);
    }
    transitionTask(
      this.store,
      task,
      "interrupted",
      agentForRole(this.config, "planner").identity,
      "explicit review requested",
    );
    transitionTask(
      this.store,
      task,
      "testing",
      agentForRole(this.config, "tester").identity,
      "refresh independent test evidence before review",
    );
    if (task.assignedAgent === null) throw new EngineError(`task ${task.id} has no assigned agent`);
    await this.testAndReview(
      plan,
      task,
      task.worktree,
      this.config.agents[task.assignedAgent]!,
      coderResult,
    );
  }

  async integrate(): Promise<RunResult> {
    let plan = this.store.loadPlan();
    const activeTasks = plan.tasks.filter((task) => task.status !== "invalidated");
    if (
      activeTasks.length === 0 ||
      !activeTasks.every((task) => ["approved", "completed", "integrating"].includes(task.status))
    ) {
      throw new EngineError("integration requires every task to be approved");
    }
    const integrator = agentForRole(this.config, "integrator");
    for (const task of activeTasks) {
      if (task.status === "approved") {
        transitionTask(
          this.store,
          task,
          "integrating",
          integrator.identity,
          "approved task selected for integration",
        );
      }
    }
    const storedPlan = this.store.loadPlan();
    plan = parsePlan({
      goal: storedPlan.goal,
      baseCommit: storedPlan.baseCommit,
      tasks: storedPlan.tasks.filter((task) => task.status !== "invalidated"),
    });
    let state = this.store.loadState();
    let integrationPath: string;
    let commits: string[];
    try {
      ({ path: integrationPath, commits } = await this.git.prepareIntegrationWorktree(
        plan.tasks,
        plan.baseCommit,
        state.runId,
        integrator.identity,
        new Set(state.integratedCommits),
      ));
    } catch (error) {
      if (error instanceof GitError) return this.integrationFailure(plan, integrator.identity, error);
      throw error;
    }
    state.status = "final_validating";
    state.integrationBranch = `orchestrator/${state.runId}/integration`;
    state.integrationWorktree = integrationPath;
    state.integratedCommits = commits;
    this.store.saveState(state);
    const validations: ValidationResult[] = [];
    for (const command of this.config.validationCommands) {
      validations.push(await this.runValidation(command, integrationPath));
    }
    let result: RunResult;
    try {
      [result] = await this.runner.run({
        agent: integrator,
        taskId: "INTEGRATION",
        cwd: integrationPath,
        prompt: integratorPrompt(
          plan.goal,
          plan,
          commits,
          validations,
          state.integrationBranch,
        ),
        parser: parseRunResult,
        stateTransition: "final_validating -> completed",
      });
      if (!isDeepStrictEqual(result.integratedCommits, commits)) {
        throw new EngineError("integrator result does not match integrated commits");
      }
      if (!isDeepStrictEqual(result.validations, validations)) {
        throw new EngineError("integrator result does not match validation evidence");
      }
      if (result.status === "completed" && validations.some((item) => item.exitCode !== 0)) {
        throw new EngineError("integrator reported completion after failed validation");
      }
    } catch (error) {
      return this.integrationFailure(plan, integrator.identity, error, commits, validations);
    }
    state = this.store.loadState();
    state.status = result.status;
    state.result = structuredClone(result) as unknown as Record<string, unknown>;
    this.store.saveState(state);
    if (result.status === "completed") {
      for (const task of this.store.loadPlan().tasks) {
        if (task.status === "integrating") {
          transitionTask(
            this.store,
            task,
            "completed",
            integrator.identity,
            "repository-wide validation passed",
          );
        }
      }
    }
    return result;
  }

  private integrationFailure(
    plan: Plan,
    integratorIdentity: string,
    error: unknown,
    commits: string[] = [],
    validations: ValidationResult[] = [],
  ): RunResult {
    const issue: Issue = {
      severity: "high",
      scope: "integration",
      description: errorMessage(error),
      expected: "approved task commits integrate and repository validation completes",
      ownerTaskId: plan.tasks[0]?.id ?? "INTEGRATION",
      reproduction: "orchestrator integrate",
    };
    const result: RunResult = {
      status: "failed",
      summary: "integration stopped with an explicit failure",
      integratedCommits: commits,
      validations,
      issues: [issue],
    };
    const state = this.store.loadState();
    state.status = "failed";
    state.integrationBranch ??= `orchestrator/${state.runId}/integration`;
    const candidate = join(this.repoRoot, ".worktrees", `${state.runId}-${integratorIdentity}`);
    if (isDirectory(candidate)) state.integrationWorktree = candidate;
    state.result = structuredClone(result) as unknown as Record<string, unknown>;
    this.store.saveState(state);
    this.store.appendJsonl(join(this.store.historyDir, "run.jsonl"), {
      timestamp: utcNow(),
      event: "integration_failed",
      agent: integratorIdentity,
      reason: errorMessage(error),
    });
    return result;
  }

  private async handleReplan(current: Plan, review: ReviewResult): Promise<void> {
    const planner = agentForRole(this.config, "planner");
    const [raw] = await this.runner.run({
      agent: planner,
      taskId: "PLAN",
      cwd: this.repoRoot,
      prompt: replanPrompt(
        current,
        review,
        this.repoRoot,
        Object.values(this.config.agents)
          .filter((agent) => agent.role === "coder")
          .map((agent) => agent.identity),
        this.config.maxWorkers,
      ),
      parser: parsePlan,
      stateTransition: "replan_required -> running",
    });
    const replanned = parsePlan(raw);
    if (replanned.baseCommit !== current.baseCommit) {
      throw new EngineError("replan changed the orchestration baseCommit");
    }
    if (replanned.goal !== current.goal) {
      throw new EngineError("replan changed the original user goal");
    }
    assignUnownedTasks(this.config, replanned.tasks);
    for (const task of replanned.tasks) {
      if (task.workerRole !== "coder") {
        throw new EngineError(`replanned task ${task.id} uses unsupported workerRole ${task.workerRole}`);
      }
      if (task.assignedAgent === null && task.status !== "invalidated") {
        throw new EngineError(`replanned task ${task.id} has no available coder`);
      }
      if (task.assignedAgent !== null) selectCoder(this.config, task, new Set());
    }
    this.store.replacePlan(
      replanned,
      planner.identity,
      review.issues.map((issue) => issue.description).join("; "),
    );
    const state = this.store.loadState();
    state.status = "running";
    state.result = null;
    this.store.saveState(state);
  }

  private async runValidation(command: string[], cwd: string): Promise<ValidationResult> {
    const result = await runProcess(command, cwd);
    return {
      command: [...command],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private terminalResult(plan: Plan): RunResult {
    const blocked = plan.tasks.filter((task) => task.status === "blocked");
    const failed = plan.tasks.filter((task) => task.status === "failed");
    const status = failed.length > 0 ? "failed" : "blocked";
    const affected = failed.length > 0
      ? failed
      : blocked.length > 0
        ? blocked
        : plan.tasks.filter(
            (task) => !["approved", "completed", "invalidated"].includes(task.status),
          );
    const issues: Issue[] = affected.map((task) => ({
      severity: "high",
      scope: "task",
      description: `task ${task.id} stopped in ${task.status}`,
      expected: "task reaches approved state",
      ownerTaskId: task.id,
    }));
    const result: RunResult = {
      status,
      summary: "orchestration cannot make further progress",
      integratedCommits: [],
      validations: [],
      issues,
    };
    const state = this.store.loadState();
    state.status = status;
    state.result = structuredClone(result) as unknown as Record<string, unknown>;
    this.store.saveState(state);
    return result;
  }

  static task(plan: Plan, taskId: string): Task {
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new SchemaError(`unknown task: ${taskId}`);
    return task;
  }
}

function sameSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}

function assignUnownedTasks(config: OrchestratorConfig, tasks: Task[]): void {
  const coders = Object.values(config.agents)
    .filter((agent) => agent.role === "coder")
    .sort((left, right) => {
      if (left.identity === "kd") return -1;
      if (right.identity === "kd") return 1;
      return left.identity.localeCompare(right.identity);
    })
    .slice(0, config.maxWorkers);
  let index = 0;
  for (const task of tasks) {
    if (task.assignedAgent !== null || task.status === "invalidated") continue;
    task.assignedAgent = coders[index % coders.length]?.identity ?? null;
    index += 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const ExpectedEngineErrors = [
  AgentRunError,
  EngineError,
  GitError,
  SchemaError,
  StoreError,
] as const;
