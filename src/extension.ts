import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeCommand, type CommandIo } from "./commands.js";

export default function orchestratorExtension(pi: ExtensionAPI): void {
  pi.registerCommand("orchestrator", {
    description: "Run lebang-orchestrator commands",
    handler: async (args, ctx) => {
      const output = captureIo();
      let exitCode: number;
      try {
        const argv = args.trim() ? splitCommandLine(args) : ["--help"];
        exitCode = await executeCommand(argv, {
          cwd: ctx.cwd,
          defaultRepo: ctx.cwd,
          io: output.io,
        });
      } catch (error) {
        exitCode = 2;
        output.io.stderr(`orchestrator: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      const content = `${output.stdout()}${output.stderr()}`.trimEnd();
      pi.sendMessage(
        {
          customType: "lebang-orchestrator",
          content: content || `orchestrator exited with ${exitCode}`,
          display: true,
          details: { exitCode },
        },
        { triggerTurn: false, deliverAs: "followUp" },
      );
    },
  });
}

export function splitCommandLine(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        result.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("unterminated quote in /orchestrator arguments");
  if (started) result.push(current);
  return result;
}

function captureIo(): {
  io: CommandIo;
  stdout(): string;
  stderr(): string;
} {
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
