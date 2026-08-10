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

const coderSpec: HerdrAgentSpec = {
  agent: { identity: "kd", role: "coder", skill: "coder", model: "example/coder" },
  cwd: "/repo",
  sessionDir: "/repo/.orchestrator/runs/panes/kd/sessions",
  skillPath: "/package/skills/coder/SKILL.md",
  tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

function result(stdout = "", exitCode = 0, stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr, timedOut: false, aborted: false };
}

describe("Herdr adapter", () => {
  it("creates a balanced team tab and starts configured Pi agents", async () => {
    const invoked: Array<readonly string[]> = [];
    const adapter = new HerdrAdapter(
      true,
      "herdr",
      "/repo",
      async (command) => {
        invoked.push(command);
        if (command[1] === "agent" && command[2] === "get") return result("", 1, "unknown agent");
        if (command[1] === "tab" && command[2] === "create") {
          return result(JSON.stringify({
            result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p1" } },
          }));
        }
        if (command[1] === "pane" && command[2] === "layout") {
          return result(JSON.stringify({
            result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 40 } }] } },
          }));
        }
        if (command[1] === "pane" && command[2] === "split") {
          return result(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
        }
        return result(JSON.stringify({ result: {} }));
      },
      { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    );
    const team = await adapter.initialize([spec, coderSpec]);
    expect(team.tabId).toBe("w1:t2");
    expect(team.agents.curry).toEqual({ paneId: "w1:p1", reused: false });
    expect(team.agents.kd).toEqual({ paneId: "w1:p2", reused: false });
    expect(invoked[2]).toEqual(expect.arrayContaining([
      "herdr", "tab", "create", "--workspace", "w1", "--cwd", "/repo", "--no-focus",
    ]));
    expect(invoked[4]).toEqual(expect.arrayContaining([
      "herdr", "pane", "split", "w1:p1", "--direction", "right", "--no-focus",
    ]));
    expect(invoked[5]).toEqual(expect.arrayContaining([
      "herdr", "agent", "start", "curry", "--kind", "pi", "--pane", "w1:p1",
      "--mode", "text", "--model", agent.model, "--skill", spec.skillPath,
      "--tools", spec.tools.join(","),
    ]));
    expect(invoked.some((command) => command[2] === "prompt")).toBe(false);
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
    await expect(adapter.initialize([spec])).rejects.toThrow(HerdrError);
    await expect(adapter.initialize([spec])).rejects.toThrow(/Herdr-managed pane/);
  });

});
