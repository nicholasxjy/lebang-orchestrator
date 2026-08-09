import { type Task } from "./models.js";
import type { RunStore } from "./persistence.js";
export declare const SatisfiedDependencyStatuses: Set<string>;
export declare const AllowedTransitions: Record<Task["status"], Set<Task["status"]>>;
export declare function readyTaskIds(tasks: Task[]): string[];
export declare function transitionTask(store: RunStore, task: Task, targetStatus: Task["status"], agent: string, reason: string): void;
