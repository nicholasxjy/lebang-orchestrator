import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, resolveCliModel, SessionManager, } from "@earendil-works/pi-coding-agent";
import { resolveSkillPath } from "./config.js";
import { formatJson } from "./json.js";
import { SchemaError, } from "./models.js";
import { utcNow } from "./persistence.js";
export class AgentRunError extends Error {
    name = "AgentRunError";
}
export const RoleTools = {
    planner: ["read", "grep", "find", "ls", "bash"],
    coder: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    tester: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    reviewer: ["read", "grep", "find", "ls", "bash"],
    integrator: ["read", "grep", "find", "ls", "bash"],
};
let sharedRuntime;
export const defaultPiSdk = {
    createRuntime() {
        sharedRuntime ??= ModelRuntime.create({
            allowModelNetwork: false,
            refreshOnCreate: false,
        });
        return sharedRuntime;
    },
    async createSession(request) {
        const modelRuntime = request.runtime;
        const resolved = resolveCliModel({
            cliModel: request.model,
            modelRuntime,
        });
        if (resolved.error || !resolved.model) {
            throw new AgentRunError(resolved.error ?? `cannot resolve model ${request.model}`);
        }
        const sessionManager = SessionManager.create(request.cwd, request.sessionDir);
        sessionManager.appendSessionInfo(request.name);
        const resourceLoader = await createRoleResourceLoader(request.cwd, request.skillPath);
        const { session } = await createAgentSession({
            cwd: request.cwd,
            modelRuntime,
            model: resolved.model,
            ...(resolved.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: resolved.thinkingLevel }),
            tools: [...request.tools],
            resourceLoader,
            sessionManager,
        });
        return session;
    },
};
export class PiRunner {
    repoRoot;
    store;
    timeoutMs;
    sdk;
    runtimePromise;
    constructor(repoRoot, store, timeoutMs = 3_600_000, sdk = defaultPiSdk) {
        this.repoRoot = repoRoot;
        this.store = store;
        this.timeoutMs = timeoutMs;
        this.sdk = sdk;
    }
    async run(request) {
        const runId = randomUUID().replaceAll("-", "");
        const startTime = utcNow();
        const sessionDir = join(this.store.runsDir, request.taskId, request.agent.role, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const events = [];
        let stderr = "";
        let exitCode = 0;
        let session;
        let unsubscribe;
        let timedOut = false;
        let timer;
        try {
            const skillPath = resolveSkillPath(this.repoRoot, request.agent.skill);
            if (!existsSync(skillPath)) {
                throw new AgentRunError(`configured skill does not exist: ${skillPath}`);
            }
            this.runtimePromise ??= this.sdk.createRuntime();
            const runtime = await this.runtimePromise;
            session = await this.sdk.createSession({
                cwd: request.cwd,
                sessionDir,
                name: `${request.taskId}-${request.agent.identity}-${runId.slice(0, 8)}`,
                tools: RoleTools[request.agent.role],
                skillPath,
                model: request.agent.model,
                runtime,
            });
            unsubscribe = session.subscribe((event) => events.push(event));
            const timeout = new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    void session.abort().catch(() => undefined);
                    reject(new RunnerTimeout());
                }, this.timeoutMs);
            });
            await Promise.race([session.prompt(request.prompt), timeout]);
        }
        catch (error) {
            if (timedOut || error instanceof RunnerTimeout) {
                exitCode = -1;
                stderr = `Pi timed out after ${Math.floor(this.timeoutMs / 1000)}s`;
            }
            else {
                exitCode = 1;
                stderr = errorMessage(error);
            }
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            unsubscribe?.();
            session?.dispose();
        }
        const stdout = events.map(serializeEvent).join("\n") + (events.length ? "\n" : "");
        let result;
        let parseError;
        if (exitCode === 0) {
            try {
                result = parsePiResult(stdout, request.parser);
            }
            catch (error) {
                parseError = error instanceof AgentRunError
                    ? error
                    : new AgentRunError(errorMessage(error));
                stderr = parseError.message;
            }
        }
        const structured = result === undefined
            ? null
            : structuredClone(result);
        const record = {
            runId,
            taskId: request.taskId,
            agent: request.agent.identity,
            role: request.agent.role,
            model: request.agent.model,
            cwd: request.cwd,
            startTime,
            endTime: utcNow(),
            exitCode,
            stdout,
            stderr,
            structuredResult: structured,
            stateTransition: request.stateTransition ?? null,
        };
        const recordPath = this.store.writeResult(request.taskId, request.agent.role, runId, record);
        const logPath = this.store.writeLog(`${request.taskId}-${request.agent.identity}-${runId}.log`, formatLog(record));
        const artifact = { runId, recordPath, logPath };
        if (exitCode !== 0) {
            throw new AgentRunError(`Pi SDK run exited with ${exitCode}; run record: ${recordPath}`);
        }
        if (parseError) {
            throw new AgentRunError(`${parseError.message}; run record: ${recordPath}`);
        }
        return [result, artifact];
    }
}
export async function createRoleResourceLoader(cwd, skillPath) {
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        additionalSkillPaths: [skillPath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
    });
    await resourceLoader.reload();
    return resourceLoader;
}
export function parsePiResult(stdout, parser) {
    let finalMessage;
    let number = 0;
    for (const line of stdout.split(/\r?\n/)) {
        number += 1;
        if (!line.trim())
            continue;
        let event;
        try {
            event = JSON.parse(line);
        }
        catch (error) {
            throw new AgentRunError(`Pi emitted invalid JSON on line ${number}: ${errorMessage(error)}`);
        }
        if (event === null || typeof event !== "object" || Array.isArray(event)) {
            throw new AgentRunError(`Pi emitted a non-object event on line ${number}`);
        }
        const object = event;
        if (object.type === "message_end") {
            const message = object.message;
            if (message !== null &&
                typeof message === "object" &&
                !Array.isArray(message) &&
                message.role === "assistant") {
                finalMessage = message;
            }
        }
    }
    if (!finalMessage) {
        throw new AgentRunError("Pi output did not contain a final assistant message_end event");
    }
    if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
        const reason = finalMessage.errorMessage ?? finalMessage.stopReason;
        throw new AgentRunError(`Pi assistant request failed: ${String(reason)}`);
    }
    if (!Array.isArray(finalMessage.content)) {
        throw new AgentRunError("Pi final assistant message has invalid content");
    }
    const text = finalMessage.content
        .filter((item) => item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "text" &&
        typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim();
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw new AgentRunError(`Pi final assistant message is not one JSON object: ${errorMessage(error)}`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new AgentRunError("Pi structured result must be an object");
    }
    try {
        return parser(raw);
    }
    catch (error) {
        if (error instanceof SchemaError) {
            throw new AgentRunError(`Pi structured result failed validation: ${error.message}`);
        }
        throw error;
    }
}
function serializeEvent(event) {
    try {
        return JSON.stringify(event);
    }
    catch (error) {
        return JSON.stringify({ type: "serialization_error", error: errorMessage(error) });
    }
}
function formatLog(record) {
    const { stdout, stderr, ...metadata } = record;
    return `${formatJson(metadata)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
class RunnerTimeout extends Error {
}
//# sourceMappingURL=runner.js.map