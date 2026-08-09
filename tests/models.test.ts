import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/models.js";
import { readyTaskIds } from "../src/state.js";
import { makeTask } from "./helpers.js";

describe("plan model", () => {
  it("exposes only dependency-free tasks as ready", () => {
    const plan = parsePlan({
      goal: "Add retry support",
      baseCommit: "abc123",
      tasks: [
        makeTask({ id: "T1", assignedAgent: "kd" }),
        makeTask({ id: "T2", dependencies: ["T1"], assignedAgent: "harden" }),
      ],
    });
    expect(readyTaskIds(plan.tasks)).toEqual(["T1"]);
  });

  it("rejects dependency cycles", () => {
    expect(() => parsePlan({
      goal: "Reject invalid work",
      baseCommit: "abc123",
      tasks: [makeTask({ dependencies: ["T1"] })],
    })).toThrow(/cycle/);
  });
});
