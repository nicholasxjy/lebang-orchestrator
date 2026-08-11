use std::{fs, path::Path, process::Command, sync::Arc};

use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG},
    git::GitManager,
    model::{AgentRunRecord, LifecycleResultStatus, Plan, Risk, Task, TaskStatus, TaskType},
    orchestrator::Orchestrator,
    runtime::RecordingRuntime,
    store::{RunStore, utc_now},
};
use tempfile::tempdir;

#[tokio::test]
async fn resume_recovers_a_committed_coder_result_and_finishes() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let store = RunStore::new(root.path().join(".orchestrator"));
    let mut task = make_task();
    store
        .initialize(&Plan {
            goal: "Recover".into(),
            base_commit: base.clone(),
            tasks: vec![task.clone()],
        })
        .unwrap();
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let snapshot = task.clone();
    let worktree = manager
        .prepare_task_worktree(&mut task, &[snapshot], &base)
        .await
        .unwrap();
    fs::write(worktree.join("feature.txt"), "done\n").unwrap();
    fs::create_dir_all(worktree.join("tests")).unwrap();
    fs::write(worktree.join("tests/feature.txt"), "covered\n").unwrap();
    git(&worktree, &["add", "feature.txt", "tests/feature.txt"]);
    git(&worktree, &["commit", "-m", "T1"]);
    let commit = git(&worktree, &["rev-parse", "HEAD"]);
    task.status = TaskStatus::Running;
    store.save_task(&task).unwrap();

    let coder_result = serde_json::json!({
        "taskId": "T1", "status": "completed", "summary": "done",
        "changedFiles": ["feature.txt", "tests/feature.txt"],
        "testsAdded": ["tests/feature.txt"], "testsRun": ["test -f feature.txt"],
        "testResult": "passed", "commit": commit, "blockers": []
    });
    let now = utc_now();
    store
        .write_result(
            "T1",
            "coder",
            "crashed",
            &AgentRunRecord {
                run_id: "crashed".into(),
                task_id: "T1".into(),
                agent: "kd".into(),
                role: "coder".into(),
                model: "gpt-5.6-sol".into(),
                cwd: worktree.display().to_string(),
                start_time: now.clone(),
                end_time: now,
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
                structured_result: Some(coder_result),
                state_transition: Some("running -> self_verifying".into()),
            },
        )
        .unwrap();

    let runtime = Arc::new(RecordingRuntime::new([
        serde_json::json!({
            "taskId": "T1", "status": "passed", "testsExecuted": ["test -f feature.txt"],
            "testsAdded": [], "failures": [], "commit": null
        }),
        serde_json::json!({"taskId": "T1", "status": "approved", "issues": []}),
        serde_json::json!({
            "status": "completed", "summary": "recovered", "integratedCommits": [commit],
            "validations": [{
                "command": ["git", "diff", "--check"], "exitCode": 0,
                "stdout": "", "stderr": ""
            }],
            "issues": []
        }),
    ]));
    let orchestrator =
        Orchestrator::new(root.path(), Config::parse(DEFAULT_CONFIG).unwrap(), runtime);
    let result = orchestrator.resume().await.unwrap();

    assert_eq!(result.status, LifecycleResultStatus::Completed);
    assert_eq!(
        orchestrator.store.load_plan().unwrap().tasks[0].status,
        TaskStatus::Completed
    );
    assert!(
        fs::read_to_string(orchestrator.store.history_dir.join("T1.jsonl"))
            .unwrap()
            .contains("recovered committed coder result")
    );
}

fn make_task() -> Task {
    Task {
        id: "T1".into(),
        title: "Recover".into(),
        task_type: TaskType::Implementation,
        description: "Recover it".into(),
        acceptance_criteria: vec!["It works".into()],
        dependencies: vec![],
        worker_role: "coder".into(),
        assigned_agent: Some("kd".into()),
        risk: Risk::Medium,
        status: TaskStatus::Pending,
        review_attempts: 0,
        branch: None,
        worktree: None,
        base_commit: None,
        commit: None,
    }
}

fn init_repo(path: &Path) {
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.name", "Test User"]);
    git(path, &["config", "user.email", "test@example.com"]);
    fs::write(path.join("README.md"), "base\n").unwrap();
    git(path, &["add", "README.md"]);
    git(path, &["commit", "-m", "base"]);
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
