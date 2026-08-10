import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.js";
import {
  HerdrAdapter,
  HerdrError,
  type HerdrAgentSpec,
} from "../src/herdr.js";
import { parseHerdrResult } from "../src/herdr-runner.js";
import { parseReviewResult } from "../src/models.js";
import type { ProcessResult } from "../src/process.js";

const agent: AgentConfig = {
  identity: "curry",
  role: "reviewer",
  skill: "reviewer",
  model: "openai-codex/example:high",
};

const spec: HerdrAgentSpec = {
  agent,
  cwd: "/repo",
  sessionDir: "/repo/.orchestrator/runs/panes/curry/sessions",
  skillPath: "/package/skills/reviewer/SKILL.md",
  tools: ["read", "grep", "find", "ls", "bash"],
};

function result(stdout = "", exitCode = 0, stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr, timedOut: false, aborted: false };
}

describe("Herdr adapter", () => {
  it("waits for newly created panes to become available shells", async () => {
    const marker = "ORCHESTRATOR_RESULT_RUN1";
    const review = { taskId: "T1", status: "approved", issues: [] };
    let startAttempts = 0;
    const adapter = new HerdrAdapter(
      true,
      "herdr",
      "/repo",
      async (command) => {
        if (command[1] === "agent" && command[2] === "get") {
          return result("", 1, "unknown agent");
        }
        if (command[1] === "tab" && command[2] === "create") {
          return result(JSON.stringify({
            result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p1" } },
          }));
        }
        if (command[1] === "agent" && command[2] === "start") {
          startAttempts += 1;
          if (startAttempts === 1) {
            return result(
              "",
              1,
              JSON.stringify({
                error: {
                  code: "agent_pane_busy",
                  message: `agent target pane ${command[7]} is not an available shell`,
                },
              }),
            );
          }
        }
        if (command[1] === "agent" && command[2] === "read") {
          return result([
            `${marker}_BEGIN`,
            JSON.stringify(review),
            `${marker}_END`,
          ].join("\n"));
        }
        return result(JSON.stringify({ result: {} }));
      },
      { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    );

    const output = await adapter.runAgent(spec, "Review task T1", marker, 1_000);

    expect(parseHerdrResult(output, marker, parseReviewResult)).toEqual(review);
    expect(startAttempts).toBe(2);
  });

  it("reuses a live named agent and transports prompts through Herdr", async () => {
    const invoked: Array<readonly string[]> = [];
    const marker = "ORCHESTRATOR_RESULT_RUN1";
    const review = { taskId: "T1", status: "approved", issues: [] };
    const transcript = [
      `${marker}_BEGIN`,
      JSON.stringify(review),
      `${marker}_END`,
    ].join("\n");
    const adapter = new HerdrAdapter(
      true,
      "herdr",
      "/repo",
      async (command) => {
        invoked.push(command);
        if (command[2] === "get") {
          return result(JSON.stringify({ result: { agent: { pane_id: "w1:p2" } } }));
        }
        if (command[2] === "read") {
          return result(JSON.stringify({ result: { output: transcript } }));
        }
        return result(JSON.stringify({ result: {} }));
      },
      { HERDR_ENV: "1" },
    );
    const output = await adapter.runAgent(spec, "Review task T1", marker, 1_000);
    expect(parseHerdrResult(output, marker, parseReviewResult)).toEqual(review);
    expect(invoked.some((command) => command[2] === "start")).toBe(false);
    const prompt = invoked.find((command) => command[2] === "prompt")!;
    expect(prompt).toContain("--wait");
    expect(prompt.join("\n")).toContain(`${marker}_BEGIN`);
  });

  it("requires a Herdr-managed caller pane", async () => {
    const adapter = new HerdrAdapter(true, "herdr", "/repo", async () => result(), {});
    await expect(adapter.runAgent(spec, "Review", "RESULT", 1_000)).rejects.toThrow(HerdrError);
    await expect(adapter.runAgent(spec, "Review", "RESULT", 1_000)).rejects.toThrow(/Herdr-managed pane/);
  });

});
