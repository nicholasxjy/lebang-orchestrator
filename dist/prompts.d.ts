import type { CoderResult, Plan, ReviewResult, Task, TestResult, ValidationResult } from "./models.js";
export declare function plannerPrompt(goal: string, baseCommit: string, repoRoot: string): string;
export declare function coderPrompt(goal: string, task: Task, worktree: string, dependencyResults: Record<string, Record<string, unknown>>, reworkIssues: Record<string, unknown>[] | undefined, agentIdentity: string, role: string): string;
export declare function testerPrompt(goal: string, task: Task, coder: CoderResult, diff: string): string;
export declare function reviewerPrompt(task: Task, coder: CoderResult, test: TestResult, diff: string): string;
export declare function integratorPrompt(goal: string, plan: Plan, integratedCommits: string[], validations: ValidationResult[], integrationBranch: string): string;
export declare function replanPrompt(plan: Plan, review: ReviewResult, repoRoot: string): string;
