import { basename } from "node:path";
import { runProcess } from "./process.js";
const agentPaneReadyAttempts = 40;
const agentPaneReadyDelayMs = 250;
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
    async initialize(specs) {
        this.assertSession();
        const agents = {};
        const missing = [];
        for (const spec of specs) {
            const existing = await this.existingAgent(spec);
            if (existing === undefined)
                missing.push(spec);
            else
                agents[spec.agent.identity] = existing;
        }
        if (missing.length === 0)
            return { tabId: null, agents };
        const tab = await this.createTab(this.repoRoot, `orchestrator-${basename(this.repoRoot)}`);
        const paneIds = await this.createBalancedPanes(tab.rootPaneId, missing.length, this.repoRoot);
        for (let index = 0; index < missing.length; index += 1) {
            const spec = missing[index];
            const paneId = paneIds[index];
            await this.startAgent(spec, paneId);
            agents[spec.agent.identity] = { paneId, reused: false };
        }
        return { tabId: tab.tabId, agents };
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
    async createBalancedPanes(rootPaneId, count, cwd) {
        const paneIds = [rootPaneId];
        while (paneIds.length < count) {
            const layout = await this.run([this.command, "pane", "layout", "--pane", rootPaneId], cwd, 30_000, "inspect team layout");
            const target = layoutSplit(layout.stdout, rootPaneId);
            const split = await this.run([
                this.command,
                "pane",
                "split",
                target.paneId,
                "--direction",
                target.direction,
                "--cwd",
                cwd,
                "--no-focus",
            ], cwd, 30_000, "create team pane");
            const paneId = responsePaneId(split.stdout);
            if (!paneId)
                throw new HerdrError("Herdr pane split returned no pane_id");
            paneIds.push(paneId);
        }
        return paneIds;
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
function layoutSplit(stdout, fallbackPaneId) {
    const response = parseResponse(stdout);
    const panes = findArray(response, "panes");
    let selected;
    for (const value of panes ?? []) {
        if (value === null || typeof value !== "object" || Array.isArray(value))
            continue;
        const pane = value;
        const rect = pane.rect;
        if (typeof pane.pane_id !== "string" || rect === null || typeof rect !== "object")
            continue;
        const width = rect.width;
        const height = rect.height;
        if (typeof width !== "number" || typeof height !== "number")
            continue;
        if (selected === undefined || width * height > selected.width * selected.height) {
            selected = { paneId: pane.pane_id, width, height };
        }
    }
    if (selected === undefined)
        return { paneId: fallbackPaneId, direction: "right" };
    return {
        paneId: selected.paneId,
        direction: selected.width >= selected.height * 2 ? "right" : "down",
    };
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
function findArray(value, key) {
    if (value === null || typeof value !== "object")
        return undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findArray(item, key);
            if (found !== undefined)
                return found;
        }
        return undefined;
    }
    for (const [candidate, item] of Object.entries(value)) {
        if (candidate === key && Array.isArray(item))
            return item;
        const found = findArray(item, key);
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