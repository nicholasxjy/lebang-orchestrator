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
export interface HerdrTeam {
    tabId: string | null;
    agents: Record<string, HerdrAgentLocation>;
}
export declare class HerdrAdapter {
    readonly enabled: boolean;
    readonly command: string;
    readonly repoRoot: string;
    readonly execute: (command: readonly string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>;
    readonly environment: NodeJS.ProcessEnv;
    constructor(enabled: boolean, command: string, repoRoot: string, execute?: (command: readonly string[], cwd: string, options?: ProcessOptions) => Promise<ProcessResult>, environment?: NodeJS.ProcessEnv);
    initialize(specs: readonly HerdrAgentSpec[]): Promise<HerdrTeam>;
    runAgent(spec: HerdrAgentSpec, prompt: string, marker: string, timeoutMs: number): Promise<string>;
    private assertSession;
    private ensureAgent;
    private existingAgent;
    private createTab;
    private createBalancedPanes;
    private startAgent;
    private run;
}
