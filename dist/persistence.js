import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { formatJson, formatJsonLine } from "./json.js";
import { SchemaError, parsePlan, parseTask, } from "./models.js";
export class StoreError extends Error {
    name = "StoreError";
}
export function utcNow() {
    return new Date().toISOString();
}
const RunStateSchema = Type.Object({
    runId: Type.String({ minLength: 1 }),
    status: Type.Union([
        Type.Literal("planned"),
        Type.Literal("running"),
        Type.Literal("replan_required"),
        Type.Literal("final_validating"),
        Type.Literal("completed"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
    ]),
    goal: Type.String({ minLength: 1 }),
    baseCommit: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    integrationBranch: Type.Union([Type.String(), Type.Null()]),
    integrationWorktree: Type.Union([Type.String(), Type.Null()]),
    integratedCommits: Type.Array(Type.String({ minLength: 1 })),
    result: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
});
export class RunStore {
    root;
    tasksDir;
    runsDir;
    logsDir;
    historyDir;
    locksDir;
    constructor(root) {
        this.root = root;
        this.tasksDir = join(root, "tasks");
        this.runsDir = join(root, "runs");
        this.logsDir = join(root, "logs");
        this.historyDir = join(root, "history");
        this.locksDir = join(root, "locks");
    }
    initialize(planValue) {
        const plan = parsePlan(planValue);
        if (existsSync(join(this.root, "plan.json"))) {
            throw new StoreError(`an orchestration plan already exists in ${this.root}`);
        }
        for (const directory of [
            this.root,
            this.tasksDir,
            this.runsDir,
            this.logsDir,
            this.historyDir,
            this.locksDir,
        ]) {
            mkdirSync(directory, { recursive: true });
        }
        this.writeJson(join(this.root, "plan.json"), plan);
        for (const task of plan.tasks)
            this.writeJson(join(this.tasksDir, `${task.id}.json`), task);
        const now = utcNow();
        this.writeJson(join(this.root, "state.json"), {
            runId: randomUUID(),
            status: "planned",
            goal: plan.goal,
            baseCommit: plan.baseCommit,
            createdAt: now,
            updatedAt: now,
            integrationBranch: null,
            integrationWorktree: null,
            integratedCommits: [],
            result: null,
        });
        this.appendJsonl(join(this.historyDir, "run.jsonl"), {
            timestamp: utcNow(),
            event: "plan_created",
            goal: plan.goal,
        });
    }
    loadPlan() {
        const plan = parsePlan(this.readJson(join(this.root, "plan.json")));
        plan.tasks = plan.tasks.map((task) => parseTask(this.readJson(join(this.tasksDir, `${task.id}.json`))));
        return plan;
    }
    saveTask(task) {
        this.writeJson(join(this.tasksDir, `${task.id}.json`), parseTask(task));
    }
    replacePlan(planValue, agent, reason) {
        const plan = parsePlan(planValue);
        const previous = this.loadPlan();
        const previousById = new Map(previous.tasks.map((task) => [task.id, task]));
        const nextById = new Map(plan.tasks.map((task) => [task.id, task]));
        for (const [taskId, oldTask] of previousById) {
            if (!nextById.has(taskId)) {
                const invalidated = { ...oldTask, status: "invalidated" };
                plan.tasks.push(invalidated);
                nextById.set(taskId, invalidated);
            }
            const nextTask = nextById.get(taskId);
            if (formatJson(oldTask) !== formatJson(nextTask)) {
                this.appendHistory(taskId, {
                    event: "task_replanned",
                    agent,
                    reason,
                    before: oldTask,
                    after: nextTask,
                });
            }
        }
        for (const [taskId, task] of nextById) {
            if (!previousById.has(taskId)) {
                this.appendHistory(taskId, {
                    event: "task_added_by_replan",
                    agent,
                    reason,
                    after: task,
                });
            }
        }
        const validated = parsePlan(plan);
        this.writeJson(join(this.root, "plan.json"), validated);
        for (const task of validated.tasks)
            this.saveTask(task);
        this.appendJsonl(join(this.historyDir, "run.jsonl"), {
            timestamp: utcNow(),
            event: "plan_replaced",
            agent,
            reason,
        });
    }
    loadState() {
        const value = this.readJson(join(this.root, "state.json"));
        if (!Value.Check(RunStateSchema, value)) {
            const first = Value.Errors(RunStateSchema, value)[0];
            throw new StoreError(`malformed state: ${first ? `${first.instancePath || "/"} ${first.message}` : "invalid value"}`);
        }
        return structuredClone(value);
    }
    saveState(stateValue) {
        const state = { ...stateValue, updatedAt: utcNow() };
        if (!Value.Check(RunStateSchema, state)) {
            const first = Value.Errors(RunStateSchema, state)[0];
            throw new StoreError(`malformed state: ${first ? `${first.instancePath || "/"} ${first.message}` : "invalid value"}`);
        }
        this.writeJson(join(this.root, "state.json"), state);
    }
    appendHistory(taskId, entry) {
        this.appendJsonl(join(this.historyDir, `${taskId}.jsonl`), {
            timestamp: utcNow(),
            ...entry,
        });
    }
    latestHistoryReason(taskId) {
        const path = join(this.historyDir, `${taskId}.jsonl`);
        if (!existsSync(path))
            return undefined;
        for (const line of readFileSync(path, "utf8").split(/\r?\n/).reverse()) {
            if (!line)
                continue;
            try {
                const record = JSON.parse(line);
                if (typeof record.reason === "string")
                    return record.reason;
            }
            catch (error) {
                throw new StoreError(`malformed task history in ${path}: ${String(error)}`);
            }
        }
        return undefined;
    }
    writeResult(taskId, role, runId, result) {
        const path = join(this.runsDir, taskId, role, `${runId}.json`);
        this.writeJson(path, result);
        return path;
    }
    latestStructuredResult(taskId, role, parser) {
        const directory = join(this.runsDir, taskId, role);
        if (!existsSync(directory))
            return undefined;
        const paths = readdirSync(directory)
            .filter((name) => name.endsWith(".json"))
            .map((name) => join(directory, name));
        if (paths.length === 0)
            return undefined;
        paths.sort((left, right) => {
            const leftTime = statSync(left, { bigint: true }).mtimeNs;
            const rightTime = statSync(right, { bigint: true }).mtimeNs;
            return rightTime > leftTime ? 1 : rightTime < leftTime ? -1 : right.localeCompare(left);
        });
        const path = paths[0];
        const record = this.readJson(path);
        if (record.exitCode !== 0)
            return undefined;
        if (record.structuredResult === null || typeof record.structuredResult !== "object") {
            throw new StoreError(`run record has no structured result: ${path}`);
        }
        try {
            return parser(record.structuredResult);
        }
        catch (error) {
            if (error instanceof SchemaError) {
                throw new StoreError(`invalid structured result in ${path}: ${error.message}`);
            }
            throw error;
        }
    }
    writeLog(name, content) {
        mkdirSync(this.logsDir, { recursive: true });
        const path = join(this.logsDir, name);
        writeFileSync(path, content, "utf8");
        return path;
    }
    async withTaskLock(taskId, action) {
        mkdirSync(this.locksDir, { recursive: true });
        const path = join(this.locksDir, `${taskId}.lock`);
        const nonce = randomUUID().replaceAll("-", "");
        const record = {
            taskId,
            pid: process.pid,
            nonce,
            createdAt: utcNow(),
        };
        for (;;) {
            try {
                const descriptor = openSync(path, "wx", 0o600);
                try {
                    writeSync(descriptor, `${formatJsonLine(record)}\n`);
                    fsyncSync(descriptor);
                }
                finally {
                    closeSync(descriptor);
                }
                break;
            }
            catch (error) {
                if (!isAlreadyExists(error))
                    throw error;
                const existing = this.readJson(path);
                const pid = existing.pid;
                if (typeof pid === "number" && pidIsAlive(pid)) {
                    throw new StoreError(`task ${taskId} is already locked by process ${pid}`);
                }
                unlinkSync(path);
                this.appendHistory(taskId, {
                    event: "stale_lock_removed",
                    agent: "orchestrator",
                    reason: `owner process ${String(pid)} is not running`,
                });
            }
        }
        try {
            return await action();
        }
        finally {
            try {
                const current = this.readJson(path);
                if (current.nonce === nonce)
                    unlinkSync(path);
            }
            catch {
                // A replaced or malformed lock belongs to another recovery attempt.
            }
        }
    }
    appendJsonl(path, value) {
        mkdirSync(dirname(path), { recursive: true });
        const descriptor = openSync(path, "a", 0o600);
        try {
            writeSync(descriptor, `${formatJsonLine(value)}\n`);
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
    }
    readJson(path) {
        try {
            const value = JSON.parse(readFileSync(path, "utf8"));
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new Error("expected an object");
            }
            return value;
        }
        catch (error) {
            throw new StoreError(`cannot read valid JSON from ${path}: ${String(error)}`);
        }
    }
    writeJson(path, value) {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = join(dirname(path), `.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}`);
        const descriptor = openSync(temporary, "wx", 0o600);
        try {
            writeSync(descriptor, `${formatJson(value)}\n`);
            fsyncSync(descriptor);
            closeSync(descriptor);
            renameSync(temporary, path);
        }
        catch (error) {
            try {
                closeSync(descriptor);
            }
            catch { }
            try {
                unlinkSync(temporary);
            }
            catch { }
            throw error;
        }
    }
}
function isAlreadyExists(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function pidIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}
//# sourceMappingURL=persistence.js.map