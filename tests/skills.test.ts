import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("role skills", () => {
  it("exist without model ids and include hard role boundaries", () => {
    const roles = ["planner", "coder", "tester", "reviewer", "integrator"];
    const contents = Object.fromEntries(
      roles.map((role) => [role, readFileSync(join("skills", role, "SKILL.md"), "utf8")]),
    );
    for (const role of roles) {
      expect(contents[role]).toContain(`name: ${role}`);
      expect(contents[role]).not.toMatch(/\b(?:gpt|claude|gemini|sonnet|opus)-[\w.-]+/i);
    }
    expect(contents.planner).toContain("Do not perform implementation work that can reasonably be delegated to a worker.");
    expect(contents.coder).toContain("assigned worktree");
    expect(contents.tester).toContain("production code");
    expect(contents.reviewer).toContain("approved | changes_requested | replan_required");
    expect(contents.reviewer).toContain("direct unit tests as `task`");
    expect(contents.reviewer).toContain("regression, edge, or integration coverage as `test`");
    expect(contents.integrator).toContain("approved commits");
  });
});
