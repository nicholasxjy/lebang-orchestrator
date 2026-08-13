use std::{collections::BTreeMap, fs, path::Path, process::Command, sync::Arc};

use async_trait::async_trait;
use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG, Role},
    git::GitManager,
    model::{AgentRunRecord, LifecycleResultStatus, Plan, Risk, Task, TaskStatus, TaskType},
    orchestrator::Orchestrator,
    runtime::{AgentInvocation, AgentRuntime, HerdrLayout, RecordingRuntime, RuntimeError},
    store::{RunStore, utc_now},
};
use tempfile::tempdir;
use tokio::sync::Mutex;

struct MissingCoderMarkerRuntime {
    invocations: Mutex<Vec<AgentInvocation>>,
}

#[async_trait]
impl AgentRuntime for MissingCoderMarkerRuntime {
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
        let coder_attempt = invocations
            .iter()
            .filter(|invocation| invocation.agent.role == Role::Coder)
            .count();
        invocations.push(request.clone());
        let value = match request.agent.role {
            Role::Coder if coder_attempt == 0 => {
                fs::write(request.cwd.join("feature.txt"), "done\n")?;
                fs::create_dir_all(request.cwd.join("tests"))?;
                fs::write(request.cwd.join("tests/feature.txt"), "covered\n")?;
                git(&request.cwd, &["add", "feature.txt", "tests/feature.txt"]);
                git(&request.cwd, &["commit", "-m", "T1"]);
                return Ok("task completed without a marked result".into());
            }
            Role::Coder => {
                let commit = git(&request.cwd, &["rev-parse", "HEAD"]);
                serde_json::json!({
                    "taskId": "T1", "status": "completed", "summary": "done",
                    "changedFiles": ["feature.txt", "tests/feature.txt"],
                    "testsAdded": ["tests/feature.txt"], "testsRun": ["test -f feature.txt"],
                    "testResult": "passed", "commit": commit, "blockers": []
                })
            }
            Role::Tester => serde_json::json!({
                "taskId": "T1", "status": "passed", "testsExecuted": ["test -f feature.txt"],
                "testsAdded": [], "failures": [], "commit": null
            }),
            Role::Reviewer => {
                serde_json::json!({"taskId": "T1", "status": "approved", "issues": []})
            }
            Role::Integrator => {
                let context: serde_json::Value =
                    serde_json::from_str(request.prompt.split_once("Context:\n").unwrap().1)
                        .unwrap();
                serde_json::json!({
                    "status": "completed", "summary": "recovered",
                    "integratedCommits": context["integratedCommits"],
                    "validations": context["validationEvidence"], "issues": []
                })
            }
            Role::Planner => unreachable!(),
        };
        Ok(format!(
            "{}_BEGIN\n{}\n{}_END",
            request.marker,
            serde_json::to_string(&value).unwrap(),
            request.marker
        ))
    }
}

#[tokio::test]
async fn retry_recovers_a_coder_result_after_the_marker_was_omitted() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let store = RunStore::new(root.path().join(".orchestrator"));
    store
        .initialize(&Plan {
            goal: "Recover".into(),
            base_commit: base.clone(),
            tasks: vec![make_task()],
        })
        .unwrap();
    let runtime = Arc::new(MissingCoderMarkerRuntime {
        invocations: Mutex::new(Vec::new()),
    });
    let orchestrator = Orchestrator::new(
        root.path(),
        Config::parse(DEFAULT_CONFIG).unwrap(),
        runtime.clone(),
    );

    let first = orchestrator.run().await.unwrap();
    assert_eq!(first.status, LifecycleResultStatus::Failed);
    assert_eq!(
        orchestrator.store.load_plan().unwrap().tasks[0].status,
        TaskStatus::Failed
    );

    orchestrator.retry("T1").await.unwrap();
    let result = orchestrator.run().await.unwrap();

    assert_eq!(result.status, LifecycleResultStatus::Completed);
    let invocations = runtime.invocations.lock().await;
    let coders = invocations
        .iter()
        .filter(|invocation| invocation.agent.role == Role::Coder)
        .collect::<Vec<_>>();
    assert_eq!(coders.len(), 2);
    assert!(coders[1].resume_session);
    assert!(coders[1].prompt.contains("Do not repeat the task"));
    let worktree = orchestrator.store.load_plan().unwrap().tasks[0]
        .worktree
        .clone()
        .unwrap();
    assert_eq!(
        git(
            Path::new(&worktree),
            &["rev-list", "--count", &format!("{base}..HEAD")]
        ),
        "1"
    );
}

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
