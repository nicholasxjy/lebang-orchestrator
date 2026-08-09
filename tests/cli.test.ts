import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeCommand, type CommandIo } from "../src/commands.js";
import orchestratorExtension, { splitCommandLine } from "../src/extension.js";
import { RunStore } from "../src/persistence.js";
import { makeTask, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function capture(): { io: CommandIo; stdout(): string; stderr(): string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(value) { stdout += value; },
      stderr(value) { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("command service", () => {
  it("summarizes persisted task states", async () => {
    const repo = temporaryDirectory(); roots.push(repo);
    new RunStore(join(repo, ".orchestrator")).initialize({
      goal: "Show status",
      baseCommit: "abc123",
      tasks: [
        makeTask({
          id: "T1",
          status: "running",
          reviewAttempts: 1,
          branch: "agent/kd/T1",
          worktree: "/tmp/T1-kd",
          baseCommit: "abc123",
        }),
        makeTask({ id: "T2", assignedAgent: "harden", dependencies: ["T1"] }),
      ],
    });
    const output = capture();
    expect(await executeCommand(["--repo", repo, "status"], { io: output.io })).toBe(0);
    expect(output.stdout()).toContain("T1");
    expect(output.stdout()).toContain("running=1");
    expect(output.stdout()).toContain("pending=1");
  });

  it("shows the latest blocker reason", async () => {
    const repo = temporaryDirectory(); roots.push(repo);
    const store = new RunStore(join(repo, ".orchestrator"));
    store.initialize({
      goal: "Show blocker",
      baseCommit: "abc123",
      tasks: [makeTask({ status: "blocked", reviewAttempts: 3 })],
    });
    store.appendHistory("T1", {
      event: "state_transition",
      fromStatus: "reviewing",
      toStatus: "blocked",
      agent: "lebang",
      reason: "review attempt limit reached",
    });
    const output = capture();
    await executeCommand(["--repo", repo, "status"], { io: output.io });
    expect(output.stdout()).toContain("BLOCKER");
    expect(output.stdout()).toContain("review attempt limit reached");
  });

  it("produces equivalent output through CLI and /orchestrator without triggering a turn", async () => {
    const repo = temporaryDirectory(); roots.push(repo);
    new RunStore(join(repo, ".orchestrator")).initialize({
      goal: "Contract",
      baseCommit: "abc123",
      tasks: [makeTask()],
    });
    const direct = capture();
    await executeCommand(["status"], { defaultRepo: repo, io: direct.io });

    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    let message: { content: unknown; details?: unknown } | undefined;
    let sendOptions: unknown;
    const pi = {
      registerCommand(name: string, options: { handler: typeof handler }) {
        expect(name).toBe("orchestrator");
        handler = options.handler;
      },
      sendMessage(value: { content: unknown; details?: unknown }, options: unknown) {
        message = value;
        sendOptions = options;
      },
    } as unknown as ExtensionAPI;
    orchestratorExtension(pi);
    await handler!("status", { cwd: repo } as ExtensionCommandContext);
    expect(message!.content).toBe(direct.stdout().trimEnd());
    expect(message!.details).toEqual({ exitCode: 0 });
    expect(sendOptions).toEqual({ triggerTurn: false, deliverAs: "followUp" });
  });

  it("parses quoted extension arguments", () => {
    expect(splitCommandLine('plan "goal with spaces" --repo "/tmp/my repo"')).toEqual([
      "plan", "goal with spaces", "--repo", "/tmp/my repo",
    ]);
  });
});
