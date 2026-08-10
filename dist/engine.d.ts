import { type OrchestratorConfig } from "./config.js";
import { GitError, GitManager } from "./git.js";
import { HerdrAdapter } from "./herdr.js";
import { HerdrRunner } from "./herdr-runner.js";
import { SchemaError, type Plan, type RunResult, type Task } from "./models.js";
import { RunStore, StoreError } from "./persistence.js";
import { AgentRunError, type AgentRunner } from "./runner.js";
export declare class EngineError extends Error {
    readonly name = "EngineError";
}
export declare class OrchestratorEngine {
    readonly config: OrchestratorConfig;
    readonly repoRoot: string;
    readonly store: RunStore;
    readonly git: GitManager;
    readonly herdr: HerdrAdapter;
    readonly herdrRunner: HerdrRunner | undefined;
    readonly runner: AgentRunner;
    constructor(repoRoot: string, config: OrchestratorConfig, runner?: AgentRunner);
    planGoal(goal: string): Promise<Plan>;
    run(): Promise<RunResult>;
    private executeTask;
    private testAndReview;
    private runCoder;
    private acceptCoderEvidence;
    private runTester;
    private runReviewer;
    resume(): Promise<RunResult>;
    retry(taskId: string): Promise<void>;
    reviewTask(taskId: string): Promise<void>;
    integrate(): Promise<RunResult>;
    private integrationFailure;
    private handleReplan;
    private runValidation;
    private terminalResult;
    static task(plan: Plan, taskId: string): Task;
}
export declare const ExpectedEngineErrors: readonly [typeof AgentRunError, typeof EngineError, typeof GitError, typeof SchemaError, typeof StoreError];
