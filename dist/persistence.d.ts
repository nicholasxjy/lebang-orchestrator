import { Type, type Static } from "typebox";
import { type Plan, type ResultParser, type Task } from "./models.js";
export declare class StoreError extends Error {
    readonly name = "StoreError";
}
export declare function utcNow(): string;
declare const RunStateSchema: Type.TObject<{
    runId: Type.TString;
    status: Type.TUnion<[Type.TLiteral<"planned">, Type.TLiteral<"running">, Type.TLiteral<"replan_required">, Type.TLiteral<"final_validating">, Type.TLiteral<"completed">, Type.TLiteral<"blocked">, Type.TLiteral<"failed">]>;
    goal: Type.TString;
    baseCommit: Type.TString;
    createdAt: Type.TString;
    updatedAt: Type.TString;
    integrationBranch: Type.TUnion<[Type.TString, Type.TNull]>;
    integrationWorktree: Type.TUnion<[Type.TString, Type.TNull]>;
    integratedCommits: Type.TArray<Type.TString>;
    result: Type.TUnion<[Type.TRecord<"^.*$", Type.TUnknown>, Type.TNull]>;
}>;
export type RunState = Static<typeof RunStateSchema>;
export declare class RunStore {
    readonly root: string;
    readonly tasksDir: string;
    readonly runsDir: string;
    readonly logsDir: string;
    readonly historyDir: string;
    readonly locksDir: string;
    constructor(root: string);
    initialize(planValue: Plan): void;
    loadPlan(): Plan;
    saveTask(task: Task): void;
    replacePlan(planValue: Plan, agent: string, reason: string): void;
    loadState(): RunState;
    saveState(stateValue: RunState): void;
    appendHistory(taskId: string, entry: Record<string, unknown>): void;
    latestHistoryReason(taskId: string): string | undefined;
    writeResult(taskId: string, role: string, runId: string, result: Record<string, unknown>): string;
    latestStructuredResult<T>(taskId: string, role: string, parser: ResultParser<T>): T | undefined;
    writeLog(name: string, content: string): string;
    withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T>;
    appendJsonl(path: string, value: Record<string, unknown>): void;
    private readJson;
    private writeJson;
}
export {};
