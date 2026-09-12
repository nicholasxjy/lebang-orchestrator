use async_trait::async_trait;
use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG, Role},
    model::{LifecycleResultStatus, Plan},
    orchestrator::Orchestrator,
    runtime::{AgentInvocation, AgentRuntime, HerdrLayout, RecordingRuntime, RuntimeError},
};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};
use tempfile::tempdir;
use tokio::sync::Mutex;

struct ReplanRuntime {
    base: String,
    coders: Mutex<Vec<String>>,
}

fn task(id: &str, owner: &str) -> Value {
    json!({"id":id, "title":id, "type":"documentation", "description":id,
        "acceptanceCriteria":["file exists"], "dependencies":[], "workerRole":"coder",
        "assignedAgent":owner, "risk":"low", "status":"pending", "reviewAttempts":0,
        "branch":null, "worktree":null, "baseCommit":null, "commit":null})
}

#[async_trait]
impl AgentRuntime for ReplanRuntime {
    async fn bootstrap(&self) -> Result<HerdrLayout, RuntimeError> {
        RecordingRuntime::new([]).bootstrap().await
    }
    async fn invoke(&self, request: AgentInvocation) -> Result<String, RuntimeError> {
        let context: Value =
            serde_json::from_str(request.prompt.split_once("Context:\n").unwrap().1).unwrap();
        let id = context["task"]["id"].as_str().unwrap_or("");
        let result = match request.agent.role {
            Role::Planner if context.get("currentPlan").is_none() => json!({
                "goal":"replan", "baseCommit":self.base, "tasks":[task("T1", "kd"), task("T2", "harden")]}),
            Role::Planner => {
                let mut plan = context["currentPlan"].clone();
                let tasks = plan["tasks"].as_array_mut().unwrap();
                let other = tasks.iter().find(|t| t["id"] == "T2").unwrap();
                assert_eq!(
                    other["status"], "approved",
                    "replan must wait for other running tasks and read fresh evidence"
                );
                tasks.iter_mut().find(|t| t["id"] == "T1").unwrap()["status"] =
                    json!("invalidated");
                let mut replacement = task("T3", "kd");
                replacement["dependencies"] = json!(["T2"]);
                tasks.push(replacement);
                plan
            }
            Role::Coder => {
                self.coders.lock().await.push(id.into());
                if id == "T2" {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                let file = format!("{id}.txt");
                fs::write(request.cwd.join(&file), id).unwrap();
                git(&request.cwd, &["add", &file]);
                git(&request.cwd, &["commit", "-m", id]);
                json!({"taskId":id, "status":"completed", "summary":id,
                    "changedFiles":[file], "testsAdded":[], "testsRun":["test -f file"],
                    "testResult":"passed", "commit":git(&request.cwd, &["rev-parse", "HEAD"]), "blockers":[]})
            }
            Role::Tester => {
                json!({"taskId":id, "status":"passed", "testsExecuted":["test -f file"], "testsAdded":[], "failures":[], "commit":null})
            }
            Role::Reviewer if id == "T1" => {
                json!({"taskId":id, "status":"replan_required", "issues":[{
                "severity":"high", "scope":"plan", "description":"T1 must depend on T2", "expected":"replace T1", "ownerTaskId":id}]})
            }
            Role::Reviewer => json!({"taskId":id, "status":"approved", "issues":[]}),
            Role::Integrator => {
                json!({"status":"completed", "summary":"done", "integratedCommits":context["integratedCommits"], "validations":context["validationEvidence"], "issues":[]})
            }
        };
        Ok(format!(
            "{}_BEGIN\n{}\n{}_END",
            request.marker, result, request.marker
        ))
    }
}

#[tokio::test]
async fn parallel_replanning_preserves_other_tasks_completed_during_the_batch() {
    let root = tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(root.path(), &["config", "user.name", "Test"]);
    git(root.path(), &["config", "user.email", "test@example.com"]);
    fs::write(root.path().join("README.md"), "base").unwrap();
    git(root.path(), &["add", "README.md"]);
    git(root.path(), &["commit", "-m", "base"]);
    let config = Config::parse(&format!("{}\n[agents.harden]\nrole=\"coder\"\nagent=\"claude\"\nmodel=\"sonnet\"\nmode=\"build\"\nthinking=\"medium\"\nskill=\"coder\"\n", DEFAULT_CONFIG.replace("max_workers = 1", "max_workers = 2"))).unwrap();
    let runtime = Arc::new(ReplanRuntime {
        base: git(root.path(), &["rev-parse", "HEAD"]),
        coders: Mutex::new(Vec::new()),
    });
    let orchestrator = Orchestrator::new(root.path(), config, runtime.clone());
    orchestrator.plan_goal("replan").await.unwrap();
    let result = orchestrator.run().await.unwrap();
    assert_eq!(result.status, LifecycleResultStatus::Completed);
    let calls = runtime.coders.lock().await;
    assert_eq!(calls.iter().filter(|id| *id == "T2").count(), 1);
    let plan: Plan = orchestrator.store.load_plan().unwrap();
    assert_eq!(plan.tasks.len(), 3);
    let integrated = orchestrator
        .store
        .load_state()
        .unwrap()
        .integration_worktree
        .unwrap();
    assert!(Path::new(&integrated).join("T2.txt").exists());
    assert!(Path::new(&integrated).join("T3.txt").exists());
    assert!(!Path::new(&integrated).join("T1.txt").exists());
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
