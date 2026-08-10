import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./process.js";
const agentPaneReadyAttempts = 40;
const agentPaneReadyDelayMs = 250;
const sessionFlushAttempts = 20;
const sessionFlushDelayMs = 100;
export class HerdrError extends Error {
    name = "HerdrError";
}
export class HerdrAdapter {
    enabled;
    command;
    repoRoot;
    execute;
    environment;
    constructor(enabled, command, repoRoot, execute = runProcess, environment = process.env) {
        this.enabled = enabled;
        this.command = command;
        this.repoRoot = repoRoot;
        this.execute = execute;
        this.environment = environment;
    }
    async runAgent(spec, prompt, marker, timeoutMs) {
        this.assertSession();
        await this.ensureAgent(spec);
        const transportPrompt = [
            prompt,
            "",
            "Herdr result transport:",
            `End the response with ${marker}_BEGIN on its own line, then one compact JSON object on one line, then ${marker}_END on its own line.`,
            "Do not place any text after the end marker.",
        ].join("\n");
        await this.run([
            this.command,
            "agent",
            "prompt",
            spec.agent.identity,
            transportPrompt,
            "--wait",
            "--timeout",
            String(timeoutMs),
        ], spec.cwd, timeoutMs + 5_000, `prompt ${spec.agent.identity}`);
        if (existsSync(spec.sessionDir)) {
            for (let attempt = 1; attempt <= sessionFlushAttempts; attempt += 1) {
                const transcript = sessionTranscript(spec.sessionDir, marker);
                if (transcript !== undefined)
                    return transcript;
                if (attempt < sessionFlushAttempts)
                    await delay(sessionFlushDelayMs);
            }
        }
        const read = await this.run([
            this.command,
            "agent",
            "read",
            spec.agent.identity,
            "--source",
            "recent-unwrapped",
            "--lines",
            "1000",
        ], spec.cwd, 30_000, `read ${spec.agent.identity}`);
        return responseText(read.stdout);
    }
    assertSession() {
        if (!this.enabled) {
            throw new HerdrError("Herdr is disabled in the orchestrator configuration");
        }
        if (this.environment.HERDR_ENV !== "1") {
            throw new HerdrError("orchestrator must run inside a Herdr-managed pane");
        }
    }
    async ensureAgent(spec) {
        const existing = await this.existingAgent(spec);
        if (existing !== undefined)
            return existing;
        const tab = await this.createTab(spec.cwd, `orchestrator-${spec.agent.identity}`);
        await this.startAgent(spec, tab.rootPaneId);
        return { paneId: tab.rootPaneId, reused: false };
    }
    async existingAgent(spec) {
        const existing = await this.execute([this.command, "agent", "get", spec.agent.identity], spec.cwd, { timeoutMs: 30_000 });
        if (existing.exitCode === 0) {
            const cwd = responseCwd(existing.stdout);
            if (cwd !== undefined && cwd !== this.repoRoot && !cwd.startsWith(`${this.repoRoot}/.worktrees/`)) {
                throw new HerdrError(`Herdr agent name ${spec.agent.identity} is already used by a different repository: ${cwd}`);
            }
            const paneId = responsePaneId(existing.stdout) ?? spec.agent.identity;
            return { paneId, reused: true };
        }
        return undefined;
    }
    async createTab(cwd, label) {
        const workspaceId = this.environment.HERDR_WORKSPACE_ID;
        if (!workspaceId)
            throw new HerdrError("Herdr did not provide HERDR_WORKSPACE_ID");
        const result = await this.run([
            this.command,
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            cwd,
            "--label",
            label,
            "--no-focus",
        ], cwd, 30_000, `create tab ${label}`);
        const tabId = responseTabId(result.stdout);
        const rootPaneId = responsePaneId(result.stdout);
        if (!tabId || !rootPaneId) {
            throw new HerdrError(`Herdr tab create for ${label} returned incomplete identifiers`);
        }
        return { tabId, rootPaneId };
    }
    async startAgent(spec, paneId) {
        const command = [
            this.command,
            "agent",
            "start",
            spec.agent.identity,
            "--kind",
            "pi",
            "--pane",
            paneId,
            "--",
            "--mode",
            "text",
            "--model",
            spec.agent.model,
            "--skill",
            spec.skillPath,
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--tools",
            spec.tools.join(","),
            "--session-dir",
            spec.sessionDir,
            "--name",
            spec.agent.identity,
        ];
        for (let attempt = 1; attempt <= agentPaneReadyAttempts; attempt += 1) {
            const result = await this.execute(command, spec.cwd, { timeoutMs: 60_000 });
            if (result.exitCode === 0)
                return;
            if (responseErrorCode(result) !== "agent_pane_busy" ||
                attempt === agentPaneReadyAttempts) {
                const detail = processResultDetail(result);
                throw new HerdrError(`Herdr start ${spec.agent.identity} failed with ${result.exitCode}: ${detail}`);
            }
            await delay(agentPaneReadyDelayMs);
        }
    }
    async run(command, cwd, timeoutMs, action) {
        const result = await this.execute(command, cwd, { timeoutMs });
        if (result.exitCode !== 0) {
            const detail = processResultDetail(result);
            throw new HerdrError(`Herdr ${action} failed with ${result.exitCode}: ${detail}`);
        }
        return result;
    }
}
function sessionTranscript(sessionDir, marker) {
    const begin = `${marker}_BEGIN`;
    const end = `${marker}_END`;
    let paths;
    try {
        paths = readdirSync(sessionDir)
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(sessionDir, name))
            .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    }
    catch {
        return undefined;
    }
    for (const path of paths) {
        const texts = [];
        let content;
        try {
            content = readFileSync(path, "utf8");
        }
        catch {
            continue;
        }
        for (const line of content.split(/\r?\n/)) {
            if (!line)
                continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type !== "message" || entry.message?.role !== "assistant")
                    continue;
                if (typeof entry.message.content === "string") {
                    texts.push(entry.message.content);
                    continue;
                }
                if (!Array.isArray(entry.message.content))
                    continue;
                for (const block of entry.message.content) {
                    if (block !== null &&
                        typeof block === "object" &&
                        block.type === "text" &&
                        typeof block.text === "string") {
                        texts.push(block.text);
                    }
                }
            }
            catch {
                // A partially flushed JSONL line will be retried after the agent settles.
            }
        }
        const transcript = texts.join("\n");
        if (transcript.includes(begin) && transcript.includes(end))
            return transcript;
        const beginIndex = transcript.lastIndexOf(begin);
        if (beginIndex !== -1) {
            const candidate = transcript.slice(beginIndex + begin.length).trim();
            try {
                JSON.parse(candidate);
                return `${transcript.trimEnd()}\n${end}`;
            }
            catch {
                // The result is incomplete or has trailing text; wait for a marked result.
            }
        }
    }
    return undefined;
}
function responseErrorCode(result) {
    for (const output of [result.stderr, result.stdout]) {
        if (!output.trim())
            continue;
        try {
            const response = JSON.parse(output);
            if (typeof response.error?.code === "string")
                return response.error.code;
        }
        catch {
            // Non-JSON errors are handled as ordinary Herdr command failures.
        }
    }
    return undefined;
}
function processResultDetail(result) {
    return result.stderr.trim() || result.stdout.trim() || "no output";
}
async function delay(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function responsePaneId(stdout) {
    const response = parseResponse(stdout);
    return findString(response, new Set(["pane_id", "paneId"]));
}
function responseTabId(stdout) {
    const response = parseResponse(stdout);
    return findString(response, new Set(["tab_id", "tabId"]));
}
function responseCwd(stdout) {
    const response = parseResponse(stdout);
    return findString(response, new Set(["cwd"]));
}
function responseText(stdout) {
    let response;
    try {
        response = JSON.parse(stdout);
    }
    catch {
        return stdout;
    }
    const values = [];
    collectStrings(response, values);
    values.sort((left, right) => right.length - left.length);
    return values.join("\n");
}
function parseResponse(stdout) {
    try {
        return JSON.parse(stdout);
    }
    catch (error) {
        throw new HerdrError(`Herdr returned malformed JSON: ${errorMessage(error)}`);
    }
}
function findString(value, keys) {
    if (value === null || typeof value !== "object")
        return undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findString(item, keys);
            if (found !== undefined)
                return found;
        }
        return undefined;
    }
    for (const [key, item] of Object.entries(value)) {
        if (keys.has(key) && typeof item === "string")
            return item;
        const found = findString(item, keys);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
function collectStrings(value, target) {
    if (typeof value === "string") {
        target.push(value);
        return;
    }
    if (value === null || typeof value !== "object")
        return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
        collectStrings(item, target);
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=herdr.js.map