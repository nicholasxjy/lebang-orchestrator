import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/persistence.js";
import { transitionTask } from "../src/state.js";
import { makeTask, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run persistence", () => {
  it("survives a new store instance", () => {
    const root = temporaryDirectory(); roots.push(root);
    const plan = { goal: "Persist", baseCommit: "abc123", tasks: [makeTask()] };
    new RunStore(root).initialize(plan);
    const loaded = new RunStore(root).loadPlan();
    const history = readFileSync(join(root, "history", "run.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(loaded).toEqual(plan);
    expect(history[0].event).toBe("plan_created");
  });

  it("validates, persists, and audits transitions", () => {
    const root = temporaryDirectory(); roots.push(root);
    const task = makeTask();
    const store = new RunStore(root);
    store.initialize({ goal: "Track", baseCommit: "abc123", tasks: [task] });
    transitionTask(store, task, "ready", "lebang", "dependencies met");
    expect(() => transitionTask(store, task, "completed", "lebang", "skip work")).toThrow();
    const history = readFileSync(join(root, "history", "T1.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(store.loadPlan().tasks[0]!.status).toBe("ready");
    expect(history[0]).toMatchObject({ fromStatus: "pending", toStatus: "ready", agent: "lebang" });
  });

  it("rejects malformed persisted state explicitly", () => {
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(root);
    store.initialize({ goal: "Validate", baseCommit: "abc123", tasks: [makeTask()] });
    writeFileSync(join(root, "state.json"), '{"status":"running"}\n', "utf8");
    expect(() => store.loadState()).toThrow(/malformed state/);
  });

  it("prevents duplicate task execution with an exclusive lock", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(root);
    await store.withTaskLock("T1", async () => {
      await expect(store.withTaskLock("T1", async () => undefined)).rejects.toThrow(/already locked/);
    });
    expect(existsSync(join(root, "locks", "T1.lock"))).toBe(false);
  });

  it("removes a stale PID lock before continuing", async () => {
    const root = temporaryDirectory(); roots.push(root);
    const store = new RunStore(root);
    mkdirSync(store.locksDir, { recursive: true });
    writeFileSync(join(store.locksDir, "T1.lock"), JSON.stringify({
      taskId: "T1",
      pid: 2_147_483_647,
      nonce: "stale",
      createdAt: "2026-08-01T00:00:00Z",
    }));
    await store.withTaskLock("T1", async () => undefined);
    expect(existsSync(join(store.locksDir, "T1.lock"))).toBe(false);
    expect(readFileSync(join(store.historyDir, "T1.jsonl"), "utf8")).toContain("stale_lock_removed");
  });
});
