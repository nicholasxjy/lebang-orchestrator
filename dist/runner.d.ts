import { DefaultResourceLoader, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./config.js";
import { type ResultParser } from "./models.js";
import { type RunStore } from "./persistence.js";
export declare class AgentRunError extends Error {
    readonly name = "AgentRunError";
}
export declare const RoleTools: {
    readonly planner: readonly ["read", "grep", "find", "ls"];
    readonly coder: readonly ["read", "grep", "find", "ls", "bash", "edit", "write"];
    readonly tester: readonly ["read", "grep", "find", "ls", "bash", "edit", "write"];
    readonly reviewer: readonly ["read", "grep", "find", "ls", "bash"];
    readonly integrator: readonly ["read", "grep", "find", "ls", "bash"];
};
export interface PiRunArtifact {
    runId: string;
    recordPath: string;
    logPath: string;
}
export interface AgentRunRequest<T> {
    agent: AgentConfig;
    taskId: string;
    cwd: string;
    prompt: string;
    parser: ResultParser<T>;
    stateTransition?: string;
}
export interface AgentRunner {
    run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact | undefined]>;
}
export interface SdkSession {
    subscribe(listener: (event: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
}
export interface SdkSessionRequest {
    cwd: string;
    sessionDir: string;
    name: string;
    tools: readonly string[];
    skillPath: string;
    model: string;
    role: AgentConfig["role"];
    runtime: unknown;
}
export interface PiSdkAdapter {
    createRuntime(): Promise<unknown>;
    createSession(request: SdkSessionRequest): Promise<SdkSession>;
}
export declare const defaultPiSdk: PiSdkAdapter;
export declare class PiRunner implements AgentRunner {
    readonly repoRoot: string;
    readonly store: RunStore;
    readonly timeoutMs: number;
    readonly sdk: PiSdkAdapter;
    private runtimePromise;
    constructor(repoRoot: string, store: RunStore, timeoutMs?: number, sdk?: PiSdkAdapter);
    run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact]>;
}
export declare function createRoleResourceLoader(cwd: string, skillPath: string): Promise<DefaultResourceLoader>;
export declare function parsePiResult<T>(stdout: string, parser: ResultParser<T>): T;
export type { AgentSessionEvent };
