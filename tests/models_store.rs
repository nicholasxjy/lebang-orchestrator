use std::{fs, path::PathBuf};

use lebang_orchestrator::{
    model::{CoderResult, Plan, ReviewResult, RunResult, TestResult},
    store::RunStore,
};
use tempfile::tempdir;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/python-orchestrator")
        .join(name)
}

#[test]
fn reads_python_and_typescript_era_camel_case_state() {
    let plan = Plan::parse_str(&fs::read_to_string(fixture("plan.json")).unwrap()).unwrap();
    assert_eq!(
        plan.tasks[0].acceptance_criteria,
        ["State remains compatible"]
    );
    assert_eq!(plan.tasks[0].assigned_agent.as_deref(), Some("kd"));

    let root = tempdir().unwrap();
    copy_fixture_tree(root.path());
    let store = RunStore::new(root.path());
    assert_eq!(store.load_plan().unwrap(), plan);
    assert_eq!(
        store.load_state().unwrap().run_id.to_string(),
        "12345678-1234-5678-1234-567812345678"
    );
}

#[test]
fn rejects_cycles_and_contradictory_results() {
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fixture("plan.json")).unwrap()).unwrap();
    value["tasks"][0]["dependencies"] = serde_json::json!(["T1"]);
    assert!(
        Plan::from_value(value)
            .unwrap_err()
            .to_string()
            .contains("cycle")
    );

    let coder: CoderResult = serde_json::from_value(serde_json::json!({
        "taskId": "T1", "status": "completed", "summary": "done",
        "changedFiles": ["src/lib.rs"], "testsAdded": ["tests/lib.rs"],
        "testsRun": ["cargo test"], "testResult": "passed", "commit": null,
        "blockers": []
    }))
    .unwrap();
    assert!(coder.validate().unwrap_err().to_string().contains("commit"));

    let test: TestResult = serde_json::from_value(serde_json::json!({
        "taskId": "T1", "status": "failed", "testsExecuted": ["cargo test"],
        "testsAdded": [], "failures": [], "commit": null
    }))
    .unwrap();
    assert!(test.validate().unwrap_err().to_string().contains("failure"));

    let review: ReviewResult = serde_json::from_value(serde_json::json!({
        "taskId": "T1", "status": "approved", "issues": [{
            "severity": "high", "scope": "task", "description": "bug",
            "expected": "no bug", "ownerTaskId": "T1"
        }]
    }))
    .unwrap();
    assert!(
        review
            .validate()
            .unwrap_err()
            .to_string()
            .contains("approved")
    );

    let run: RunResult = serde_json::from_value(serde_json::json!({
        "status": "completed", "summary": "done", "integratedCommits": ["abc"],
        "validations": [{"command": ["cargo", "test"], "exitCode": 1, "stdout": "", "stderr": "bad"}],
        "issues": []
    })).unwrap();
    assert!(
        run.validate()
            .unwrap_err()
            .to_string()
            .contains("validation")
    );
}

#[test]
fn exclusive_locks_recover_a_stale_owner() {
    let root = tempdir().unwrap();
    let store = RunStore::new(root.path());
    fs::create_dir_all(&store.locks_dir).unwrap();
    fs::write(
        store.locks_dir.join("T1.lock"),
        serde_json::to_vec(&serde_json::json!({
            "taskId": "T1",
            "pid": 2_147_483_647_u32,
            "nonce": "stale",
            "createdAt": "2026-08-01T00:00:00Z"
        }))
        .unwrap(),
    )
    .unwrap();

    let first = store.acquire_task_lock("T1").unwrap();
    assert!(
        store
            .acquire_task_lock("T1")
            .unwrap_err()
            .to_string()
            .contains("already locked")
    );
    drop(first);
    assert!(!store.locks_dir.join("T1.lock").exists());
    assert!(
        fs::read_to_string(store.history_dir.join("T1.jsonl"))
            .unwrap()
            .contains("stale_lock_removed")
    );
}

fn copy_fixture_tree(root: &std::path::Path) {
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(root.join("history")).unwrap();
    fs::copy(fixture("plan.json"), root.join("plan.json")).unwrap();
    fs::copy(fixture("state.json"), root.join("state.json")).unwrap();
    fs::copy(fixture("tasks/T1.json"), root.join("tasks/T1.json")).unwrap();
    fs::copy(fixture("history/run.jsonl"), root.join("history/run.jsonl")).unwrap();
}

#[test]
fn orchestration_lock_is_shared_across_store_instances_and_released_on_drop() {
    let root = tempdir().unwrap();
    let first_store = RunStore::new(root.path());
    let second_store = RunStore::new(root.path());
    let guard = first_store.acquire_run_lock().unwrap();
    assert!(
        second_store
            .acquire_run_lock()
            .unwrap_err()
            .to_string()
            .contains("already running")
    );
    drop(guard);
    second_store.acquire_run_lock().unwrap();
}

#[test]
fn unsafe_task_ids_are_rejected_before_any_files_are_written() {
    let root = tempdir().unwrap();
    let store = RunStore::new(root.path().join("store"));
    let plan = Plan::parse_str(&fs::read_to_string(fixture("plan.json")).unwrap()).unwrap();
    for id in ["../escaped", "/tmp/escaped", "..", "T1\nT2", "T1/T2"] {
        let mut plan = plan.clone();
        plan.tasks[0].id = id.into();
        assert!(
            store.initialize(&plan).is_err(),
            "accepted unsafe id {id:?}"
        );
        assert!(!store.root.join("plan.json").exists());
    }
}
