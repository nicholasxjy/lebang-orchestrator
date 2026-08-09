import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export class SchemaError extends Error {
  override readonly name = "SchemaError";
}

const NonEmptyString = Type.String({ minLength: 1 });
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const TaskTypes = [
  "implementation",
  "refactor",
  "test",
  "investigation",
  "documentation",
  "integration",
] as const;

export const TaskStatuses = [
  "pending",
  "ready",
  "running",
  "self_verifying",
  "testing",
  "reviewing",
  "changes_requested",
  "reworking",
  "approved",
  "integrating",
  "completed",
  "interrupted",
  "blocked",
  "failed",
  "invalidated",
] as const;

export const TaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  type: Type.Union([
    Type.Literal("implementation"),
    Type.Literal("refactor"),
    Type.Literal("test"),
    Type.Literal("investigation"),
    Type.Literal("documentation"),
    Type.Literal("integration"),
  ]),
  description: Type.String(),
  acceptanceCriteria: Type.Array(NonEmptyString),
  dependencies: Type.Array(NonEmptyString),
  workerRole: Type.String(),
  assignedAgent: NullableString,
  risk: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
  ]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("ready"),
    Type.Literal("running"),
    Type.Literal("self_verifying"),
    Type.Literal("testing"),
    Type.Literal("reviewing"),
    Type.Literal("changes_requested"),
    Type.Literal("reworking"),
    Type.Literal("approved"),
    Type.Literal("integrating"),
    Type.Literal("completed"),
    Type.Literal("interrupted"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
    Type.Literal("invalidated"),
  ]),
  reviewAttempts: Type.Integer({ minimum: 0 }),
  branch: NullableString,
  worktree: NullableString,
  baseCommit: NullableString,
  commit: NullableString,
});

export type Task = Static<typeof TaskSchema>;

export const PlanSchema = Type.Object({
  goal: Type.String(),
  baseCommit: Type.String(),
  tasks: Type.Array(TaskSchema, { minItems: 1 }),
});

export type Plan = Static<typeof PlanSchema>;

export const IssueSchema = Type.Object({
  severity: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
  ]),
  scope: Type.Union([
    Type.Literal("task"),
    Type.Literal("plan"),
    Type.Literal("test"),
    Type.Literal("integration"),
  ]),
  description: Type.String(),
  expected: Type.String(),
  ownerTaskId: Type.String(),
  reproduction: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type Issue = Static<typeof IssueSchema>;

export const ReviewResultSchema = Type.Object({
  taskId: Type.String(),
  status: Type.Union([
    Type.Literal("approved"),
    Type.Literal("changes_requested"),
    Type.Literal("replan_required"),
  ]),
  issues: Type.Array(IssueSchema),
});

export type ReviewResult = Static<typeof ReviewResultSchema>;

export const CoderResultSchema = Type.Object({
  taskId: Type.String(),
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
  ]),
  summary: Type.String(),
  changedFiles: Type.Array(NonEmptyString),
  testsAdded: Type.Array(NonEmptyString),
  testsRun: Type.Array(NonEmptyString),
  testResult: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("not_run"),
  ]),
  commit: NullableString,
  blockers: Type.Array(NonEmptyString),
});

export type CoderResult = Static<typeof CoderResultSchema>;

export const TestFailureSchema = Type.Object({
  description: Type.String(),
  reproduction: Type.String(),
  ownerTaskId: Type.String(),
});

export type TestFailure = Static<typeof TestFailureSchema>;

export const TestResultSchema = Type.Object({
  taskId: Type.String(),
  status: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("blocked"),
  ]),
  testsExecuted: Type.Array(NonEmptyString),
  testsAdded: Type.Array(NonEmptyString),
  failures: Type.Array(TestFailureSchema),
  commit: NullableString,
});

export type TestResult = Static<typeof TestResultSchema>;

export const ValidationResultSchema = Type.Object({
  command: Type.Array(NonEmptyString),
  exitCode: Type.Integer(),
  stdout: Type.String(),
  stderr: Type.String(),
});

