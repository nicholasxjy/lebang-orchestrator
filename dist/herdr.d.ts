import type { AgentConfig } from "./config.js";
import type { ProcessOptions, ProcessResult } from "./process.js";
export declare class HerdrError extends Error {
    readonly name = "HerdrError";
}
export interface HerdrAgentSpec {
    agent: AgentConfig;
    cwd: string;
    sessionDir: string;
    skillPath: string;
    tools: readonly string[];
}
export interface HerdrAgentLocation {
    paneId: string;
    reused: boolean;
}
export declare class HerdrAdapter {
    readonly enabled: boolean;
    readonly command: string;
    readonly repoRoot: string;
    readonly execute: (command: readonly string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>;
    readonly environment: NodeJS.ProcessEnv;
    constructor(enabled: boolean, command: string, repoRoot: string, execute?: (command: readonly string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>, environment?: NodeJS.ProcessEnv);
    runAgent(spec: HerdrAgentSpec, prompt: string, marker: string, timeoutMs: number): Promise<string>;
    private assertSession;
    private ensureAgent;
    private existingAgent;
    private createTab;
    private startAgent;
    private run;
}
