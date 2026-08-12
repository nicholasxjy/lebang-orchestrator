use std::sync::Arc;

use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG},
    model::{CoderResult, Plan, ReviewResult, ReviewStatus, Task, ValidationResult},
    prompts::{coder_prompt, integrator_prompt, planner_prompt, tester_prompt},
    runner::{AgentRunRequest, AgentRunner},
    runtime::RecordingRuntime,
    store::RunStore,
};
use tempfile::tempdir;

#[tokio::test]
async fn runner_persists_marked_results_and_prompt_context() {
    let root = tempdir().unwrap();
    let store = RunStore::new(root.path().join(".orchestrator"));
    let runtime = Arc::new(RecordingRuntime::new([serde_json::json!({
        "taskId": "T1", "status": "approved", "issues": []
    })]));
    let config = Config::parse(DEFAULT_CONFIG).unwrap();
    let reviewer = config.agent_for_role("reviewer").unwrap().clone();
    let runner = AgentRunner::new(root.path(), store.clone(), runtime.clone());

    let (result, artifact) = runner
        .run::<ReviewResult>(AgentRunRequest {
            agent: reviewer,
            task_id: "T1".into(),
            cwd: root.path().into(),
            prompt: "Review the task".into(),
            state_transition: Some("reviewing -> approved".into()),
        })
        .await
        .unwrap();

    assert_eq!(result.status, ReviewStatus::Approved);
    assert!(artifact.record_path.is_file());
    assert!(artifact.log_path.is_file());
    let record: serde_json::Value = store.read_json(&artifact.record_path).unwrap();
    assert_eq!(record["agent"], "curry");
    assert_eq!(record["structuredResult"]["status"], "approved");
    assert!(
        runtime.invocations().await[0]
            .prompt
            .contains("Review the task")
    );
}

#[test]
fn planner_prompt_names_coders_and_preserves_the_base_commit() {
    let prompt = planner_prompt(
        "Add retries",
        "0123456789abcdef",
        std::path::Path::new("/repo"),
        &["kd".into(), "harden".into()],
        2,
    );
    assert!(prompt.contains("0123456789abcdef"));
    assert!(prompt.contains("kd"));
    assert!(prompt.contains("harden"));
    assert!(prompt.contains("acceptanceCriteria"));
    assert!(prompt.contains("exactly one Plan JSON object"));
}

#[test]
fn coder_prompt_defines_file_path_evidence() {
    let task: Task = serde_json::from_value(serde_json::json!({
        "id": "T1", "title": "Feature", "type": "implementation",
        "description": "Implement it", "acceptanceCriteria": ["It works"],
        "dependencies": [], "workerRole": "coder", "assignedAgent": "kd",
        "risk": "low", "status": "running", "reviewAttempts": 0,
        "branch": "agent/kd/T1", "worktree": "/repo/.worktrees/T1-kd",
        "baseCommit": "0123456789abcdef", "commit": null
    }))
    .unwrap();
    let prompt = coder_prompt(
        "Ship feature",
        &task,
        std::path::Path::new("/repo/.worktrees/T1-kd"),
        serde_json::json!({}),
        &[],
        "kd",
        "coder",
    );

    assert!(prompt.contains("testsAdded must contain repository-relative paths"));
    assert!(prompt.contains("never test case names"));
}

#[test]
fn tester_prompt_defines_file_path_evidence() {
    let task: Task = serde_json::from_value(serde_json::json!({
        "id": "T1", "title": "Feature", "type": "implementation",
        "description": "Implement it", "acceptanceCriteria": ["It works"],
        "dependencies": [], "workerRole": "coder", "assignedAgent": "kd",
        "risk": "low", "status": "testing", "reviewAttempts": 0,
        "branch": "agent/kd/T1", "worktree": "/repo/.worktrees/T1-kd",
        "baseCommit": "0123456789abcdef", "commit": "fedcba9876543210"
    }))
    .unwrap();
    let coder: CoderResult = serde_json::from_value(serde_json::json!({
        "taskId": "T1", "status": "completed", "summary": "done",
        "changedFiles": ["src/lib.rs", "tests/lib.rs"],
        "testsAdded": ["tests/lib.rs"], "testsRun": ["cargo test"],
        "testResult": "passed", "commit": "fedcba9876543210", "blockers": []
    }))
    .unwrap();
    let prompt = tester_prompt("Ship feature", &task, &coder, "diff");

    assert!(prompt.contains("testsAdded must contain repository-relative paths"));
    assert!(prompt.contains("never test case names"));
    assert!(prompt.contains("full output exactly into commit"));
    assert!(prompt.contains("git status --short is empty"));
}

#[test]
fn integrator_prompt_requires_exact_orchestrator_evidence() {
    let plan: Plan = serde_json::from_value(serde_json::json!({
        "goal": "Ship feature", "baseCommit": "0123456789abcdef", "tasks": []
    }))
    .unwrap();
    let validations: Vec<ValidationResult> = serde_json::from_value(serde_json::json!([{
        "command": ["git", "diff", "--check"], "exitCode": 0,
        "stdout": "", "stderr": ""
    }]))
    .unwrap();
    let prompt = integrator_prompt(
        "Ship feature",
        &plan,
        &["fedcba9876543210".into()],
        &validations,
        "orchestrator/run/integration",
    );

    assert!(prompt.contains("Copy integratedCommits and validationEvidence exactly"));
    assert!(prompt.contains("Do not add independently executed commands to validations"));
}
