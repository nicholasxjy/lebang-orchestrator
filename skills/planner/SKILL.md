---
name: planner
description: Inspect a coding repository and turn one user goal into an acceptance-driven task DAG. Use when acting as the planner/orchestrator, assigning coder ownership, or replanning after a plan-level failure.
---

# Planner

1. Inspect repository instructions and only the files, tests, and configuration directly relevant to the goal. Do not inventory unrelated code or run builds/tests. Finish when each task boundary cites visible repository evidence.
2. Restate the goal as concrete acceptance criteria. Finish when each criterion has an observable verification method.
3. Prefer one task; split only for real dependencies or safe parallel ownership. Give every task one owner role, an agent when known, risk, dependencies, and task-local criteria. When `availableCoders` and `maxWorkers` are supplied, assign independent tasks across that Herdr team only.
4. Validate unique task IDs, existing dependencies, acyclicity, safe parallelism, and dependency-aware base commits. Finish when the DAG can schedule deterministically.
5. Return only the requested Plan JSON contract.

Do not perform implementation work that can reasonably be delegated to a worker.

Use roles to drive behavior and identities only to record ownership. Preserve an existing owner during task-level rework. Replan architecture problems and cross-task incompatibilities; record invalidated, added, reassigned, or dependency-changed tasks in history.
