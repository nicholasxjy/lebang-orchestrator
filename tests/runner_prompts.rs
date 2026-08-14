use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG},
    model::{CoderResult, Plan, ReviewResult, ReviewStatus, Task, ValidationResult},
    prompts::{coder_prompt, integrator_prompt, planner_prompt, tester_prompt},
    runner::{AgentRunRequest, AgentRunner},
    runtime::{AgentInvocation, AgentRuntime, HerdrLayout, RecordingRuntime, RuntimeError},
    store::RunStore,
};
use tempfile::tempdir;
use tokio::sync::Mutex;

struct MissingMarkerRuntime {
    invocations: Mutex<Vec<AgentInvocation>>,
}

#[async_trait]
impl AgentRuntime for MissingMarkerRuntime {
    async fn bootstrap(&self) -> Result<HerdrLayout, RuntimeError> {
        Ok(HerdrLayout {
            version: 1,
            repo_root: "/recording".into(),
            tab_id: "w1:t1".into(),
            coordinator_pane: "w1:p1".into(),
            agents: BTreeMap::new(),
            roster: Vec::new(),
        })
    }

    async fn invoke(&self, request: AgentInvocation) -> Result<String, RuntimeError> {
        let mut invocations = self.invocations.lock().await;
        invocations.push(request.clone());
        if invocations.len() == 1 {
            return Ok("task completed, but the result marker was omitted".into());
        }
        Ok(format!(
            "{}_BEGIN\n{{\"taskId\":\"T1\",\"status\":\"approved\",\"issues\":[]}}\n{}_END",
            request.marker, request.marker
        ))
    }
}

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

#[tokio::test]
async fn runner_resumes_the_agent_session_after_a_failed_attempt() {
    let root = tempdir().unwrap();
    let store = RunStore::new(root.path().join(".orchestrator"));
    let runtime = Arc::new(RecordingRuntime::new([]));
    runtime.push_error("agent stopped").await;
    runtime
        .push(serde_json::json!({
            "taskId": "T1", "status": "approved", "issues": []
        }))
        .await;
    let config = Config::parse(DEFAULT_CONFIG).unwrap();
    let reviewer = config.agent_for_role("reviewer").unwrap().clone();
    let runner = AgentRunner::new(root.path(), store, runtime.clone());
    let request = || AgentRunRequest {
        agent: reviewer.clone(),
        task_id: "T1".into(),
        cwd: root.path().into(),
        prompt: "Review the task".into(),
        state_transition: Some("reviewing -> approved".into()),
    };

    runner.run::<ReviewResult>(request()).await.unwrap_err();
    runner.run::<ReviewResult>(request()).await.unwrap();

    let invocations = runtime.invocations().await;
    assert!(!invocations[0].resume_session);
    assert!(invocations[1].resume_session);
}

#[tokio::test]
async fn marked_result_retry_only_asks_the_session_to_resend_its_result() {
    let root = tempdir().unwrap();
    let store = RunStore::new(root.path().join(".orchestrator"));
    let runtime = Arc::new(MissingMarkerRuntime {
        invocations: Mutex::new(Vec::new()),
    });
    let config = Config::parse(DEFAULT_CONFIG).unwrap();
    let reviewer = config.agent_for_role("reviewer").unwrap().clone();
    let runner = AgentRunner::new(root.path(), store, runtime.clone());
    let request = || AgentRunRequest {
        agent: reviewer.clone(),
        task_id: "T1".into(),
        cwd: root.path().into(),
        prompt: "Review the task from the beginning".into(),
        state_transition: Some("reviewing -> approved".into()),
    };

    let error = runner.run::<ReviewResult>(request()).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Herdr transcript did not contain a valid marked result")
    );
    runner.run::<ReviewResult>(request()).await.unwrap();

    let invocations = runtime.invocations.lock().await;
    assert!(invocations[1].resume_session);
    assert!(invocations[1].prompt.contains("Do not repeat the task"));
    assert!(!invocations[1].prompt.contains("from the beginning"));
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
