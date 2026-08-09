import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { runProcess } from "./process.js";
export class GitError extends Error {
    name = "GitError";
}
const SafeComponent = /^[A-Za-z0-9._-]+$/;
export function isTestSupportPath(path) {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    const parts = normalized.split("/").filter(Boolean);
    const directories = new Set([
        "test", "tests", "testing", "spec", "specs", "__tests__", "fixtures", "fixture",
        "mocks", "mock", "testdata",
    ]);
    if (parts.slice(0, -1).some((part) => directories.has(part)))
        return true;
    const name = parts.at(-1) ?? "";
    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    return name.startsWith("test_") || stem.endsWith("_test") || name.includes(".test.") || name.includes(".spec.");
}
export function isEphemeralPath(path) {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    const parts = normalized.split("/").filter(Boolean);
    const directories = new Set([
        "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".coverage_cache",
    ]);
    if (parts.some((part) => directories.has(part)))
        return true;
    const name = parts.at(-1) ?? "";
    return name === ".coverage" || name === ".ds_store" || name.endsWith(".pyc") || name.endsWith(".pyo");
}
export class GitManager {
    repoRoot;
    worktreesRoot;
    worktreeQueue = Promise.resolve();
    constructor(repoRoot, worktreesRoot) {
        this.repoRoot = resolve(repoRoot);
        this.worktreesRoot = resolve(worktreesRoot);
    }
    currentCommit(cwd = this.repoRoot) {
        return this.git(["rev-parse", "HEAD"], cwd);
    }
    async prepareTaskWorktree(task, allTasks, orchestrationBase) {
        if (task.assignedAgent === null)
            throw new GitError(`task ${task.id} has no assigned agent`);
        this.validateComponent(task.id, "task id");
        this.validateComponent(task.assignedAgent, "agent identity");
        const branch = `agent/${task.assignedAgent}/${task.id}`;
        const path = join(this.worktreesRoot, `${task.id}-${task.assignedAgent}`);
        if (task.worktree !== null) {
            const recorded = resolve(task.worktree);
            if (recorded !== path) {
                throw new GitError(`task ${task.id} records unexpected worktree ${recorded}; expected ${path}`);
            }
            if (isDirectory(path) && task.branch === branch && task.baseCommit) {
                await this.verifyWorktree(path, branch);
                return path;
            }
        }
        await this.withWorktreeLock(async () => {
            mkdirSync(this.worktreesRoot, { recursive: true });
            if (existsSync(path)) {
                throw new GitError(`worktree path already exists but is not recoverable: ${path}`);
            }
            if (await this.branchExists(branch)) {
                await this.git(["worktree", "add", path, branch]);
            }
            else {
                await this.git(["worktree", "add", "-b", branch, path, orchestrationBase]);
            }
        });
        try {
            for (const dependency of this.dependencyOrder(task, allTasks)) {
                if (dependency.status !== "approved" && dependency.status !== "completed") {
                    throw new GitError(`dependency ${dependency.id} is not approved for task ${task.id}`);
                }
                for (const commit of await this.taskCommits(dependency)) {
                    await this.git(["cherry-pick", commit], path);
                }
            }
        }
        catch (error) {
            task.branch = branch;
            task.worktree = path;
            throw error;
        }
        task.branch = branch;
        task.worktree = path;
        task.baseCommit = await this.currentCommit(path);
        return path;
    }
    async taskCommits(task) {
        if (!task.baseCommit || !task.commit) {
            throw new GitError(`task ${task.id} does not record a complete commit range`);
        }
        const ancestor = await runProcess(["git", "merge-base", "--is-ancestor", task.baseCommit, task.commit], this.repoRoot);
        if (ancestor.exitCode !== 0) {
            throw new GitError(`task ${task.id} commit ${task.commit} does not descend from ${task.baseCommit}`);
        }
        return splitLines(await this.git(["rev-list", "--reverse", `${task.baseCommit}..${task.commit}`]));
    }
    async prepareIntegrationWorktree(tasks, orchestrationBase, runId, integrator, alreadyIntegrated = new Set()) {
        this.validateComponent(runId, "run id");
        this.validateComponent(integrator, "integrator identity");
        const invalid = tasks.filter((task) => !["approved", "completed", "integrating"].includes(task.status));
        if (invalid.length > 0) {
            throw new GitError(`integration received tasks that are not approved: ${invalid.map((task) => `${task.id}:${task.status}`).join(", ")}`);
        }
        const branch = `orchestrator/${runId}/integration`;
        const path = join(this.worktreesRoot, `${runId}-${integrator}`);
        await this.withWorktreeLock(async () => {
            mkdirSync(this.worktreesRoot, { recursive: true });
            if (existsSync(path)) {
                await this.verifyWorktree(path, branch);
            }
            else if (await this.branchExists(branch)) {
                await this.git(["worktree", "add", path, branch]);
            }
            else {
                await this.git(["worktree", "add", "-b", branch, path, orchestrationBase]);
            }
        });
        const commits = [];
        for (const task of this.topologicalTasks(tasks)) {
            for (const commit of await this.taskCommits(task)) {
                if (!alreadyIntegrated.has(commit))
                    await this.git(["cherry-pick", commit], path);
                commits.push(commit);
            }
        }
        return { path, commits };
    }
    async changedFiles(task) {
        if (!task.baseCommit || !task.commit) {
            throw new GitError(`task ${task.id} does not record a complete commit range`);
        }
        return splitLines(await this.git(["diff", "--name-only", `${task.baseCommit}..${task.commit}`]));
    }
    async changedFilesBetween(before, after) {
        return splitLines(await this.git(["diff", "--name-only", `${before}..${after}`]));
    }
    async taskDiff(task) {
        if (!task.baseCommit || !task.commit) {
            throw new GitError(`task ${task.id} does not record a complete commit range`);
        }
        return this.git(["diff", "--no-ext-diff", `${task.baseCommit}..${task.commit}`]);
    }
    async headIsClean(cwd) {
        const output = await this.git(["status", "--porcelain=v1", "--untracked-files=all", "-z"], cwd);
        if (!output)
            return true;
        for (const entry of output.split("\0")) {
            if (!entry)
                continue;
            if (entry.length < 4)
                return false;
            if (entry.slice(0, 2) === "??" && isEphemeralPath(entry.slice(3)))
                continue;
            return false;
        }
        return true;
    }
    dependencyOrder(task, allTasks) {
        const byId = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
        const ordered = [];
        const seen = new Set();
        const visit = (taskId) => {
            if (seen.has(taskId))
                return;
            const dependency = byId.get(taskId);
            if (!dependency)
                throw new GitError(`task ${task.id} has unknown dependency ${taskId}`);
            for (const nested of dependency.dependencies)
                visit(nested);
            seen.add(taskId);
            ordered.push(dependency);
        };
        for (const dependency of task.dependencies)
            visit(dependency);
        return ordered;
    }
    topologicalTasks(tasks) {
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const ordered = [];
        const seen = new Set();
        const visiting = new Set();
        const visit = (taskId) => {
            if (seen.has(taskId))
                return;
            if (visiting.has(taskId))
                throw new GitError(`dependency cycle includes task ${taskId}`);
            const current = byId.get(taskId);
            if (!current)
                throw new GitError(`integration is missing dependency task ${taskId}`);
            visiting.add(taskId);
            for (const dependency of current.dependencies)
                visit(dependency);
            visiting.delete(taskId);
            seen.add(taskId);
            ordered.push(current);
        };
        for (const taskId of [...byId.keys()].sort())
            visit(taskId);
        return ordered;
    }
    async verifyWorktree(path, expectedBranch) {
        const actual = await this.git(["branch", "--show-current"], path);
        if (actual !== expectedBranch) {
            throw new GitError(`worktree ${path} uses branch ${actual}, expected ${expectedBranch}`);
        }
    }
    async branchExists(branch) {
        const result = await runProcess(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.repoRoot);
        return result.exitCode === 0;
    }
    validateComponent(value, label) {
        if (!SafeComponent.test(value) || value === "." || value === "..") {
            throw new GitError(`unsafe ${label}: ${value}`);
        }
    }
    async git(args, cwd = this.repoRoot) {
        const result = await runProcess(["git", ...args], cwd);
        if (result.exitCode !== 0) {
            const detail = result.stderr.trim() || result.stdout.trim();
            throw new GitError(`git ${args.join(" ")} failed with ${result.exitCode}: ${detail}`);
        }
        return result.stdout.trim();
    }
    async withWorktreeLock(action) {
        const previous = this.worktreeQueue;
        let release;
        this.worktreeQueue = new Promise((resolveQueue) => { release = resolveQueue; });
        await previous;
        try {
            return await action();
        }
        finally {
            release();
        }
    }
}
function splitLines(value) {
    return value ? value.split(/\r?\n/) : [];
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=git.js.map