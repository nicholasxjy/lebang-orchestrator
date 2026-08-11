use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use futures::future::join_all;
use serde_json::{Map, Value, json};
use thiserror::Error;
use tokio::process::Command;

use crate::{
    config::{AgentConfig, Config, Role},
    git::{GitError, GitManager, is_test_support_path},
    model::{
        CoderResult, Issue, IssueScope, LifecycleResultStatus, Plan, ReviewResult, ReviewStatus,
        RunResult, RunStatus, Severity, Task, TaskStatus, TaskType, TestResult, TestStatus,
        ValidationResult,
    },
    prompts::{
        coder_prompt, integrator_prompt, planner_prompt, replan_prompt, reviewer_prompt,
        tester_prompt,
    },
    runner::{AgentRunRequest, AgentRunner, RunnerError},
    runtime::{AgentRuntime, HerdrRuntime, RuntimeError},
    state::{allowed_transition, ready_task_ids, transition_task},
    store::{RunStore, StoreError, utc_now},
};

#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Config(#[from] crate::config::ConfigError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Model(#[from] crate::model::ModelError),
    #[error(transparent)]
    Runner(#[from] RunnerError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("cannot execute validation command: {0}")]
    Process(#[from] std::io::Error),
}

pub struct Orchestrator {
    pub repo_root: PathBuf,
    pub config: Config,
    pub store: RunStore,
    pub git: GitManager,
    runner: AgentRunner,
    runtime: Arc<dyn AgentRuntime>,
}

impl Orchestrator {
    pub fn production(repo_root: impl AsRef<Path>, config: Config) -> Self {
        let repo_root = absolute(repo_root.as_ref());
        let runtime = Arc::new(HerdrRuntime::new(&repo_root, config.clone()));
        Self::new(repo_root, config, runtime)
    }

    pub fn new(
        repo_root: impl AsRef<Path>,
        config: Config,
        runtime: Arc<dyn AgentRuntime>,
    ) -> Self {
        let repo_root = absolute(repo_root.as_ref());
        let store = RunStore::new(repo_root.join(".orchestrator"));
        let runner = AgentRunner::new(&repo_root, store.clone(), runtime.clone());
        Self {
            git: GitManager::new(&repo_root, repo_root.join(".worktrees")),
            repo_root,
            config,
            store,
            runner,
            runtime,
        }
    }

    pub async fn plan_goal(&self, goal: &str) -> Result<Plan, OrchestratorError> {
        if goal.trim().is_empty() {
            return Err(OrchestratorError::Invalid("goal must not be empty".into()));
        }
        if self.store.root.join("plan.json").exists() {
            return Err(OrchestratorError::Invalid(format!(
                "an orchestration plan already exists in {}",
                self.store.root.display()
            )));
        }
        let base_commit = self.git.current_commit(&self.repo_root).await?;
        self.runtime.bootstrap().await?;
        let planner = self.agent_for(Role::Planner)?.clone();
        let coders = self
            .config
            .coders()
            .into_iter()
            .map(|agent| agent.identity.clone())
            .collect::<Vec<_>>();
        let (mut plan, _) = self
            .runner
            .run::<Plan>(AgentRunRequest {
                agent: planner,
                task_id: "PLAN".into(),
                cwd: self.repo_root.clone(),
                prompt: planner_prompt(
                    goal,
                    &base_commit,
                    &self.repo_root,
                    &coders,
                    self.config.max_workers,
                ),
                state_transition: Some("unplanned -> planned".into()),
            })
            .await?;
        if plan.base_commit != base_commit {
            return Err(OrchestratorError::Invalid(format!(
                "planner returned baseCommit {}, expected {base_commit}",
                plan.base_commit
            )));
        }
        self.assign_unowned_tasks(&mut plan.tasks);
        self.validate_planned_tasks(&plan.tasks)?;
        plan.validate()?;
        self.store.initialize(&plan)?;
        Ok(plan)
    }

    pub async fn run(&self) -> Result<RunResult, OrchestratorError> {
        if !self.store.root.join("plan.json").exists()
            || !self.store.root.join("state.json").exists()
        {
            return Err(OrchestratorError::Invalid(
                "no persisted plan; run lebang plan GOAL first".into(),
            ));
        }
        let mut state = self.store.load_state()?;
        if state.status == RunStatus::Completed
            && let Some(result) = state.result.as_ref()
        {
            let result: RunResult = serde_json::from_value(result.clone())
                .map_err(|error| OrchestratorError::Invalid(error.to_string()))?;
            result.validate()?;
            return Ok(result);
        }
        state.status = RunStatus::Running;
        self.store.save_state(&state)?;
        let planner = self.agent_for(Role::Planner)?.identity.clone();

        loop {
            let mut plan = self.store.load_plan()?;
            let active = plan
                .tasks
                .iter()
                .filter(|task| task.status != TaskStatus::Invalidated)
                .collect::<Vec<_>>();
            if !active.is_empty()
                && active
                    .iter()
                    .all(|task| matches!(task.status, TaskStatus::Approved | TaskStatus::Completed))
            {
                return self.integrate().await;
            }
            for task_id in ready_task_ids(&plan.tasks) {
                let task = find_task_mut(&mut plan, &task_id)?;
                transition_task(
                    &self.store,
                    task,
                    TaskStatus::Ready,
                    &planner,
                    "all dependencies are approved",
                )?;
            }
            plan = self.store.load_plan()?;
            let mut ready = plan
                .tasks
                .iter()
                .filter(|task| task.status == TaskStatus::Ready)
                .collect::<Vec<_>>();
            ready.sort_by(|left, right| left.id.cmp(&right.id));
            if !ready.is_empty() {
                let mut owners = HashSet::new();
                let mut batch = Vec::new();
                for task in ready {
                    if let Some(owner) = &task.assigned_agent
                        && !owners.insert(owner.clone())
                    {
                        continue;
                    }
                    batch.push(task.id.clone());
                    if batch.len() >= self.config.max_workers {
                        break;
                    }
                }
                join_all(batch.iter().map(|task_id| self.execute_task(task_id))).await;
                continue;
            }
            return self.terminal_result(&plan);
        }
    }

    async fn execute_task(&self, task_id: &str) {
        if let Err(error) = self.execute_task_inner(task_id).await {
            let Ok(plan) = self.store.load_plan() else {
                return;
            };
            let Some(mut task) = plan.tasks.into_iter().find(|task| task.id == task_id) else {
                return;
            };
            let agent = task
                .assigned_agent
                .clone()
                .or_else(|| {
                    self.agent_for(Role::Planner)
                        .ok()
                        .map(|agent| agent.identity.clone())
                })
                .unwrap_or_else(|| "lebang".into());
            if allowed_transition(task.status, TaskStatus::Failed) {
                let _ = transition_task(
                    &self.store,
                    &mut task,
                    TaskStatus::Failed,
                    &agent,
                    &error.to_string(),
                );
            } else {
                let _ = self.store.append_history(
                    task_id,
                    &json!({
                        "event": "execution_error", "agent": agent,
                        "reason": error.to_string(),
                    }),
                );
            }
        }
    }

    async fn execute_task_inner(&self, task_id: &str) -> Result<(), OrchestratorError> {
        let _lock = self.store.acquire_task_lock(task_id)?;
        let plan = self.store.load_plan()?;
        let mut task = find_task(&plan, task_id)?.clone();
        if task.status != TaskStatus::Ready {
            return Err(OrchestratorError::Invalid(format!(
                "task {} is not ready: {}",
                task.id,
                task.status.as_str()
            )));
        }
        let owner = task.assigned_agent.as_ref().ok_or_else(|| {
            OrchestratorError::Invalid(format!("task {} has no assigned agent", task.id))
        })?;
        let coder = self
            .config
            .agents
            .get(owner)
            .ok_or_else(|| OrchestratorError::Invalid(format!("unknown agent {owner}")))?
            .clone();
        let worktree = self
            .git
            .prepare_task_worktree(&mut task, &plan.tasks, &plan.base_commit)
            .await?;
        self.store.save_task(&task)?;
        transition_task(
            &self.store,
            &mut task,
            TaskStatus::Running,
            &coder.identity,
            "coder execution started",
        )?;
        let coder_result = self
            .run_coder(&plan, &mut task, &worktree, &coder, &[])
            .await?;
        self.test_and_review(&plan, &mut task, &worktree, &coder, coder_result)
            .await
    }

    async fn run_coder(
        &self,
        plan: &Plan,
        task: &mut Task,
        worktree: &Path,
        coder: &AgentConfig,
        rework_issues: &[Value],
    ) -> Result<CoderResult, OrchestratorError> {
        let dependency_results = task
            .dependencies
            .iter()
            .filter_map(|id| plan.tasks.iter().find(|task| &task.id == id))
            .map(|task| {
                (
                    task.id.clone(),
                    json!({"commit": task.commit, "status": task.status}),
                )
            })
            .collect::<Map<_, _>>();
        let (result, _) = self
            .runner
            .run::<CoderResult>(AgentRunRequest {
                agent: coder.clone(),
                task_id: task.id.clone(),
                cwd: worktree.to_path_buf(),
                prompt: coder_prompt(
                    &plan.goal,
                    task,
                    worktree,
                    Value::Object(dependency_results),
                    rework_issues,
                    &coder.identity,
                    coder.role.as_str(),
                ),
                state_transition: Some(format!("{} -> self_verifying", task.status.as_str())),
            })
            .await?;
        if result.task_id != task.id {
            return Err(OrchestratorError::Invalid(format!(
                "coder returned taskId {}, expected {}",
                result.task_id, task.id
            )));
        }
        if result.status != LifecycleResultStatus::Completed {
            let target = if result.status == LifecycleResultStatus::Blocked {
                TaskStatus::Blocked
            } else {
                TaskStatus::Failed
            };
            let reason = if result.summary.is_empty() {
                result.blockers.join("; ")
            } else {
                result.summary.clone()
            };
            transition_task(&self.store, task, target, &coder.identity, &reason)?;
            return Ok(result);
        }
        self.accept_coder_evidence(task, worktree, &result).await?;
        transition_task(
            &self.store,
            task,
            TaskStatus::SelfVerifying,
            &coder.identity,
            "coder result verified",
        )?;
        transition_task(
            &self.store,
            task,
            TaskStatus::Testing,
            &coder.identity,
            "coder self-verification passed",
        )?;
        Ok(result)
    }

    async fn accept_coder_evidence(
        &self,
        task: &mut Task,
        worktree: &Path,
        result: &CoderResult,
    ) -> Result<(), OrchestratorError> {
        if result.task_id != task.id || result.status != LifecycleResultStatus::Completed {
            return Err(OrchestratorError::Invalid(
                "coder evidence is not completed for this task".into(),
            ));
        }
        let head = self.git.current_commit(worktree).await?;
        if result.commit.as_deref() != Some(&head) {
            return Err(OrchestratorError::Invalid(format!(
                "coder returned commit {:?}, but worktree HEAD is {head}",
                result.commit
            )));
        }
        if !self.git.head_is_clean(worktree).await? {
            return Err(OrchestratorError::Invalid(
                "coder returned with uncommitted worktree changes".into(),
            ));
        }
        task.commit = Some(head);
        let changed_files = self.git.changed_files(task).await?;
        if !same_set(&changed_files, &result.changed_files) {
            return Err(OrchestratorError::Invalid(
                "coder changedFiles does not match the committed task diff".into(),
            ));
        }
        if matches!(
            task.task_type,
            TaskType::Implementation | TaskType::Refactor
        ) && result.tests_added.is_empty()
        {
            return Err(OrchestratorError::Invalid(
                "production task completed without direct task-local tests".into(),
            ));
        }
        if !result
            .tests_added
            .iter()
            .all(|path| changed_files.contains(path))
        {
            return Err(OrchestratorError::Invalid(
                "coder testsAdded contains files outside the task diff".into(),
            ));
        }
        if result.tests_run.is_empty() {
            return Err(OrchestratorError::Invalid(
                "coder completed without reporting self-test commands".into(),
            ));
        }
        self.store.save_task(task)?;
        Ok(())
    }

    async fn run_tester(
        &self,
        plan: &Plan,
        task: &mut Task,
        worktree: &Path,
        coder: &CoderResult,
    ) -> Result<TestResult, OrchestratorError> {
        let tester = self.agent_for(Role::Tester)?.clone();
        let before = task.commit.clone().ok_or_else(|| {
            OrchestratorError::Invalid(format!("task {} has no coder commit", task.id))
        })?;
        let diff = self.git.task_diff(task).await?;
        let (result, _) = self
            .runner
            .run::<TestResult>(AgentRunRequest {
                agent: tester.clone(),
                task_id: task.id.clone(),
                cwd: worktree.to_path_buf(),
                prompt: tester_prompt(&plan.goal, task, coder, &diff),
                state_transition: Some("testing -> reviewing".into()),
            })
            .await?;
        if result.task_id != task.id {
            return Err(OrchestratorError::Invalid(format!(
                "tester returned taskId {}, expected {}",
                result.task_id, task.id
            )));
        }
        if result.tests_executed.is_empty() {
            return Err(OrchestratorError::Invalid(
                "tester returned without independent test commands".into(),
            ));
        }
        let after = self.git.current_commit(worktree).await?;
        match &result.commit {
            None => {
                if after != before || !self.git.head_is_clean(worktree).await? {
                    return Err(OrchestratorError::Invalid(
                        "tester changed the worktree without returning a commit".into(),
                    ));
                }
            }
            Some(commit) => {
                if commit != &after || !self.git.head_is_clean(worktree).await? {
                    return Err(OrchestratorError::Invalid(
                        "tester commit does not match a clean worktree HEAD".into(),
                    ));
                }
                let changed = self.git.changed_files_between(&before, &after).await?;
                if !changed.iter().all(|path| result.tests_added.contains(path)) {
                    return Err(OrchestratorError::Invalid(
                        "tester commit contains files not declared in testsAdded".into(),
                    ));
                }
                let production = changed
                    .iter()
                    .filter(|path| !is_test_support_path(path))
                    .collect::<Vec<_>>();
                if !production.is_empty() {
                    return Err(OrchestratorError::Invalid(format!(
                        "tester modified production paths: {}",
                        production
                            .into_iter()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
                task.commit = Some(after);
                self.store.save_task(task)?;
            }
        }
        if result.status == TestStatus::Blocked {
            transition_task(
                &self.store,
                task,
                TaskStatus::Blocked,
                &tester.identity,
                "independent testing blocked",
            )?;
        } else {
            transition_task(
                &self.store,
                task,
                TaskStatus::Reviewing,
                &tester.identity,
                &format!("independent testing {:?}", result.status).to_lowercase(),
            )?;
        }
        Ok(result)
    }

    async fn run_reviewer(
        &self,
        task: &Task,
        worktree: &Path,
        coder: &CoderResult,
        test: &TestResult,
    ) -> Result<ReviewResult, OrchestratorError> {
        let reviewer = self.agent_for(Role::Reviewer)?.clone();
        let (result, _) = self
            .runner
            .run::<ReviewResult>(AgentRunRequest {
                agent: reviewer,
                task_id: task.id.clone(),
                cwd: worktree.to_path_buf(),
                prompt: reviewer_prompt(task, coder, test, &self.git.task_diff(task).await?),
                state_transition: Some("reviewing -> decision".into()),
            })
            .await?;
        if result.task_id != task.id {
            return Err(OrchestratorError::Invalid(format!(
                "reviewer returned taskId {}, expected {}",
                result.task_id, task.id
            )));
        }
        Ok(result)
    }

    async fn test_and_review(
        &self,
        plan: &Plan,
        task: &mut Task,
        worktree: &Path,
        coder: &AgentConfig,
        mut coder_result: CoderResult,
    ) -> Result<(), OrchestratorError> {
        while task.status == TaskStatus::Testing {
            let test = self.run_tester(plan, task, worktree, &coder_result).await?;
            if task.status != TaskStatus::Reviewing {
                return Ok(());
            }
            let review = self
                .run_reviewer(task, worktree, &coder_result, &test)
                .await?;
            if review.status == ReviewStatus::Approved {
                transition_task(
                    &self.store,
                    task,
                    TaskStatus::Approved,
                    &self.agent_for(Role::Reviewer)?.identity,
                    "review approved",
                )?;
                return Ok(());
            }
            task.review_attempts += 1;
            self.store.save_task(task)?;
            if task.review_attempts >= self.config.max_review_attempts {
                transition_task(
                    &self.store,
                    task,
                    TaskStatus::Blocked,
                    &self.agent_for(Role::Planner)?.identity,
                    "review attempt limit reached",
                )?;
                return Ok(());
            }
            if review.status == ReviewStatus::ReplanRequired {
                self.handle_replan(plan, &review).await?;
                return Ok(());
            }
            transition_task(
                &self.store,
                task,
                TaskStatus::ChangesRequested,
                &self.agent_for(Role::Reviewer)?.identity,
                "review requested task-level changes",
            )?;
            let test_only = !review.issues.is_empty()
                && review
                    .issues
                    .iter()
                    .all(|issue| issue.scope == IssueScope::Test);
            if test_only {
                let tester = self.agent_for(Role::Tester)?;
                transition_task(
                    &self.store,
                    task,
                    TaskStatus::Reworking,
                    &tester.identity,
                    "test-only rework assigned to tester",
                )?;
                transition_task(
                    &self.store,
                    task,
                    TaskStatus::Testing,
                    &tester.identity,
                    "tester rework ready for independent execution",
                )?;
                continue;
            }
            transition_task(
                &self.store,
                task,
                TaskStatus::Reworking,
                &coder.identity,
                "returned to original coder",
            )?;
            let issues = review
                .issues
                .iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .expect("issues serialize");
            coder_result = self.run_coder(plan, task, worktree, coder, &issues).await?;
        }
        Ok(())
    }

    pub async fn retry(&self, task_id: &str) -> Result<(), OrchestratorError> {
        let plan = self.store.load_plan()?;
        let mut task = find_task(&plan, task_id)?.clone();
        if !matches!(
            task.status,
            TaskStatus::Failed | TaskStatus::Blocked | TaskStatus::Interrupted
        ) {
            return Err(OrchestratorError::Invalid(format!(
                "task {} cannot be retried from status {}",
                task.id,
                task.status.as_str()
            )));
        }
        if task.status == TaskStatus::Blocked
            && task.review_attempts >= self.config.max_review_attempts
        {
            return Err(OrchestratorError::Invalid(format!(
                "task {} exhausted review attempts; replan or reassign it",
                task.id
            )));
        }
        let by_id = plan
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task))
            .collect::<HashMap<_, _>>();
        let unsatisfied = task
            .dependencies
            .iter()
            .filter(|id| {
                !matches!(
                    by_id[id.as_str()].status,
                    TaskStatus::Approved | TaskStatus::Completed
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        if !unsatisfied.is_empty() {
            return Err(OrchestratorError::Invalid(format!(
                "task {} has unsatisfied dependencies: {}",
                task.id,
                unsatisfied.join(", ")
            )));
        }
        let mut state = self.store.load_state()?;
        state.status = RunStatus::Running;
        state.result = None;
        self.store.save_state(&state)?;
        let mut coder_result = self
            .store
            .latest_structured_result::<CoderResult>(&task.id, "coder")?;
        if let (Some(result), Some(worktree)) = (&coder_result, task.worktree.clone())
            && self
                .accept_coder_evidence(&mut task, Path::new(&worktree), result)
                .await
                .is_err()
        {
            coder_result = None;
        }
        if let (Some(result), Some(worktree)) = (coder_result, task.worktree.clone()) {
            let tester = self.agent_for(Role::Tester)?;
            if matches!(task.status, TaskStatus::Failed | TaskStatus::Blocked) {
                transition_task(
                    &self.store,
                    &mut task,
                    TaskStatus::Reworking,
                    &tester.identity,
                    "retry recovered committed coder evidence",
                )?;
            }
            transition_task(
                &self.store,
                &mut task,
                TaskStatus::Testing,
                &tester.identity,
                "retry resumed independent testing",
            )?;
            let owner = task
                .assigned_agent
                .as_ref()
                .and_then(|id| self.config.agents.get(id))
                .ok_or_else(|| OrchestratorError::Invalid("task has no assigned coder".into()))?
                .clone();
            self.test_and_review(&plan, &mut task, Path::new(&worktree), &owner, result)
                .await?;
        } else {
            let agent = task.assigned_agent.clone().unwrap_or_else(|| {
                self.agent_for(Role::Planner)
                    .expect("planner")
                    .identity
                    .clone()
            });
            transition_task(
                &self.store,
                &mut task,
                TaskStatus::Ready,
                &agent,
                "explicit retry requested",
            )?;
        }
        Ok(())
    }

    pub async fn review_task(&self, task_id: &str) -> Result<(), OrchestratorError> {
        let plan = self.store.load_plan()?;
        let mut task = find_task(&plan, task_id)?.clone();
        if task.status != TaskStatus::Reviewing {
            return Err(OrchestratorError::Invalid(format!(
                "task {} cannot be reviewed from status {}",
                task.id,
                task.status.as_str()
            )));
        }
        let coder = self
            .store
            .latest_structured_result::<CoderResult>(&task.id, "coder")?
            .ok_or_else(|| {
                OrchestratorError::Invalid(format!(
                    "task {} has no recoverable coder evidence",
                    task.id
                ))
            })?;
        let worktree = task.worktree.clone().ok_or_else(|| {
            OrchestratorError::Invalid(format!(
                "task {} has no recoverable coder evidence",
                task.id
            ))
        })?;
        transition_task(
            &self.store,
            &mut task,
            TaskStatus::Interrupted,
            &self.agent_for(Role::Planner)?.identity,
            "explicit review requested",
        )?;
        transition_task(
            &self.store,
            &mut task,
            TaskStatus::Testing,
            &self.agent_for(Role::Tester)?.identity,
            "refresh independent test evidence before review",
        )?;
        let owner = task
            .assigned_agent
            .as_ref()
            .and_then(|id| self.config.agents.get(id))
            .ok_or_else(|| OrchestratorError::Invalid("task has no assigned coder".into()))?
            .clone();
        self.test_and_review(&plan, &mut task, Path::new(&worktree), &owner, coder)
            .await
    }

    pub async fn resume(&self) -> Result<RunResult, OrchestratorError> {
        let plan = self.store.load_plan()?;
        let state = self.store.load_state()?;
        if plan
            .tasks
            .iter()
            .any(|task| task.status == TaskStatus::Integrating)
            || state.status == RunStatus::FinalValidating
        {
            return self.integrate().await;
        }
        let planner = self.agent_for(Role::Planner)?.identity.clone();
        for snapshot in plan.tasks {
            if matches!(
                snapshot.status,
                TaskStatus::Approved
                    | TaskStatus::Completed
                    | TaskStatus::Pending
                    | TaskStatus::Ready
                    | TaskStatus::Invalidated
                    | TaskStatus::Blocked
                    | TaskStatus::Failed
            ) {
                continue;
            }
            let _lock = self.store.acquire_task_lock(&snapshot.id)?;
            let current_plan = self.store.load_plan()?;
            let mut task = find_task(&current_plan, &snapshot.id)?.clone();
            let original = task.status;
            if allowed_transition(task.status, TaskStatus::Interrupted) {
                transition_task(
                    &self.store,
                    &mut task,
                    TaskStatus::Interrupted,
                    &planner,
                    &format!("recovering task left in {}", original.as_str()),
                )?;
            }
            if !matches!(
                original,
                TaskStatus::Running | TaskStatus::SelfVerifying | TaskStatus::Testing
            ) {
                continue;
            }
            let Some(coder) = self
                .store
                .latest_structured_result::<CoderResult>(&task.id, "coder")?
            else {
                continue;
            };
            let Some(worktree) = task.worktree.clone() else {
                continue;
            };
            if self
                .accept_coder_evidence(&mut task, Path::new(&worktree), &coder)
                .await
                .is_err()
            {
                continue;
            }
            transition_task(
                &self.store,
                &mut task,
                TaskStatus::Testing,
                &planner,
                "recovered committed coder result",
            )?;
            let Some(owner) = task
                .assigned_agent
                .as_ref()
                .and_then(|id| self.config.agents.get(id))
                .cloned()
            else {
                continue;
            };
            self.test_and_review(
                &current_plan,
                &mut task,
                Path::new(&worktree),
                &owner,
                coder,
            )
            .await?;
        }
        let mut state = self.store.load_state()?;
        if state.status != RunStatus::Completed {
            state.status = RunStatus::Running;
            state.result = None;
            self.store.save_state(&state)?;
        }
        self.run().await
    }

    pub async fn integrate(&self) -> Result<RunResult, OrchestratorError> {
        let mut stored_plan = self.store.load_plan()?;
        let active = stored_plan
            .tasks
            .iter()
            .filter(|task| task.status != TaskStatus::Invalidated)
            .cloned()
            .collect::<Vec<_>>();
        if active.is_empty()
            || !active.iter().all(|task| {
                matches!(
                    task.status,
                    TaskStatus::Approved | TaskStatus::Completed | TaskStatus::Integrating
                )
            })
        {
            return Err(OrchestratorError::Invalid(
                "integration requires every task to be approved".into(),
            ));
        }
        let integrator = self.agent_for(Role::Integrator)?.clone();
        for task in stored_plan
            .tasks
            .iter_mut()
            .filter(|task| task.status == TaskStatus::Approved)
        {
            transition_task(
                &self.store,
                task,
                TaskStatus::Integrating,
                &integrator.identity,
                "approved task selected for integration",
            )?;
        }
        let plan = Plan {
            goal: stored_plan.goal,
            base_commit: stored_plan.base_commit,
            tasks: self
                .store
                .load_plan()?
                .tasks
                .into_iter()
                .filter(|task| task.status != TaskStatus::Invalidated)
                .collect(),
        };
        plan.validate()?;
        let mut state = self.store.load_state()?;
        let prepared = self
            .git
            .prepare_integration_worktree(
                &plan.tasks,
                &plan.base_commit,
                &state.run_id.to_string(),
                &integrator.identity,
                &state.integrated_commits.iter().cloned().collect(),
            )
            .await;
        let (integration_path, commits) = match prepared {
            Ok(value) => value,
            Err(error) => {
                return self.integration_failure(
                    &plan,
                    &integrator,
                    &error.to_string(),
                    vec![],
                    vec![],
                );
            }
        };
        state.status = RunStatus::FinalValidating;
        state.integration_branch = Some(format!("orchestrator/{}/integration", state.run_id));
        state.integration_worktree = Some(integration_path.display().to_string());
        state.integrated_commits = commits.clone();
        self.store.save_state(&state)?;
        let mut validations = Vec::new();
        for command in &self.config.validation_commands {
            validations.push(self.run_validation(command, &integration_path).await?);
        }
        let branch = state
            .integration_branch
            .clone()
            .expect("integration branch");
        let result = self
            .runner
            .run::<RunResult>(AgentRunRequest {
                agent: integrator.clone(),
                task_id: "INTEGRATION".into(),
                cwd: integration_path,
                prompt: integrator_prompt(&plan.goal, &plan, &commits, &validations, &branch),
                state_transition: Some("final_validating -> completed".into()),
            })
            .await;
        let (result, _) = match result {
            Ok(value) => value,
            Err(error) => {
                return self.integration_failure(
                    &plan,
                    &integrator,
                    &error.to_string(),
                    commits,
                    validations,
                );
            }
        };
        if result.integrated_commits != commits || result.validations != validations {
            return self.integration_failure(
                &plan,
                &integrator,
                "integrator result does not match integration evidence",
                commits,
                validations,
            );
        }
        let mut state = self.store.load_state()?;
        state.status = run_status(result.status);
        state.result = Some(serde_json::to_value(&result).expect("run result serializes"));
        self.store.save_state(&state)?;
        if result.status == LifecycleResultStatus::Completed {
            for mut task in self.store.load_plan()?.tasks {
                if task.status == TaskStatus::Integrating {
                    transition_task(
                        &self.store,
                        &mut task,
                        TaskStatus::Completed,
                        &integrator.identity,
                        "repository-wide validation passed",
                    )?;
                }
            }
        }
        Ok(result)
    }

    fn integration_failure(
        &self,
        plan: &Plan,
        integrator: &AgentConfig,
        detail: &str,
        commits: Vec<String>,
        validations: Vec<ValidationResult>,
    ) -> Result<RunResult, OrchestratorError> {
        let result = RunResult {
            status: LifecycleResultStatus::Failed,
            summary: "integration stopped with an explicit failure".into(),
            integrated_commits: commits,
            validations,
            issues: vec![Issue {
                severity: Severity::High,
                scope: IssueScope::Integration,
                description: detail.into(),
                expected: "approved task commits integrate and repository validation completes"
                    .into(),
                owner_task_id: plan
                    .tasks
                    .first()
                    .map(|task| task.id.clone())
                    .unwrap_or_else(|| "INTEGRATION".into()),
                reproduction: Some("lebang integrate".into()),
            }],
        };
        let mut state = self.store.load_state()?;
        state.status = RunStatus::Failed;
        state
            .integration_branch
            .get_or_insert_with(|| format!("orchestrator/{}/integration", state.run_id));
        let candidate = self
            .repo_root
            .join(".worktrees")
            .join(format!("{}-{}", state.run_id, integrator.identity));
        if candidate.is_dir() {
            state.integration_worktree = Some(candidate.display().to_string());
        }
        state.result = Some(serde_json::to_value(&result).expect("run result serializes"));
        self.store.save_state(&state)?;
        self.store.append_jsonl(
            &self.store.history_dir.join("run.jsonl"),
            &json!({
                "timestamp": utc_now(), "event": "integration_failed",
                "agent": integrator.identity, "reason": detail,
            }),
        )?;
        Ok(result)
    }

    async fn handle_replan(
        &self,
        current: &Plan,
        review: &ReviewResult,
    ) -> Result<(), OrchestratorError> {
        let planner = self.agent_for(Role::Planner)?.clone();
        let coders = self
            .config
            .coders()
            .into_iter()
            .map(|agent| agent.identity.clone())
            .collect::<Vec<_>>();
        let (mut replanned, _) = self
            .runner
            .run::<Plan>(AgentRunRequest {
                agent: planner.clone(),
                task_id: "PLAN".into(),
                cwd: self.repo_root.clone(),
                prompt: replan_prompt(
                    current,
                    review,
                    &self.repo_root,
                    &coders,
                    self.config.max_workers,
                ),
                state_transition: Some("replan_required -> running".into()),
            })
            .await?;
        if replanned.base_commit != current.base_commit || replanned.goal != current.goal {
            return Err(OrchestratorError::Invalid(
                "replan changed the original goal or baseCommit".into(),
            ));
        }
        self.assign_unowned_tasks(&mut replanned.tasks);
        self.validate_planned_tasks(&replanned.tasks)?;
        let reason = review
            .issues
            .iter()
            .map(|issue| issue.description.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        self.store
            .replace_plan(&replanned, &planner.identity, &reason)?;
        let mut state = self.store.load_state()?;
        state.status = RunStatus::Running;
        state.result = None;
        self.store.save_state(&state)?;
        Ok(())
    }

    async fn run_validation(
        &self,
        command: &[String],
        cwd: &Path,
    ) -> Result<ValidationResult, OrchestratorError> {
        let output = Command::new(&command[0])
            .args(&command[1..])
            .current_dir(cwd)
            .output()
            .await?;
        Ok(ValidationResult {
            command: command.to_vec(),
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    fn terminal_result(&self, plan: &Plan) -> Result<RunResult, OrchestratorError> {
        let failed = plan
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Failed)
            .collect::<Vec<_>>();
        let blocked = plan
            .tasks
            .iter()
            .filter(|task| task.status == TaskStatus::Blocked)
            .collect::<Vec<_>>();
        let status = if failed.is_empty() {
            LifecycleResultStatus::Blocked
        } else {
            LifecycleResultStatus::Failed
        };
        let affected = if !failed.is_empty() {
            failed
        } else if !blocked.is_empty() {
            blocked
        } else {
            plan.tasks
                .iter()
                .filter(|task| {
                    !matches!(
                        task.status,
                        TaskStatus::Approved | TaskStatus::Completed | TaskStatus::Invalidated
                    )
                })
                .collect()
        };
        let result = RunResult {
            status,
            summary: "orchestration cannot make further progress".into(),
            integrated_commits: Vec::new(),
            validations: Vec::new(),
            issues: affected
                .into_iter()
                .map(|task| Issue {
                    severity: Severity::High,
                    scope: IssueScope::Task,
                    description: format!("task {} stopped in {}", task.id, task.status.as_str()),
                    expected: "task reaches approved state".into(),
                    owner_task_id: task.id.clone(),
                    reproduction: None,
                })
                .collect(),
        };
        let mut state = self.store.load_state()?;
        state.status = run_status(status);
        state.result = Some(serde_json::to_value(&result).expect("run result serializes"));
        self.store.save_state(&state)?;
        Ok(result)
    }

    fn assign_unowned_tasks(&self, tasks: &mut [Task]) {
        let mut coders = self
            .config
            .coders()
            .into_iter()
            .cloned()
            .collect::<Vec<_>>();
        coders.sort_by(
            |left, right| match (left.identity.as_str(), right.identity.as_str()) {
                ("kd", "kd") => std::cmp::Ordering::Equal,
                ("kd", _) => std::cmp::Ordering::Less,
                (_, "kd") => std::cmp::Ordering::Greater,
                _ => left.identity.cmp(&right.identity),
            },
        );
        coders.truncate(self.config.max_workers);
        let mut index = 0;
        for task in tasks {
            if task.assigned_agent.is_none() && task.status != TaskStatus::Invalidated {
                task.assigned_agent = coders
                    .get(index % coders.len())
                    .map(|agent| agent.identity.clone());
                index += 1;
            }
        }
    }

    fn validate_planned_tasks(&self, tasks: &[Task]) -> Result<(), OrchestratorError> {
        for task in tasks {
            if task.worker_role != "coder" {
                return Err(OrchestratorError::Invalid(format!(
                    "planned task {} uses workerRole {}; DAG tasks must use coder",
                    task.id, task.worker_role
                )));
            }
            if task.status == TaskStatus::Invalidated {
                continue;
            }
            let owner = task.assigned_agent.as_ref().ok_or_else(|| {
                OrchestratorError::Invalid(format!(
                    "planned task {} has no available coder",
                    task.id
                ))
            })?;
            if self.config.agents.get(owner).map(|agent| agent.role) != Some(Role::Coder) {
                return Err(OrchestratorError::Invalid(format!(
                    "task {} is assigned to non-coder agent {owner}",
                    task.id
                )));
            }
        }
        Ok(())
    }

    fn agent_for(&self, role: Role) -> Result<&AgentConfig, OrchestratorError> {
        Ok(self.config.agent_for_role(role.as_str())?)
    }
}

fn find_task<'a>(plan: &'a Plan, task_id: &str) -> Result<&'a Task, OrchestratorError> {
    plan.tasks
        .iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| OrchestratorError::Invalid(format!("unknown task: {task_id}")))
}

fn find_task_mut<'a>(plan: &'a mut Plan, task_id: &str) -> Result<&'a mut Task, OrchestratorError> {
    plan.tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| OrchestratorError::Invalid(format!("unknown task: {task_id}")))
}

fn same_set(left: &[String], right: &[String]) -> bool {
    left.iter().collect::<HashSet<_>>() == right.iter().collect::<HashSet<_>>()
}

const fn run_status(status: LifecycleResultStatus) -> RunStatus {
    match status {
        LifecycleResultStatus::Completed => RunStatus::Completed,
        LifecycleResultStatus::Blocked => RunStatus::Blocked,
        LifecycleResultStatus::Failed => RunStatus::Failed,
    }
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .expect("current directory")
            .join(path)
    }
}
