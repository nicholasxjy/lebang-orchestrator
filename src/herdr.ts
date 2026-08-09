import type { Task } from "./models.js";
import { runProcess } from "./process.js";
import type { ProcessOptions, ProcessResult } from "./process.js";

export class HerdrError extends Error {
  override readonly name = "HerdrError";
}

export class HerdrAdapter {
  constructor(
    readonly enabled: boolean,
    readonly command: string,
    readonly repoRoot: string,
    readonly execute: (
      command: readonly string[],
      cwd: string,
      options?: ProcessOptions,
    ) => Promise<ProcessResult> = runProcess,
  ) {}

  async openTask(task: Task): Promise<Record<string, unknown> | undefined> {
    if (!this.enabled) return undefined;
    if (!task.worktree || !task.branch || !task.assignedAgent) {
      throw new HerdrError(`task ${task.id} has no complete worktree metadata`);
    }
    const command = [
      this.command,
      "worktree",
      "open",
      "--cwd",
      this.repoRoot,
      "--path",
      task.worktree,
      "--branch",
      task.branch,
      "--label",
      `${task.id}-${task.assignedAgent}`,
      "--no-focus",
    ];
    const result = await this.execute(command, this.repoRoot, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new HerdrError(`Herdr worktree open failed with ${result.exitCode}: ${detail}`);
    }
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("non-object response");
      }
      return value as Record<string, unknown>;
    } catch (error) {
      throw new HerdrError(`Herdr returned malformed JSON: ${String(error)}`);
    }
  }
}
