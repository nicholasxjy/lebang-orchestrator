import type { Task } from "./models.js";
export declare class GitError extends Error {
    readonly name = "GitError";
}
export declare function isTestSupportPath(path: string): boolean;
export declare function isEphemeralPath(path: string): boolean;
export declare class GitManager {
    readonly repoRoot: string;
    readonly worktreesRoot: string;
    private worktreeQueue;
    constructor(repoRoot: string, worktreesRoot: string);
    currentCommit(cwd?: string): Promise<string>;
    prepareTaskWorktree(task: Task, allTasks: Task[], orchestrationBase: string): Promise<string>;
    taskCommits(task: Task): Promise<string[]>;
    prepareIntegrationWorktree(tasks: Task[], orchestrationBase: string, runId: string, integrator: string, alreadyIntegrated?: Set<string>): Promise<{
        path: string;
        commits: string[];
    }>;
    changedFiles(task: Task): Promise<string[]>;
    changedFilesBetween(before: string, after: string): Promise<string[]>;
    taskDiff(task: Task): Promise<string>;
    headIsClean(cwd: string): Promise<boolean>;
    private dependencyOrder;
    private topologicalTasks;
    private verifyWorktree;
    private branchExists;
    private validateComponent;
    private git;
    private withWorktreeLock;
}
