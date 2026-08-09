import { type OrchestratorConfig } from "./config.js";
import { HerdrAdapter, type HerdrTeam } from "./herdr.js";
import type { ResultParser, RunResult } from "./models.js";
import { type RunStore } from "./persistence.js";
import { type AgentRunner, type AgentRunRequest, type PiRunArtifact } from "./runner.js";
export declare class HerdrRunner implements AgentRunner {
    readonly repoRoot: string;
    readonly store: RunStore;
    readonly config: OrchestratorConfig;
    readonly herdr: HerdrAdapter;
    readonly timeoutMs: number;
    constructor(repoRoot: string, store: RunStore, config: OrchestratorConfig, herdr: HerdrAdapter, timeoutMs?: number);
    initializeTeam(): Promise<HerdrTeam>;
    presentToPlanner(result: RunResult | Error): Promise<void>;
    run<T>(request: AgentRunRequest<T>): Promise<[T, PiRunArtifact]>;
    private spec;
}
export declare function parseHerdrResult<T>(transcript: string, marker: string, parser: ResultParser<T>): T;
