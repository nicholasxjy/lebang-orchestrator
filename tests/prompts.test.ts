import { describe, expect, it } from "vitest";
import { coderPrompt, integratorPrompt } from "../src/prompts.js";
import { makeTask } from "./helpers.js";

function payload(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
}

describe("prompt contracts", () => {
  it("names the coder identity and role", () => {
    const task = makeTask({ status: "running", worktree: "/repo/.worktrees/T1-kd" });
    const value = payload(coderPrompt("Goal", task, task.worktree!, {}, undefined, "kd", "coder"));
    expect(value.agentIdentity).toBe("kd");
    expect(value.role).toBe("coder");
  });

  it("names the integration branch", () => {
    const task = makeTask({ status: "integrating" });
    const value = payload(integratorPrompt(
      "Goal",
      { goal: "Goal", baseCommit: "base", tasks: [task] },
      ["commit"],
      [{ command: ["npm", "test"], exitCode: 0, stdout: "", stderr: "" }],
      "orchestrator/run/integration",
    ));
    expect(value.integrationBranch).toBe("orchestrator/run/integration");
  });
});
