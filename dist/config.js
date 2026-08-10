import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SchemaError } from "./models.js";
export const Roles = ["planner", "coder", "tester", "reviewer", "integrator"];
const AgentSchema = Type.Object({
    role: Type.Union([
        Type.Literal("planner"),
        Type.Literal("coder"),
        Type.Literal("tester"),
        Type.Literal("reviewer"),
        Type.Literal("integrator"),
    ]),
    skill: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
});
const ConfigSchema = Type.Object({
    maxWorkers: Type.Integer({ minimum: 1 }),
    maxReviewAttempts: Type.Integer({ minimum: 1 }),
    piCommand: Type.Optional(Type.String({ minLength: 1 })),
    validationCommands: Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { minItems: 1 }),
    herdr: Type.Object({
        enabled: Type.Boolean(),
        command: Type.String({ minLength: 1 }),
    }),
    agents: Type.Record(Type.String({ minLength: 1 }), AgentSchema),
});
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function initializeProjectConfig(repoRoot) {
    const directory = join(resolve(repoRoot), ".orchestrator");
    const path = join(directory, "config.json");
    if (existsSync(path)) {
        if (!isFile(path))
            throw new SchemaError(`configuration path is not a file: ${path}`);
        return { path, created: false };
    }
    mkdirSync(directory, { recursive: true });
    copyFileSync(join(packageRoot, ".orchestrator", "config.json"), path, constants.COPYFILE_EXCL);
    return { path, created: true };
}
export function parseConfig(value) {
    if (!Value.Check(ConfigSchema, value)) {
        const first = Value.Errors(ConfigSchema, value)[0];
        throw new SchemaError(`configuration failed validation: ${first ? `${first.instancePath || "/"} ${first.message}` : "invalid value"}`);
    }
    const raw = structuredClone(value);
    const agents = Object.fromEntries(Object.entries(raw.agents).map(([identity, agent]) => [
        identity,
        { identity, ...agent },
    ]));
    if (Object.keys(agents).length === 0) {
        throw new SchemaError("agents must be a non-empty object");
    }
    for (const identity of Object.keys(agents)) {
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(identity)) {
            throw new SchemaError(`agent identity ${identity} must match [a-z][a-z0-9_-]{0,31} for Herdr`);
        }
    }
    return {
        maxWorkers: raw.maxWorkers,
        maxReviewAttempts: raw.maxReviewAttempts,
        ...(raw.piCommand === undefined ? {} : { piCommand: raw.piCommand }),
        validationCommands: raw.validationCommands.map((command) => [...command]),
        herdr: { ...raw.herdr },
        agents,
    };
}
export function loadConfig(path) {
    try {
        return parseConfig(JSON.parse(readFileSync(path, "utf8")));
    }
    catch (error) {
        if (error instanceof SchemaError)
            throw error;
        throw new SchemaError(`cannot load configuration from ${path}: ${String(error)}`);
    }
}
export function resolveConfigPath(repoRoot, explicit) {
    if (explicit !== undefined) {
        const path = resolve(explicit);
        if (!isFile(path)) {
            throw new SchemaError(`configuration file does not exist: ${path}`);
        }
        return path;
    }
    for (const candidate of [
        join(repoRoot, ".orchestrator", "config.json"),
        join(packageRoot, ".orchestrator", "config.json"),
    ]) {
        if (isFile(candidate))
            return resolve(candidate);
    }
    throw new SchemaError("cannot find configuration in the target repository or installation");
}
export function resolveSkillsRoot(repoRoot) {
    const required = Roles;
    for (const candidate of [join(repoRoot, ".skills"), join(packageRoot, "skills")]) {
        if (required.every((role) => isFile(join(candidate, role, "SKILL.md")))) {
            return resolve(candidate);
        }
    }
    throw new SchemaError("cannot find role Skills in the target repository or installation");
}
export function resolveSkillPath(repoRoot, skill) {
    const override = join(repoRoot, ".skills", skill, "SKILL.md");
    if (isFile(override))
        return resolve(override);
    const installed = join(packageRoot, "skills", skill, "SKILL.md");
    if (isFile(installed))
        return resolve(installed);
    throw new SchemaError(`configured skill does not exist: ${installed}`);
}
export function selectCoder(config, task, unavailable) {
    if (task.assignedAgent !== null) {
        const agent = config.agents[task.assignedAgent];
        if (!agent || agent.role !== "coder") {
            throw new SchemaError(`task ${task.id} is assigned to non-coder agent ${task.assignedAgent}`);
        }
        return unavailable.has(agent.identity) ? undefined : agent.identity;
    }
    const defaultCoder = config.agents.kd;
    if (defaultCoder?.role === "coder" && !unavailable.has("kd"))
        return "kd";
    return Object.values(config.agents).find((agent) => agent.role === "coder" && !unavailable.has(agent.identity))?.identity;
}
export function agentForRole(config, role) {
    const matches = Object.values(config.agents).filter((agent) => agent.role === role);
    if (matches.length !== 1) {
        throw new SchemaError(`expected exactly one configured ${role}, found ${matches.length}`);
    }
    return matches[0];
}
export function absoluteFrom(base, path) {
    return isAbsolute(path) ? resolve(path) : resolve(base, path);
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=config.js.map