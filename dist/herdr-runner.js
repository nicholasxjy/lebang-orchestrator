import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveSkillPath, } from "./config.js";
import { formatJson } from "./json.js";
import { utcNow } from "./persistence.js";
import { AgentRunError, RoleTools, } from "./runner.js";
export class HerdrRunner {
    repoRoot;
    store;
    config;
    herdr;
    timeoutMs;
    constructor(repoRoot, store, config, herdr, timeoutMs = 3_600_000) {
        this.repoRoot = repoRoot;
        this.store = store;
        this.config = config;
        this.herdr = herdr;
        this.timeoutMs = timeoutMs;
    }
    async run(request) {
        const runId = randomUUID().replaceAll("-", "");
        const marker = `ORCHESTRATOR_RESULT_${runId.toUpperCase()}`;
        const startTime = utcNow();
        let stdout = "";
        let stderr = "";
        let result;
        try {
            stdout = await this.herdr.runAgent(this.spec(request.agent, request.cwd), request.prompt, marker, this.timeoutMs);
            result = parseHerdrResult(stdout, marker, request.parser);
        }
        catch (error) {
            stderr = errorMessage(error);
        }
        const record = {
            runId,
            taskId: request.taskId,
            agent: request.agent.identity,
            role: request.agent.role,
            model: request.agent.model,
            cwd: request.cwd,
            startTime,
            endTime: utcNow(),
            exitCode: result === undefined ? 1 : 0,
            stdout,
            stderr,
            structuredResult: result === undefined
                ? null
                : structuredClone(result),
            stateTransition: request.stateTransition ?? null,
        };
        const recordPath = this.store.writeResult(request.taskId, request.agent.role, runId, record);
        const logPath = this.store.writeLog(`${request.taskId}-${request.agent.identity}-${runId}.log`, formatLog(record));
        const artifact = { runId, recordPath, logPath };
        if (result === undefined) {
            throw new AgentRunError(`Herdr agent run failed: ${stderr}; run record: ${recordPath}`);
        }
        return [result, artifact];
    }
    spec(agent, cwd) {
        return {
            agent,
            cwd,
            sessionDir: join(this.store.runsDir, "panes", agent.identity, "sessions"),
            skillPath: resolveSkillPath(this.repoRoot, agent.skill),
            tools: RoleTools[agent.role],
        };
    }
}
export function parseHerdrResult(transcript, marker, parser) {
    const begin = `${marker}_BEGIN`;
    const end = `${marker}_END`;
    let offset = 0;
    let last;
    while (offset < transcript.length) {
        const start = transcript.indexOf(begin, offset);
        if (start < 0)
            break;
        const finish = transcript.indexOf(end, start + begin.length);
        if (finish < 0)
            break;
        const candidate = transcript.slice(start + begin.length, finish).trim();
        try {
            last = parser(JSON.parse(candidate));
        }
        catch {
            // The prompt itself contains the markers. Keep scanning for the agent's result.
        }
        offset = finish + end.length;
    }
    if (last === undefined) {
        throw new AgentRunError("Herdr transcript did not contain a valid marked result");
    }
    return last;
}
function formatLog(record) {
    const { stdout, stderr, ...metadata } = record;
    return `${formatJson(metadata)}\n--- Herdr transcript ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=herdr-runner.js.map