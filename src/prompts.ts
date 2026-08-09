import type {
  CoderResult,
  Plan,
  ReviewResult,
  Task,
  TestResult,
  ValidationResult,
} from "./models.js";

function context(title: string, value: Record<string, unknown>): string {
  return `${title}\n${JSON.stringify(value, null, 2)}`;
}

export function plannerPrompt(goal: string, baseCommit: string, repoRoot: string): string {
  const taskShape = {
    id: "T1",
    title: "...",
    type: "implementation | refactor | test | investigation | documentation | integration",
    description: "...",
    acceptanceCriteria: ["observable criterion"],
    dependencies: [],
    workerRole: "coder",
    assignedAgent: "configured coder identity or null",
    risk: "low | medium | high",
    status: "pending",
    reviewAttempts: 0,
    branch: null,
    worktree: null,
    baseCommit: null,
    commit: null,
  };
  return context("Inspect the repository and return exactly one Plan JSON object. Do not implement. Context:", {
    goal,
    repository: repoRoot,
    baseCommit,
    requirements: [
      "Create a valid acyclic task DAG.",
      "Use coder-owned tasks; tester, reviewer, and integrator are lifecycle gates.",
      "Give every task observable acceptance criteria and preserve the supplied baseCommit.",
    ],
    outputShape: { goal, baseCommit, tasks: [taskShape] },
  });
}

export function coderPrompt(
  goal: string,
  task: Task,
  worktree: string,
  dependencyResults: Record<string, Record<string, unknown>>,
  reworkIssues: Record<string, unknown>[] | undefined,
  agentIdentity: string,
  role: string,
): string {
  return context("Work only on this task and return exactly one CoderResult JSON object. Context:", {
    goalSummary: goal,
    agentIdentity,
    role,
    task,
    worktree,
    branch: task.branch,
    dependencyResults,
    reworkIssues: reworkIssues ?? [],
    resultContract: {
      taskId: task.id,
      status: "completed | blocked | failed",
      summary: "...",
      changedFiles: [],
      testsAdded: [],
      testsRun: [],
      testResult: "passed | failed | not_run",
      commit: "commit hash or null",
      blockers: [],
    },
  });
}

export function testerPrompt(goal: string, task: Task, coder: CoderResult, diff: string): string {
  return context("Independently test this task and return exactly one TestResult JSON object. Context:", {
    goalSummary: goal,
    task,
    coderResult: coder,
    gitDiff: diff,
    issueRouting: [
      "Use task scope for production defects and missing direct unit tests; these return to the original coder.",
      "Use test scope only for missing regression, edge, or integration coverage; these return to the tester.",
      "Use plan scope for decomposition, architecture, or cross-task defects; these return to the planner.",
    ],
    resultContract: {
      taskId: task.id,
      status: "passed | failed | blocked",
      testsExecuted: [],
      testsAdded: [],
      failures: [{ description: "...", reproduction: "...", ownerTaskId: task.id }],
      commit: "tester commit or null",
    },
  });
}

export function reviewerPrompt(
  task: Task,
  coder: CoderResult,
  test: TestResult,
  diff: string,
): string {
  return context("Review this task and return exactly one ReviewResult JSON object. Context:", {
    task,
    coderResult: coder,
    testResult: test,
    gitDiff: diff,
    resultContract: {
      taskId: task.id,
      status: "approved | changes_requested | replan_required",
      issues: [{
        severity: "low | medium | high | critical",
        scope: "task | plan | test | integration",
        description: "...",
        expected: "...",
        ownerTaskId: task.id,
      }],
    },
  });
}

export function integratorPrompt(
  goal: string,
  plan: Plan,
  integratedCommits: string[],
  validations: ValidationResult[],
  integrationBranch: string,
): string {
  return context("Confirm the integrated goal and return exactly one RunResult JSON object. Context:", {
    goal,
    approvedTasks: plan.tasks,
    integratedCommits,
    integrationBranch,
    validationEvidence: validations,
    resultContract: {
      status: "completed | blocked | failed",
      summary: "...",
      integratedCommits,
      validations,
      issues: [],
    },
  });
}

export function replanPrompt(plan: Plan, review: ReviewResult, repoRoot: string): string {
  return context("Replan the DAG and return exactly one complete Plan JSON object. Do not implement. Context:", {
    repository: repoRoot,
    currentPlan: plan,
    reviewResult: review,
    rules: [
      "Preserve approved or completed task evidence unchanged.",
      "Mark superseded tasks invalidated and include replacement tasks explicitly.",
      "Keep the original baseCommit and return an acyclic DAG.",
      "Record ownership changes only when intentional.",
    ],
  });
}
