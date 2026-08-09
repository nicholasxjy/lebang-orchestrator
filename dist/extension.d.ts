import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function orchestratorExtension(pi: ExtensionAPI): void;
export declare function taskProgress(repoRoot: string): string | undefined;
export declare function classifyOutcome(exitCode: number, command: string, stdout: string, stderr: string): {
    symbol: string;
    message: string;
    notification: "info" | "warning" | "error";
};
export declare function splitCommandLine(value: string): string[];
