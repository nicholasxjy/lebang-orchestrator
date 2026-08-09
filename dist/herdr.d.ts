import type { Task } from "./models.js";
import type { ProcessOptions, ProcessResult } from "./process.js";
export declare class HerdrError extends Error {
    readonly name = "HerdrError";
}
export declare class HerdrAdapter {
    readonly enabled: boolean;
    readonly command: string;
    readonly repoRoot: string;
    readonly execute: (command: readonly string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>;
    constructor(enabled: boolean, command: string, repoRoot: string, execute?: (command: readonly string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>);
    openTask(task: Task): Promise<Record<string, unknown> | undefined>;
}
