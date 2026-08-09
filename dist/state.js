import { SchemaError, TaskStatuses } from "./models.js";
export const SatisfiedDependencyStatuses = new Set(["approved", "completed"]);
export const AllowedTransitions = {
    pending: new Set(["ready", "blocked", "failed", "invalidated"]),
    ready: new Set(["running", "blocked", "failed", "invalidated"]),
    running: new Set(["self_verifying", "interrupted", "blocked", "failed"]),
    self_verifying: new Set(["testing", "interrupted", "blocked", "failed"]),
    testing: new Set(["reviewing", "interrupted", "blocked", "failed"]),
    reviewing: new Set(["approved", "changes_requested", "interrupted", "blocked", "failed"]),
    changes_requested: new Set(["reworking", "blocked", "failed", "invalidated"]),
    reworking: new Set(["self_verifying", "testing", "interrupted", "blocked", "failed"]),
    approved: new Set(["integrating", "blocked", "invalidated"]),
    integrating: new Set(["completed", "interrupted", "blocked", "failed"]),
    interrupted: new Set([
        "ready", "reworking", "testing", "reviewing", "integrating", "blocked", "failed", "invalidated",
    ]),
    failed: new Set(["ready", "reworking", "blocked", "invalidated"]),
    blocked: new Set(["ready", "reworking", "failed", "invalidated"]),
    completed: new Set(),
    invalidated: new Set(),
};
export function readyTaskIds(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return tasks
        .filter((task) => task.status === "pending" &&
        task.dependencies.every((dependency) => SatisfiedDependencyStatuses.has(byId.get(dependency).status)))
        .map((task) => task.id)
        .sort();
}
export function transitionTask(store, task, targetStatus, agent, reason) {
    if (!TaskStatuses.includes(targetStatus)) {
        throw new SchemaError(`unsupported task status: ${targetStatus}`);
    }
    if (!AllowedTransitions[task.status].has(targetStatus)) {
        throw new SchemaError(`invalid task transition: ${task.status} -> ${targetStatus}`);
    }
    const previous = task.status;
    task.status = targetStatus;
    store.saveTask(task);
    store.appendHistory(task.id, {
        event: "state_transition",
        fromStatus: previous,
        toStatus: targetStatus,
        agent,
        reason,
    });
}
//# sourceMappingURL=state.js.map