export type ValidationResult = Static<typeof ValidationResultSchema>;

export const RunResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
  ]),
  summary: Type.String(),
  integratedCommits: Type.Array(NonEmptyString),
  validations: Type.Array(ValidationResultSchema),
  issues: Type.Array(IssueSchema),
});

export type RunResult = Static<typeof RunResultSchema>;

export const PiRunRecordSchema = Type.Object({
  runId: Type.String(),
  taskId: Type.String(),
  agent: Type.String(),
  role: Type.String(),
  model: Type.String(),
  cwd: Type.String(),
  startTime: Type.String(),
  endTime: Type.String(),
  exitCode: Type.Integer(),
  stdout: Type.String(),
  stderr: Type.String(),
  structuredResult: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  stateTransition: Type.Union([Type.String(), Type.Null()]),
});

export type PiRunRecord = Static<typeof PiRunRecordSchema>;

function parseSchema<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value)[0];
    const detail = first ? `${first.instancePath || "/"} ${first.message}` : "invalid value";
    throw new SchemaError(`${label} failed validation: ${detail}`);
  }
  return structuredClone(value) as T;
}

export function parseTask(value: unknown): Task {
  return parseSchema<Task>(TaskSchema, value, "task");
}

export function parsePlan(value: unknown): Plan {
  const plan = parseSchema<Plan>(PlanSchema, value, "plan");
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  if (byId.size !== plan.tasks.length) {
    throw new SchemaError("task ids must be unique");
  }
  for (const task of plan.tasks) {
    const missing = task.dependencies.filter((dependency) => !byId.has(dependency));
    if (missing.length > 0) {
      throw new SchemaError(
        `task ${task.id} has unknown dependencies: ${missing.join(", ")}`,
      );
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      throw new SchemaError(`dependency cycle includes task ${taskId}`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)!.dependencies) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of byId.keys()) visit(taskId);
  return plan;
}

export function parseReviewResult(value: unknown): ReviewResult {
  const result = parseSchema<ReviewResult>(ReviewResultSchema, value, "review result");
  if (result.status === "approved" && result.issues.length > 0) {
    throw new SchemaError("approved review cannot contain issues");
  }
  if (result.status !== "approved" && result.issues.length === 0) {
    throw new SchemaError(`${result.status} review requires at least one issue`);
  }
  if (
    result.status === "replan_required" &&
    !result.issues.some((issue) => issue.scope === "plan")
  ) {
    throw new SchemaError("replan_required review requires a plan-scoped issue");
  }
  return result;
}

export function parseCoderResult(value: unknown): CoderResult {
  const result = parseSchema<CoderResult>(CoderResultSchema, value, "coder result");
  if (result.status === "completed" && !result.commit) {
    throw new SchemaError("a completed coder result requires a commit");
  }
  if (result.status === "completed" && result.testResult !== "passed") {
    throw new SchemaError("a completed coder result requires passed tests");
  }
  return result;
}

export function parseTestResult(value: unknown): TestResult {
  const result = parseSchema<TestResult>(TestResultSchema, value, "test result");
  if (result.status === "failed" && result.failures.length === 0) {
    throw new SchemaError("a failed test result requires at least one failure");
  }
  if (result.status === "passed" && result.failures.length > 0) {
    throw new SchemaError("a passed test result cannot contain failures");
  }
  return result;
}

export function parseValidationResult(value: unknown): ValidationResult {
  return parseSchema<ValidationResult>(ValidationResultSchema, value, "validation result");
}

export function parseRunResult(value: unknown): RunResult {
  const result = parseSchema<RunResult>(RunResultSchema, value, "run result");
  if (
    result.status === "completed" &&
    result.validations.some((validation) => validation.exitCode !== 0)
  ) {
    throw new SchemaError("completed run contains a failed validation");
  }
  return result;
}

export type ResultParser<T> = (value: unknown) => T;
