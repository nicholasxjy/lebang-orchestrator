import { describe, expect, it } from "vitest";
import {
  parseCoderResult,
  parseReviewResult,
  parseRunResult,
  parseTestResult,
} from "../src/models.js";

describe("structured result contracts", () => {
  it("requires a commit for a completed coder result", () => {
    expect(() => parseCoderResult({
      taskId: "T1",
      status: "completed",
      summary: "done",
      changedFiles: ["src/example.ts"],
      testsAdded: ["tests/example.test.ts"],
      testsRun: ["npm test"],
      testResult: "passed",
      commit: null,
      blockers: [],
    })).toThrow(/commit/);
  });

  it("requires a reproducible failure for failed tests", () => {
    expect(() => parseTestResult({
      taskId: "T1",
      status: "failed",
      testsExecuted: ["npm test"],
      testsAdded: [],
      failures: [],
      commit: null,
    })).toThrow(/failure/);
  });

  it("rejects completed runs with failed validation", () => {
    expect(() => parseRunResult({
      status: "completed",
      summary: "integrated",
      integratedCommits: ["deadbeef"],
      validations: [{ command: ["npm", "test"], exitCode: 1, stdout: "", stderr: "failed" }],
      issues: [],
    })).toThrow(/validation/);
  });

  it("rejects contradictory review decisions", () => {
    expect(() => parseReviewResult({
      taskId: "T1",
      status: "approved",
      issues: [{
        severity: "high",
        scope: "task",
        description: "bug",
        expected: "no bug",
        ownerTaskId: "T1",
      }],
    })).toThrow(/approved/);
  });
});
