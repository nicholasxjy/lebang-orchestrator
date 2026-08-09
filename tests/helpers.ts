import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type OrchestratorConfig } from "../src/config.js";
import type { Task } from "../src/models.js";

export function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "lebang-orchestrator-"));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function createRepository(root = temporaryDirectory()): { root: string; baseCommit: string } {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "README.md"), "base\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  return { root, baseCommit: git(root, "rev-parse", "HEAD") };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "Implement feature",
    type: "implementation",
    description: "Implement it.",
    acceptanceCriteria: ["It works"],
    dependencies: [],
    workerRole: "coder",
    assignedAgent: "kd",
    risk: "medium",
    status: "pending",
    reviewAttempts: 0,
    branch: null,
    worktree: null,
    baseCommit: null,
    commit: null,
    ...overrides,
  };
}

export function testConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const base = parseConfig({
    maxWorkers: 2,
    maxReviewAttempts: 3,
    piCommand: "pi",
    validationCommands: [[process.execPath, "-e", "console.log('ok')"]],
    herdr: { enabled: false, command: "herdr" },
    agents: {
      lebang: { role: "planner", skill: "planner", model: "example/planner" },
      kd: { role: "coder", skill: "coder", model: "example/coder" },
      westbrook: { role: "tester", skill: "tester", model: "example/tester" },
      curry: { role: "reviewer", skill: "reviewer", model: "example/reviewer" },
      duncan: { role: "integrator", skill: "integrator", model: "example/integrator" },
    },
  });
  return { ...base, ...overrides };
}
