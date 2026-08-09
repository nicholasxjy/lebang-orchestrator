import { runProcess } from "./process.js";
export class HerdrError extends Error {
    name = "HerdrError";
}
export class HerdrAdapter {
    enabled;
    command;
    repoRoot;
    execute;
    constructor(enabled, command, repoRoot, execute = runProcess) {
        this.enabled = enabled;
        this.command = command;
        this.repoRoot = repoRoot;
        this.execute = execute;
    }
    async openTask(task) {
        if (!this.enabled)
            return undefined;
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
            const value = JSON.parse(result.stdout);
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new Error("non-object response");
            }
            return value;
        }
        catch (error) {
            throw new HerdrError(`Herdr returned malformed JSON: ${String(error)}`);
        }
    }
}
//# sourceMappingURL=herdr.js.map