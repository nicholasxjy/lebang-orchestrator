use std::path::Path;

use serde_json::{Value, json};

use crate::model::{CoderResult, Plan, ReviewResult, Task, TestResult, ValidationResult};

fn context(title: &str, value: Value) -> String {
    format!(
        "{title}\n{}",
        serde_json::to_string_pretty(&value).expect("prompt JSON")
    )
}

pub fn planner_prompt(
    goal: &str,
    base_commit: &str,
    repo_root: &Path,
    available_coders: &[String],
    max_workers: usize,
) -> String {
    context(
        "Inspect the repository and return exactly one Plan JSON object. Do not implement. Context:",
        json!({
            "goal": goal,
            "repository": repo_root,
            "baseCommit": base_commit,
            "availableCoders": available_coders,
            "maxWorkers": max_workers,
            "requirements": [
                "Inspect only instructions and files/tests directly relevant to this goal; do not inventory unrelated code or run builds.",
                "Prefer one task; split only for real dependencies or safe parallel ownership.",
                "Create a valid acyclic task DAG.",
                "Assign independent tasks to different availableCoders up to maxWorkers; use null only when lebang should choose the default coder.",
                "Use coder-owned tasks; tester, reviewer, and integrator are lifecycle gates.",
                "Give every task observable acceptance criteria and preserve the supplied baseCommit."
            ],
            "outputShape": {
                "goal": goal,
                "baseCommit": base_commit,
                "tasks": [{
                    "id": "T1",
                    "title": "...",
                    "type": "implementation | refactor | test | investigation | documentation | integration",
                    "description": "...",
                    "acceptanceCriteria": ["observable criterion"],
                    "dependencies": [],
                    "workerRole": "coder",
                    "assignedAgent": "configured coder identity or null",
                    "risk": "low | medium | high",
                    "status": "pending",
                    "reviewAttempts": 0,
                    "branch": null,
                    "worktree": null,
                    "baseCommit": null,
                    "commit": null
                }]
            }
        }),
    )
}

pub fn coder_prompt(
    goal: &str,
    task: &Task,
    worktree: &Path,
    dependency_results: Value,
    rework_issues: &[Value],
    identity: &str,
    role: &str,
) -> String {
    context(
        "Work only on this task and return exactly one CoderResult JSON object. Context:",
        json!({
            "goalSummary": goal,
            "agentIdentity": identity,
            "role": role,
            "task": task,
            "worktree": worktree,
            "branch": task.branch,
            "dependencyResults": dependency_results,
            "reworkIssues": rework_issues,
            "requirements": [
                "After committing, run git rev-parse HEAD and copy its full output exactly into commit; never expand an abbreviated hash.",
                "changedFiles and testsAdded must contain repository-relative paths. testsAdded must list changed test files, never test case names. testsRun must contain the exact commands executed."
            ],
            "resultContract": {
                "taskId": task.id,
                "status": "completed | blocked | failed",
                "summary": "...",
                "changedFiles": ["repository-relative changed file path"],
                "testsAdded": ["repository-relative changed test file path"],
                "testsRun": ["exact test command"],
                "testResult": "passed | failed | not_run",
                "commit": "commit hash or null",
                "blockers": []
            }
        }),
    )
}

pub fn tester_prompt(goal: &str, task: &Task, coder: &CoderResult, diff: &str) -> String {
    tester_rework_prompt(goal, task, coder, diff, &[])
}

pub fn tester_rework_prompt(
    goal: &str,
    task: &Task,
    coder: &CoderResult,
    diff: &str,
    issues: &[crate::model::Issue],
) -> String {
    context(
        "Independently test this task and return exactly one TestResult JSON object. Context:",
        json!({
            "goalSummary": goal,
            "task": task,
            "coderResult": coder,
            "gitDiff": diff,
            "reworkIssues": issues,
            "issueRouting": [
                "Use task scope for production defects and missing direct unit tests; these return to the original coder.",
                "Use test scope only for missing regression, edge, or integration coverage; these return to the tester.",
                "Use plan scope for decomposition, architecture, or cross-task defects; these return to the planner."
            ],
            "requirements": [
                "testsAdded must contain repository-relative paths for changed test files, never test case names. testsExecuted must contain the exact commands executed.",
                "After committing test changes, run git rev-parse HEAD and copy its full output exactly into commit; never return an abbreviated hash.",
                "Remove command-generated logs and other temporary artifacts before returning. Confirm git status --short is empty after any tester commit."
            ],
            "resultContract": {
                "taskId": task.id,
                "status": "passed | failed | blocked",
                "testsExecuted": ["exact test command"],
                "testsAdded": ["repository-relative changed test file path"],
                "failures": [{"description": "...", "reproduction": "...", "ownerTaskId": task.id}],
                "commit": "full tester commit hash or null"
            }
        }),
    )
}

pub fn reviewer_prompt(task: &Task, coder: &CoderResult, test: &TestResult, diff: &str) -> String {
    context(
        "Review this task and return exactly one ReviewResult JSON object. Context:",
        json!({
            "task": task,
            "coderResult": coder,
            "testResult": test,
            "gitDiff": diff,
            "resultContract": {
                "taskId": task.id,
                "status": "approved | changes_requested | replan_required",
                "issues": [{
                    "severity": "low | medium | high | critical",
                    "scope": "task | plan | test | integration",
                    "description": "...",
                    "expected": "...",
                    "ownerTaskId": task.id
                }]
            }
        }),
    )
}

pub fn integrator_prompt(
    goal: &str,
    plan: &Plan,
    integrated_commits: &[String],
    validations: &[ValidationResult],
    integration_branch: &str,
) -> String {
    context(
        "Confirm the integrated goal and return exactly one RunResult JSON object. Context:",
        json!({
            "goal": goal,
            "approvedTasks": plan.tasks,
            "integratedCommits": integrated_commits,
            "integrationBranch": integration_branch,
            "validationEvidence": validations,
            "requirements": [
                "Copy integratedCommits and validationEvidence exactly into the corresponding result fields, preserving order and contents.",
                "Validation commands have already been executed by the orchestrator. Do not add independently executed commands to validations."
            ],
            "resultContract": {
                "status": "completed | blocked | failed",
                "summary": "...",
                "integratedCommits": integrated_commits,
                "validations": validations,
                "issues": []
            }
        }),
    )
}

pub fn replan_prompt(
    plan: &Plan,
    review: &ReviewResult,
    repo_root: &Path,
    available_coders: &[String],
    max_workers: usize,
) -> String {
    context(
        "Replan the DAG and return exactly one complete Plan JSON object. Do not implement. Context:",
        json!({
            "repository": repo_root,
            "currentPlan": plan,
            "reviewResult": review,
            "availableCoders": available_coders,
            "maxWorkers": max_workers,
            "rules": [
                "Preserve approved or completed task evidence unchanged.",
                "Mark superseded tasks invalidated and include replacement tasks explicitly.",
                "Keep the original baseCommit and return an acyclic DAG.",
                "Record ownership changes only when intentional."
            ]
        }),
    )
}
