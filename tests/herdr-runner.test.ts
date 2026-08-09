import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrAdapter } from "../src/herdr.js";
import { HerdrRunner } from "../src/herdr-runner.js";
import { parseReviewResult } from "../src/models.js";
import { RunStore } from "../src/persistence.js";
import type { ProcessResult } from "../src/process.js";
import { temporaryDirectory, testConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function processResult(stdout = "", exitCode = 0): ProcessResult {
  return { exitCode, stdout, stderr: "", timedOut: false, aborted: false };
}

describe("Herdr runner", () => {
  it("runs a role in its named pane and persists the marked result", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const config = testConfig({ herdr: { enabled: true, command: "herdr" } });
    const review = { taskId: "T1", status: "approved", issues: [] };
    let marker = "";
    const adapter = new HerdrAdapter(
      true,
      "herdr",
      root,
      async (command) => {
        if (command[2] === "get") {
          return processResult(JSON.stringify({
            result: { agent: { pane_id: "w1:p2", cwd: root } },
          }));
        }
        if (command[2] === "prompt") {
          marker = command[4]!.match(/ORCHESTRATOR_RESULT_[A-Z0-9]+/)![0];
          return processResult(JSON.stringify({ result: { state: "idle" } }));
        }
        if (command[2] === "read") {
          return processResult([
            `${marker}_BEGIN`,
            JSON.stringify(review),
            `${marker}_END`,
          ].join("\n"));
        }
        throw new Error(`unexpected command: ${command.join(" ")}`);
      },
      { HERDR_ENV: "1" },
    );
    const store = new RunStore(join(root, ".orchestrator"));
    const runner = new HerdrRunner(root, store, config, adapter, 1_000);
    const [value, artifact] = await runner.run({
      agent: config.agents.curry!,
      taskId: "T1",
      cwd: root,
      prompt: "Review T1",
      parser: parseReviewResult,
    });
    expect(value).toEqual(review);
    expect(readFileSync(artifact.logPath, "utf8")).toContain(`${marker}_BEGIN`);
    const recordName = readdirSync(join(store.runsDir, "T1", "reviewer"))[0]!;
    const record = JSON.parse(readFileSync(
      join(store.runsDir, "T1", "reviewer", recordName),
      "utf8",
    ));
    expect(record).toMatchObject({ agent: "curry", model: config.agents.curry!.model, exitCode: 0 });
    expect(record.structuredResult).toEqual(review);
  });

  it("prewarms every fixed role and only maxWorkers coders", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const config = testConfig({
      herdr: { enabled: true, command: "herdr" },
      maxWorkers: 2,
    });
    config.agents.harden = { ...config.agents.kd!, identity: "harden" };
    config.agents.sga = { ...config.agents.kd!, identity: "sga" };
    const adapter = new HerdrAdapter(
      true,
      "herdr",
      root,
      async (command) => processResult(JSON.stringify({
        result: { agent: { pane_id: `w1:${command[3]}`, cwd: root } },
      })),
      { HERDR_ENV: "1" },
    );
    const runner = new HerdrRunner(
      root,
      new RunStore(join(root, ".orchestrator")),
      config,
      adapter,
    );
    const team = await runner.initializeTeam();
    expect(Object.keys(team.agents)).toEqual([
      "lebang", "westbrook", "curry", "duncan", "kd", "harden",
    ]);
  });
});
