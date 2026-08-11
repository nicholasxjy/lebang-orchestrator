use std::sync::Arc;

use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG},
    model::{ReviewResult, ReviewStatus},
    prompts::planner_prompt,
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
