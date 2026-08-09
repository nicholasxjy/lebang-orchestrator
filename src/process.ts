import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function runProcess(
  command: readonly string[],
  cwd: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  if (command.length === 0) throw new Error("command must not be empty");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = options.signal?.aborted ?? false;
    let settled = false;
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortListener);
      resolve({ exitCode, stdout, stderr, timedOut, aborted });
    };
    const abortListener = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs);

    child.on("error", (error) => {
      stderr += String(error);
      finish(127);
    });
    child.on("close", (code, signal) => {
      if (signal && timedOut) stderr += `\ncommand timed out after ${options.timeoutMs}ms`;
      finish(code ?? (aborted || timedOut ? -1 : 1));
    });
  });
}
