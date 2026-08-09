import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeCommand, type CommandIo } from "../src/commands.js";
import orchestratorExtension, {
  classifyOutcome,
  splitCommandLine,
  taskProgress,
} from "../src/extension.js";
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
    const statuses: Array<string | undefined> = [];
    const widgets: Array<string[] | undefined> = [];
    const notifications: Array<{ message: string; type: string | undefined }> = [];
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
    const context = {
      cwd: repo,
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus(_key: string, value: string | undefined) { statuses.push(value); },
        setWidget(_key: string, value: string[] | undefined) { widgets.push(value); },
        notify(value: string, type?: string) { notifications.push({ message: value, type }); },
      },
    } as unknown as ExtensionCommandContext;
    await handler!("status", context);
    expect(message!.content).toBe(direct.stdout().trimEnd());
    expect(message!.details).toEqual({ exitCode: 0 });
    expect(sendOptions).toEqual({ triggerTurn: false, deliverAs: "followUp" });
    expect(statuses[0]).toContain("Orchestrator · Loading status");
    expect(statuses.at(-1)).toBeUndefined();
    expect(widgets[0]?.[0]).toContain("Orchestrator · Loading status");
    expect(widgets.at(-1)).toBeUndefined();
    expect(notifications).toEqual([
      { message: expect.stringContaining("✓ Orchestrator · Status loaded"), type: "info" },
    ]);

    statuses.length = 0;
    widgets.length = 0;
    notifications.length = 0;
    await handler!(`status --repo "${join(repo, "missing")}"`, context);
    expect(statuses[0]).toContain("Orchestrator · Loading status");
    expect(statuses.at(-1)).toBeUndefined();
    expect(widgets.at(-1)).toBeUndefined();
    expect(message!.details).toEqual({ exitCode: 2 });
    expect(notifications).toEqual([
      { message: expect.stringContaining("✗ Orchestrator · Status failed"), type: "error" },
    ]);
  });

  it("summarizes real persisted task progress", () => {
    const repo = temporaryDirectory(); roots.push(repo);
    new RunStore(join(repo, ".orchestrator")).initialize({
      goal: "Progress",
      baseCommit: "abc123",
      tasks: [
        makeTask({ id: "T1", status: "approved" }),
        makeTask({ id: "T2", status: "testing", assignedAgent: "harden" }),
      ],
    });
    expect(taskProgress(repo)).toBe("[█████░░░░░] 1/2 tasks · T2 testing");
  });

  it("distinguishes successful, blocked, and failed lifecycle outcomes", () => {
    expect(classifyOutcome(0, "run", '{"status":"completed"}', "")).toMatchObject({
      symbol: "✓", notification: "info",
    });
    expect(classifyOutcome(0, "run", '{"status":"blocked"}', "")).toMatchObject({
      symbol: "!", notification: "warning", message: "Run blocked",
    });
    expect(classifyOutcome(2, "plan", "", "orchestrator: bad config\n")).toMatchObject({
      symbol: "✗", notification: "error", message: "Plan failed — bad config",
    });
  });

  it("parses quoted extension arguments", () => {
    expect(splitCommandLine('plan "goal with spaces" --repo "/tmp/my repo"')).toEqual([
      "plan", "goal with spaces", "--repo", "/tmp/my repo",
    ]);
  });
});
