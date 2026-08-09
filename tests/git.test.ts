import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitManager, isTestSupportPath } from "../src/git.js";
import { createRepository, git, makeTask, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git worktree lifecycle", () => {
  it("distinguishes test support from production paths", () => {
    expect([
      "tests/test_feature.py", "src/example_test.go", "web/button.spec.ts", "fixtures/users.json",
      "src/__tests__/button.ts",
    ].every(isTestSupportPath)).toBe(true);
    expect(isTestSupportPath("src/application.ts")).toBe(false);
  });

  it("ignores only untracked generated cache files in clean checks", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const { root: repo } = createRepository(join(root, "repo"));
    const manager = new GitManager(repo, join(repo, ".worktrees"));
    mkdirSync(join(repo, "__pycache__"));
    writeFileSync(join(repo, "__pycache__", "module.pyc"), "cache");
    expect(await manager.headIsClean(repo)).toBe(true);
    writeFileSync(join(repo, "uncommitted.ts"), "export const value = 1;\n");
    expect(await manager.headIsClean(repo)).toBe(false);
  });

  it("includes dependency commits but reports only local task commits", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const { root: repo, baseCommit } = createRepository(join(root, "repo"));
    const manager = new GitManager(repo, join(repo, ".worktrees"));
    const dependency = makeTask();
    const dependencyPath = await manager.prepareTaskWorktree(dependency, [dependency], baseCommit);
    writeFileSync(join(dependencyPath, "dependency.txt"), "dependency\n");
    git(dependencyPath, "add", "dependency.txt");
    git(dependencyPath, "commit", "-m", "T1");
    dependency.commit = git(dependencyPath, "rev-parse", "HEAD");
    dependency.status = "approved";
    const dependent = makeTask({ id: "T2", dependencies: ["T1"], assignedAgent: "harden" });
    const dependentPath = await manager.prepareTaskWorktree(dependent, [dependency, dependent], baseCommit);
    writeFileSync(join(dependentPath, "dependent.txt"), "dependent\n");
    git(dependentPath, "add", "dependent.txt");
    git(dependentPath, "commit", "-m", "T2");
    dependent.commit = git(dependentPath, "rev-parse", "HEAD");
    expect(await manager.taskCommits(dependent)).toEqual([dependent.commit]);
    expect(git(dependentPath, "rev-parse", `${dependent.commit}^`)).toBe(dependent.baseCommit);
  });

  it("integrates only approved task commits on an isolated branch", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const { root: repo, baseCommit } = createRepository(join(root, "repo"));
    const manager = new GitManager(repo, join(repo, ".worktrees"));
    const task = makeTask();
    const taskPath = await manager.prepareTaskWorktree(task, [task], baseCommit);
    writeFileSync(join(taskPath, "feature.txt"), "done\n");
    git(taskPath, "add", "feature.txt");
    git(taskPath, "commit", "-m", "T1");
    task.commit = git(taskPath, "rev-parse", "HEAD");
    task.status = "approved";
    const integrated = await manager.prepareIntegrationWorktree([task], baseCommit, "run-1", "duncan");
    expect(integrated.commits).toEqual([task.commit]);
    expect(git(integrated.path, "branch", "--show-current")).toBe("orchestrator/run-1/integration");
  });
});
