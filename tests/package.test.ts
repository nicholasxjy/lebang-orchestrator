import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import orchestratorExtension from "../src/extension.js";

describe("Pi package", () => {
  it("declares the CLI, extension, skills, engine, and locked SDK", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest).toMatchObject({
      name: "lebang-orchestrator",
      version: "0.1.0",
      bin: { orchestrator: "dist/cli.js" },
      pi: { extensions: ["dist/extension.js"], skills: ["skills"] },
      engines: { node: ">=22.19.0" },
      scripts: { prepack: "npm run build" },
      peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
      devDependencies: { "@earendil-works/pi-coding-agent": "0.84.1" },
    });
    expect(manifest.scripts).not.toHaveProperty("prepare");
  });

  it("registers only /orchestrator and no model-callable tool", () => {
    const commands: string[] = [];
    let tools = 0;
    const pi = {
      registerCommand(name: string) { commands.push(name); },
      registerTool() { tools += 1; },
    } as unknown as ExtensionAPI;
    orchestratorExtension(pi);
    expect(commands).toEqual(["orchestrator"]);
    expect(tools).toBe(0);
  });

  it("loads the built extension in Pi offline without a paid model call", () => {
    const pi = join(process.cwd(), "node_modules", ".bin", "pi");
    const output = execFileSync(pi, ["--offline", "-e", "dist/extension.js", "--list-models"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(output).toContain("provider");
    expect(output).toContain("model");
  });
});
