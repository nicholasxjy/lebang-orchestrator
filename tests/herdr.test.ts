import { describe, expect, it } from "vitest";
import { HerdrAdapter } from "../src/herdr.js";
import type { ProcessResult } from "../src/process.js";
import { makeTask } from "./helpers.js";

describe("Herdr adapter", () => {
  it("opens an existing worktree without focusing it", async () => {
    let invoked: readonly string[] = [];
    const result: ProcessResult = {
      exitCode: 0,
      stdout: JSON.stringify({ id: "cli:worktree:open", result: { workspace_id: "w1" } }),
      stderr: "",
      timedOut: false,
      aborted: false,
    };
    const adapter = new HerdrAdapter(true, "herdr", "/repo", async (command) => {
      invoked = command;
      return result;
    });
    const metadata = await adapter.openTask(makeTask({
      status: "running",
      branch: "agent/kd/T1",
      worktree: "/tmp/T1-kd",
      baseCommit: "abc123",
    }));
    expect(invoked.slice(0, 3)).toEqual(["herdr", "worktree", "open"]);
    expect(invoked).toContain("--no-focus");
    expect(invoked).toContain("T1-kd");
    expect((metadata!.result as Record<string, unknown>).workspace_id).toBe("w1");
  });
});
