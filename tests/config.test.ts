import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  parseConfig,
  resolveConfigPath,
  resolveSkillsRoot,
  selectCoder,
} from "../src/config.js";
import { makeTask } from "./helpers.js";

describe("configuration", () => {
  it("routes unassigned work to the configured default coder by role", () => {
    const config = parseConfig({
      maxWorkers: 2,
      maxReviewAttempts: 3,
      piCommand: "pi",
      validationCommands: [["npm", "test"]],
      herdr: { enabled: false, command: "herdr" },
      agents: {
        kd: { role: "coder", skill: "coder", model: "example/model" },
        curry: { role: "reviewer", skill: "reviewer", model: "example/model" },
      },
    });
    expect(selectCoder(config, makeTask({ assignedAgent: null }), new Set())).toBe("kd");
  });

  it("declares the required repository team", () => {
    const config = loadConfig(join(process.cwd(), ".orchestrator", "config.json"));
    expect(Object.keys(config.agents).sort()).toEqual([
      "booker", "curry", "duncan", "giannis", "harden", "jokic", "kawhi", "kd", "lebang",
      "luka", "sga", "tatum", "westbrook",
    ]);
    expect(config.agents.lebang!.role).toBe("planner");
    expect(config.agents.westbrook!.role).toBe("tester");
    expect(config.agents.curry!.role).toBe("reviewer");
    expect(config.agents.duncan!.role).toBe("integrator");
  });

  it("requires a final validation command", () => {
    expect(() => parseConfig({
      maxWorkers: 1,
      maxReviewAttempts: 3,
      validationCommands: [],
      herdr: { enabled: false, command: "herdr" },
      agents: { kd: { role: "coder", skill: "coder", model: "example/model" } },
    })).toThrow(/validationCommands|validation/);
  });

  it("rejects agent identities Herdr cannot name", () => {
    expect(() => parseConfig({
      maxWorkers: 1,
      maxReviewAttempts: 1,
      validationCommands: [["npm", "test"]],
      herdr: { enabled: true, command: "herdr" },
      agents: { "Bad Agent": { role: "coder", skill: "coder", model: "example/model" } },
    })).toThrow(/must match.*Herdr/);
  });

  it("falls back to installed package skills", () => {
    const root = resolveSkillsRoot("/tmp/repository-without-skills");
    expect(existsSync(join(root, "planner", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "integrator", "SKILL.md"))).toBe(true);
  });

  it("falls back to the installed default config and accepts missing piCommand", () => {
    const path = resolveConfigPath("/tmp/repository-without-config");
    expect(path.endsWith("config.json")).toBe(true);
    expect(loadConfig(path).agents.lebang).toBeDefined();
    const config = parseConfig({
      maxWorkers: 1,
      maxReviewAttempts: 1,
      validationCommands: [["npm", "test"]],
      herdr: { enabled: false, command: "herdr" },
      agents: { kd: { role: "coder", skill: "coder", model: "example/model" } },
    });
    expect(config.piCommand).toBeUndefined();
  });
});
