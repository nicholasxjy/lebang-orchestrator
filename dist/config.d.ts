import { Type, type Static } from "typebox";
import { type Task } from "./models.js";
export declare const Roles: readonly ["planner", "coder", "tester", "reviewer", "integrator"];
export type Role = (typeof Roles)[number];
declare const AgentSchema: Type.TObject<{
    role: Type.TUnion<[Type.TLiteral<"planner">, Type.TLiteral<"coder">, Type.TLiteral<"tester">, Type.TLiteral<"reviewer">, Type.TLiteral<"integrator">]>;
    skill: Type.TString;
    model: Type.TString;
}>;
export interface AgentConfig extends Static<typeof AgentSchema> {
    identity: string;
}
export interface OrchestratorConfig {
    maxWorkers: number;
    maxReviewAttempts: number;
    /** Accepted only for compatibility with Python-era configuration files. */
    piCommand?: string;
    validationCommands: string[][];
    herdr: {
        enabled: boolean;
        command: string;
    };
    agents: Record<string, AgentConfig>;
}
export declare function parseConfig(value: unknown): OrchestratorConfig;
export declare function loadConfig(path: string): OrchestratorConfig;
export declare function resolveConfigPath(repoRoot: string, explicit?: string): string;
export declare function resolveSkillsRoot(repoRoot: string): string;
export declare function resolveSkillPath(repoRoot: string, skill: string): string;
export declare function selectCoder(config: OrchestratorConfig, task: Task, unavailable: Set<string>): string | undefined;
export declare function agentForRole(config: OrchestratorConfig, role: Role): AgentConfig;
export declare function absoluteFrom(base: string, path: string): string;
export {};
