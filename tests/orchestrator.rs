use std::{collections::BTreeMap, fs, path::Path, process::Command, sync::Arc};

use async_trait::async_trait;
use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG, Role},
    model::{LifecycleResultStatus, TaskStatus},
    orchestrator::Orchestrator,
    runtime::{AgentInvocation, AgentPane, AgentRuntime, HerdrLayout, RuntimeError},
};
use tempfile::tempdir;
use tokio::sync::Mutex;

struct WorkflowRuntime {
    base_commit: String,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl AgentRuntime for WorkflowRuntime {
    async fn bootstrap(&self) -> Result<HerdrLayout, RuntimeError> {
        self.calls.lock().await.push("bootstrap".into());
        Ok(HerdrLayout {
            version: 1,
            repo_root: "/repo".into(),
            tab_id: "w1:t1".into(),
            coordinator_pane: "w1:p1".into(),
            agents: BTreeMap::from([(
                "lebang".into(),
                AgentPane {
                    pane_id: "w1:p2".into(),
                },
            )]),
            roster: Vec::new(),
        })
    }

    async fn invoke(&self, request: AgentInvocation) -> Result<String, RuntimeError> {
        self.calls.lock().await.push(request.agent.identity.clone());
        let value = match request.agent.role {
            Role::Planner => serde_json::json!({
                "goal": "Ship feature",
                "baseCommit": self.base_commit,
                "tasks": [{
                    "id": "T1", "title": "Ship feature", "type": "implementation",
                    "description": "Add a feature file", "acceptanceCriteria": ["feature exists"],
                    "dependencies": [], "workerRole": "coder", "assignedAgent": null,
                    "risk": "low", "status": "pending", "reviewAttempts": 0,
                    "branch": null, "worktree": null, "baseCommit": null, "commit": null
                }]
            }),
            Role::Coder => {
                fs::write(request.cwd.join("feature.txt"), "done\n").unwrap();
                fs::create_dir_all(request.cwd.join("tests")).unwrap();
                fs::write(request.cwd.join("tests/feature.txt"), "covered\n").unwrap();
                git(&request.cwd, &["add", "feature.txt", "tests/feature.txt"]);
                git(&request.cwd, &["commit", "-m", "T1"]);
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
            Role::Reviewer => serde_json::json!({
                "taskId": "T1", "status": "approved", "issues": []
            }),
            Role::Integrator => {
                let context: serde_json::Value =
                    serde_json::from_str(request.prompt.split_once("Context:\n").unwrap().1)
                        .unwrap();
                serde_json::json!({
                    "status": "completed", "summary": "integrated",
                    "integratedCommits": context["integratedCommits"],
                    "validations": context["validationEvidence"], "issues": []
                })
            }
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
async fn runs_the_complete_git_isolated_lifecycle() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base_commit = git(root.path(), &["rev-parse", "HEAD"]);
    let config = Config::parse(DEFAULT_CONFIG).unwrap();
    let runtime = Arc::new(WorkflowRuntime {
        base_commit,
        calls: Mutex::new(Vec::new()),
    });
    let orchestrator = Orchestrator::new(root.path(), config, runtime.clone());

    let plan = orchestrator.plan_goal("Ship feature").await.unwrap();
    assert_eq!(plan.tasks[0].assigned_agent.as_deref(), Some("kd"));
    let result = orchestrator.run().await.unwrap();

    assert_eq!(result.status, LifecycleResultStatus::Completed);
    assert_eq!(
        orchestrator.store.load_plan().unwrap().tasks[0].status,
        TaskStatus::Completed
    );
    let state = orchestrator.store.load_state().unwrap();
    assert!(
        state
            .integration_worktree
            .as_deref()
            .map(Path::new)
            .is_some_and(|path| path.join("feature.txt").is_file())
    );
    assert_eq!(
        runtime.calls.lock().await.as_slice(),
        ["bootstrap", "lebang", "kd", "westbrook", "curry", "duncan"]
    );
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
