import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Task } from "./models.js";
import { runProcess } from "./process.js";

export class GitError extends Error {
  override readonly name = "GitError";
}

const SafeComponent = /^[A-Za-z0-9._-]+$/;

export function isTestSupportPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const directories = new Set([
    "test", "tests", "testing", "spec", "specs", "__tests__", "fixtures", "fixture",
    "mocks", "mock", "testdata",
  ]);
  if (parts.slice(0, -1).some((part) => directories.has(part))) return true;
  const name = parts.at(-1) ?? "";
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return name.startsWith("test_") || stem.endsWith("_test") || name.includes(".test.") || name.includes(".spec.");
}

export function isEphemeralPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const directories = new Set([
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".coverage_cache",
  ]);
  if (parts.some((part) => directories.has(part))) return true;
  const name = parts.at(-1) ?? "";
  return name === ".coverage" || name === ".ds_store" || name.endsWith(".pyc") || name.endsWith(".pyo");
}

export class GitManager {
  readonly repoRoot: string;
  readonly worktreesRoot: string;
  private worktreeQueue: Promise<void> = Promise.resolve();

  constructor(repoRoot: string, worktreesRoot: string) {
    this.repoRoot = resolve(repoRoot);
    this.worktreesRoot = resolve(worktreesRoot);
  }

  currentCommit(cwd = this.repoRoot): Promise<string> {
    return this.git(["rev-parse", "HEAD"], cwd);
  }

  async prepareTaskWorktree(
    task: Task,
    allTasks: Task[],
    orchestrationBase: string,
  ): Promise<string> {
    if (task.assignedAgent === null) throw new GitError(`task ${task.id} has no assigned agent`);
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
      } else {
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
    } catch (error) {
      task.branch = branch;
      task.worktree = path;
      throw error;
    }
    task.branch = branch;
    task.worktree = path;
    task.baseCommit = await this.currentCommit(path);
    return path;
  }

  async taskCommits(task: Task): Promise<string[]> {
    if (!task.baseCommit || !task.commit) {
      throw new GitError(`task ${task.id} does not record a complete commit range`);
    }
    const ancestor = await runProcess(
      ["git", "merge-base", "--is-ancestor", task.baseCommit, task.commit],
      this.repoRoot,
    );
    if (ancestor.exitCode !== 0) {
      throw new GitError(`task ${task.id} commit ${task.commit} does not descend from ${task.baseCommit}`);
    }
    return splitLines(await this.git(["rev-list", "--reverse", `${task.baseCommit}..${task.commit}`]));
  }

  async prepareIntegrationWorktree(
    tasks: Task[],
    orchestrationBase: string,
    runId: string,
    integrator: string,
    alreadyIntegrated: Set<string> = new Set(),
  ): Promise<{ path: string; commits: string[] }> {
    this.validateComponent(runId, "run id");
    this.validateComponent(integrator, "integrator identity");
    const invalid = tasks.filter(
      (task) => !["approved", "completed", "integrating"].includes(task.status),
    );
    if (invalid.length > 0) {
      throw new GitError(
        `integration received tasks that are not approved: ${invalid.map((task) => `${task.id}:${task.status}`).join(", ")}`,
      );
    }
    const branch = `orchestrator/${runId}/integration`;
    const path = join(this.worktreesRoot, `${runId}-${integrator}`);
    await this.withWorktreeLock(async () => {
      mkdirSync(this.worktreesRoot, { recursive: true });
      if (existsSync(path)) {
        await this.verifyWorktree(path, branch);
      } else if (await this.branchExists(branch)) {
        await this.git(["worktree", "add", path, branch]);
      } else {
        await this.git(["worktree", "add", "-b", branch, path, orchestrationBase]);
      }
    });
    const commits: string[] = [];
    for (const task of this.topologicalTasks(tasks)) {
      for (const commit of await this.taskCommits(task)) {
        if (!alreadyIntegrated.has(commit)) await this.git(["cherry-pick", commit], path);
        commits.push(commit);
      }
    }
    return { path, commits };
  }

  async changedFiles(task: Task): Promise<string[]> {
    if (!task.baseCommit || !task.commit) {
      throw new GitError(`task ${task.id} does not record a complete commit range`);
    }
    return splitLines(await this.git(["diff", "--name-only", `${task.baseCommit}..${task.commit}`]));
  }

  async changedFilesBetween(before: string, after: string): Promise<string[]> {
    return splitLines(await this.git(["diff", "--name-only", `${before}..${after}`]));
  }

  async taskDiff(task: Task): Promise<string> {
    if (!task.baseCommit || !task.commit) {
      throw new GitError(`task ${task.id} does not record a complete commit range`);
    }
    return this.git(["diff", "--no-ext-diff", `${task.baseCommit}..${task.commit}`]);
  }

  async headIsClean(cwd: string): Promise<boolean> {
    const output = await this.git(["status", "--porcelain=v1", "--untracked-files=all", "-z"], cwd);
    if (!output) return true;
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      if (entry.length < 4) return false;
      if (entry.slice(0, 2) === "??" && isEphemeralPath(entry.slice(3))) continue;
      return false;
    }
    return true;
  }

  private dependencyOrder(task: Task, allTasks: Task[]): Task[] {
    const byId = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
    const ordered: Task[] = [];
    const seen = new Set<string>();
    const visit = (taskId: string): void => {
      if (seen.has(taskId)) return;
      const dependency = byId.get(taskId);
      if (!dependency) throw new GitError(`task ${task.id} has unknown dependency ${taskId}`);
      for (const nested of dependency.dependencies) visit(nested);
      seen.add(taskId);
      ordered.push(dependency);
    };
    for (const dependency of task.dependencies) visit(dependency);
    return ordered;
  }

  private topologicalTasks(tasks: Task[]): Task[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const ordered: Task[] = [];
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (taskId: string): void => {
      if (seen.has(taskId)) return;
      if (visiting.has(taskId)) throw new GitError(`dependency cycle includes task ${taskId}`);
      const current = byId.get(taskId);
      if (!current) throw new GitError(`integration is missing dependency task ${taskId}`);
      visiting.add(taskId);
      for (const dependency of current.dependencies) visit(dependency);
      visiting.delete(taskId);
      seen.add(taskId);
      ordered.push(current);
    };
    for (const taskId of [...byId.keys()].sort()) visit(taskId);
    return ordered;
  }

  private async verifyWorktree(path: string, expectedBranch: string): Promise<void> {
    const actual = await this.git(["branch", "--show-current"], path);
    if (actual !== expectedBranch) {
      throw new GitError(`worktree ${path} uses branch ${actual}, expected ${expectedBranch}`);
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    const result = await runProcess(
      ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      this.repoRoot,
    );
    return result.exitCode === 0;
  }

  private validateComponent(value: string, label: string): void {
    if (!SafeComponent.test(value) || value === "." || value === "..") {
      throw new GitError(`unsafe ${label}: ${value}`);
    }
  }

  private async git(args: string[], cwd = this.repoRoot): Promise<string> {
    const result = await runProcess(["git", ...args], cwd);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new GitError(`git ${args.join(" ")} failed with ${result.exitCode}: ${detail}`);
    }
    return result.stdout.trim();
  }

  private async withWorktreeLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.worktreeQueue;
    let release!: () => void;
    this.worktreeQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function splitLines(value: string): string[] {
  return value ? value.split(/\r?\n/) : [];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
