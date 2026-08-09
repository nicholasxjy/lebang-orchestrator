import { Type, type Static } from "typebox";
export declare class SchemaError extends Error {
    readonly name = "SchemaError";
}
export declare const TaskTypes: readonly ["implementation", "refactor", "test", "investigation", "documentation", "integration"];
export declare const TaskStatuses: readonly ["pending", "ready", "running", "self_verifying", "testing", "reviewing", "changes_requested", "reworking", "approved", "integrating", "completed", "interrupted", "blocked", "failed", "invalidated"];
export declare const TaskSchema: Type.TObject<{
    id: Type.TString;
    title: Type.TString;
    type: Type.TUnion<[Type.TLiteral<"implementation">, Type.TLiteral<"refactor">, Type.TLiteral<"test">, Type.TLiteral<"investigation">, Type.TLiteral<"documentation">, Type.TLiteral<"integration">]>;
    description: Type.TString;
    acceptanceCriteria: Type.TArray<Type.TString>;
    dependencies: Type.TArray<Type.TString>;
    workerRole: Type.TString;
    assignedAgent: Type.TUnion<[Type.TString, Type.TNull]>;
    risk: Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>;
    status: Type.TUnion<[Type.TLiteral<"pending">, Type.TLiteral<"ready">, Type.TLiteral<"running">, Type.TLiteral<"self_verifying">, Type.TLiteral<"testing">, Type.TLiteral<"reviewing">, Type.TLiteral<"changes_requested">, Type.TLiteral<"reworking">, Type.TLiteral<"approved">, Type.TLiteral<"integrating">, Type.TLiteral<"completed">, Type.TLiteral<"interrupted">, Type.TLiteral<"blocked">, Type.TLiteral<"failed">, Type.TLiteral<"invalidated">]>;
    reviewAttempts: Type.TInteger;
    branch: Type.TUnion<[Type.TString, Type.TNull]>;
    worktree: Type.TUnion<[Type.TString, Type.TNull]>;
    baseCommit: Type.TUnion<[Type.TString, Type.TNull]>;
    commit: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export type Task = Static<typeof TaskSchema>;
export declare const PlanSchema: Type.TObject<{
    goal: Type.TString;
    baseCommit: Type.TString;
    tasks: Type.TArray<Type.TObject<{
        id: Type.TString;
        title: Type.TString;
        type: Type.TUnion<[Type.TLiteral<"implementation">, Type.TLiteral<"refactor">, Type.TLiteral<"test">, Type.TLiteral<"investigation">, Type.TLiteral<"documentation">, Type.TLiteral<"integration">]>;
        description: Type.TString;
        acceptanceCriteria: Type.TArray<Type.TString>;
        dependencies: Type.TArray<Type.TString>;
        workerRole: Type.TString;
        assignedAgent: Type.TUnion<[Type.TString, Type.TNull]>;
        risk: Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>;
        status: Type.TUnion<[Type.TLiteral<"pending">, Type.TLiteral<"ready">, Type.TLiteral<"running">, Type.TLiteral<"self_verifying">, Type.TLiteral<"testing">, Type.TLiteral<"reviewing">, Type.TLiteral<"changes_requested">, Type.TLiteral<"reworking">, Type.TLiteral<"approved">, Type.TLiteral<"integrating">, Type.TLiteral<"completed">, Type.TLiteral<"interrupted">, Type.TLiteral<"blocked">, Type.TLiteral<"failed">, Type.TLiteral<"invalidated">]>;
        reviewAttempts: Type.TInteger;
        branch: Type.TUnion<[Type.TString, Type.TNull]>;
        worktree: Type.TUnion<[Type.TString, Type.TNull]>;
        baseCommit: Type.TUnion<[Type.TString, Type.TNull]>;
        commit: Type.TUnion<[Type.TString, Type.TNull]>;
    }>>;
}>;
export type Plan = Static<typeof PlanSchema>;
export declare const IssueSchema: Type.TObject<{
    severity: Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">, Type.TLiteral<"critical">]>;
    scope: Type.TUnion<[Type.TLiteral<"task">, Type.TLiteral<"plan">, Type.TLiteral<"test">, Type.TLiteral<"integration">]>;
    description: Type.TString;
    expected: Type.TString;
    ownerTaskId: Type.TString;
    reproduction: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
}>;
export type Issue = Static<typeof IssueSchema>;
export declare const ReviewResultSchema: Type.TObject<{
    taskId: Type.TString;
    status: Type.TUnion<[Type.TLiteral<"approved">, Type.TLiteral<"changes_requested">, Type.TLiteral<"replan_required">]>;
    issues: Type.TArray<Type.TObject<{
        severity: Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">, Type.TLiteral<"critical">]>;
        scope: Type.TUnion<[Type.TLiteral<"task">, Type.TLiteral<"plan">, Type.TLiteral<"test">, Type.TLiteral<"integration">]>;
        description: Type.TString;
        expected: Type.TString;
        ownerTaskId: Type.TString;
        reproduction: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    }>>;
}>;
export type ReviewResult = Static<typeof ReviewResultSchema>;
export declare const CoderResultSchema: Type.TObject<{
    taskId: Type.TString;
    status: Type.TUnion<[Type.TLiteral<"completed">, Type.TLiteral<"blocked">, Type.TLiteral<"failed">]>;
    summary: Type.TString;
    changedFiles: Type.TArray<Type.TString>;
    testsAdded: Type.TArray<Type.TString>;
    testsRun: Type.TArray<Type.TString>;
    testResult: Type.TUnion<[Type.TLiteral<"passed">, Type.TLiteral<"failed">, Type.TLiteral<"not_run">]>;
    commit: Type.TUnion<[Type.TString, Type.TNull]>;
    blockers: Type.TArray<Type.TString>;
}>;
export type CoderResult = Static<typeof CoderResultSchema>;
export declare const TestFailureSchema: Type.TObject<{
    description: Type.TString;
    reproduction: Type.TString;
    ownerTaskId: Type.TString;
}>;
export type TestFailure = Static<typeof TestFailureSchema>;
export declare const TestResultSchema: Type.TObject<{
    taskId: Type.TString;
    status: Type.TUnion<[Type.TLiteral<"passed">, Type.TLiteral<"failed">, Type.TLiteral<"blocked">]>;
    testsExecuted: Type.TArray<Type.TString>;
    testsAdded: Type.TArray<Type.TString>;
    failures: Type.TArray<Type.TObject<{
        description: Type.TString;
        reproduction: Type.TString;
        ownerTaskId: Type.TString;
    }>>;
    commit: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export type TestResult = Static<typeof TestResultSchema>;
export declare const ValidationResultSchema: Type.TObject<{
    command: Type.TArray<Type.TString>;
    exitCode: Type.TInteger;
    stdout: Type.TString;
    stderr: Type.TString;
}>;
export type ValidationResult = Static<typeof ValidationResultSchema>;
export declare const RunResultSchema: Type.TObject<{
    status: Type.TUnion<[Type.TLiteral<"completed">, Type.TLiteral<"blocked">, Type.TLiteral<"failed">]>;
    summary: Type.TString;
    integratedCommits: Type.TArray<Type.TString>;
    validations: Type.TArray<Type.TObject<{
        command: Type.TArray<Type.TString>;
        exitCode: Type.TInteger;
        stdout: Type.TString;
        stderr: Type.TString;
    }>>;
    issues: Type.TArray<Type.TObject<{
        severity: Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">, Type.TLiteral<"critical">]>;
        scope: Type.TUnion<[Type.TLiteral<"task">, Type.TLiteral<"plan">, Type.TLiteral<"test">, Type.TLiteral<"integration">]>;
        description: Type.TString;
        expected: Type.TString;
        ownerTaskId: Type.TString;
        reproduction: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    }>>;
}>;
export type RunResult = Static<typeof RunResultSchema>;
export declare const PiRunRecordSchema: Type.TObject<{
    runId: Type.TString;
    taskId: Type.TString;
    agent: Type.TString;
    role: Type.TString;
    model: Type.TString;
    cwd: Type.TString;
    startTime: Type.TString;
    endTime: Type.TString;
    exitCode: Type.TInteger;
    stdout: Type.TString;
    stderr: Type.TString;
    structuredResult: Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>;
    stateTransition: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export type PiRunRecord = Static<typeof PiRunRecordSchema>;
export declare function parseTask(value: unknown): Task;
export declare function parsePlan(value: unknown): Plan;
export declare function parseReviewResult(value: unknown): ReviewResult;
export declare function parseCoderResult(value: unknown): CoderResult;
export declare function parseTestResult(value: unknown): TestResult;
export declare function parseValidationResult(value: unknown): ValidationResult;
export declare function parseRunResult(value: unknown): RunResult;
export type ResultParser<T> = (value: unknown) => T;
