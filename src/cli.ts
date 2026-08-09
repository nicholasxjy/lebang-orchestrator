#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCommand } from "./commands.js";

export function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return executeCommand(argv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
