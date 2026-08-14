use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("{label} failed validation: {detail}")]
    Invalid { label: &'static str, detail: String },
}

fn invalid(label: &'static str, detail: impl Into<String>) -> ModelError {
    ModelError::Invalid {
        label,
        detail: detail.into(),
    }
}

fn decode<T: DeserializeOwned>(value: Value, label: &'static str) -> Result<T, ModelError> {
    serde_json::from_value(value).map_err(|error| invalid(label, error.to_string()))
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Implementation,
    Refactor,
    Test,
    Investigation,
    Documentation,
    Integration,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Ready,
    Running,
    SelfVerifying,
    Testing,
    Reviewing,
    ChangesRequested,
    Reworking,
    Approved,
    Integrating,
    Completed,
    Interrupted,
    Blocked,
    Failed,
    Invalidated,
}

impl TaskStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::SelfVerifying => "self_verifying",
            Self::Testing => "testing",
            Self::Reviewing => "reviewing",
            Self::ChangesRequested => "changes_requested",
            Self::Reworking => "reworking",
            Self::Approved => "approved",
            Self::Integrating => "integrating",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
            Self::Invalidated => "invalidated",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
    pub description: String,
    pub acceptance_criteria: Vec<String>,
    pub dependencies: Vec<String>,
    pub worker_role: String,
    pub assigned_agent: Option<String>,
    pub risk: Risk,
    pub status: TaskStatus,
    pub review_attempts: u32,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub base_commit: Option<String>,
    pub commit: Option<String>,
}

impl Task {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.id.is_empty() || self.title.is_empty() || self.description.is_empty() {
            return Err(invalid(
                "task",
                "id, title, and description must not be empty",
            ));
        }
        if self.acceptance_criteria.is_empty()
            || self.acceptance_criteria.iter().any(String::is_empty)
            || self.dependencies.iter().any(String::is_empty)
        {
            return Err(invalid(
                "task",
                "acceptanceCriteria must be non-empty and string lists cannot contain empty values",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub goal: String,
    pub base_commit: String,
    pub tasks: Vec<Task>,
}

impl Plan {
    pub fn parse_str(input: &str) -> Result<Self, ModelError> {
        let value =
            serde_json::from_str(input).map_err(|error| invalid("plan", error.to_string()))?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self, ModelError> {
        let plan: Self = decode(value, "plan")?;
        plan.validate()?;
        Ok(plan)
    }

    pub fn validate(&self) -> Result<(), ModelError> {
        if self.goal.is_empty() || self.base_commit.is_empty() || self.tasks.is_empty() {
            return Err(invalid(
                "plan",
                "goal, baseCommit, and at least one task are required",
            ));
        }
        let mut by_id = HashMap::new();
        for task in &self.tasks {
            task.validate()?;
            if by_id.insert(task.id.as_str(), task).is_some() {
                return Err(invalid("plan", "task ids must be unique"));
            }
        }
        for task in &self.tasks {
            let missing: Vec<_> = task
                .dependencies
                .iter()
                .filter(|dependency| !by_id.contains_key(dependency.as_str()))
                .cloned()
                .collect();
            if !missing.is_empty() {
                return Err(invalid(
                    "plan",
                    format!(
                        "task {} has unknown dependencies: {}",
                        task.id,
                        missing.join(", ")
                    ),
                ));
            }
        }

        fn visit<'a>(
            task_id: &'a str,
            by_id: &HashMap<&'a str, &'a Task>,
            visiting: &mut HashSet<&'a str>,
            visited: &mut HashSet<&'a str>,
        ) -> Result<(), ModelError> {
            if visiting.contains(task_id) {
                return Err(invalid(
                    "plan",
                    format!("dependency cycle includes task {task_id}"),
                ));
            }
            if visited.contains(task_id) {
                return Ok(());
            }
            visiting.insert(task_id);
            for dependency in &by_id[task_id].dependencies {
                visit(dependency, by_id, visiting, visited)?;
            }
            visiting.remove(task_id);
            visited.insert(task_id);
            Ok(())
        }

        let mut visiting = HashSet::new();
        let mut visited = HashSet::new();
        for task_id in by_id.keys() {
            visit(task_id, &by_id, &mut visiting, &mut visited)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueScope {
    Task,
    Plan,
    Test,
    Integration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Issue {
    pub severity: Severity,
    pub scope: IssueScope,
    pub description: String,
    pub expected: String,
    pub owner_task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reproduction: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Approved,
    ChangesRequested,
    ReplanRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewResult {
    pub task_id: String,
    pub status: ReviewStatus,
    pub issues: Vec<Issue>,
}

impl ReviewResult {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.status == ReviewStatus::Approved && !self.issues.is_empty() {
            return Err(invalid(
                "review result",
                "approved review cannot contain issues",
            ));
        }
        if self.status != ReviewStatus::Approved && self.issues.is_empty() {
            return Err(invalid(
                "review result",
                format!("{:?} review requires at least one issue", self.status),
            ));
        }
        if self.status == ReviewStatus::ReplanRequired
            && !self
                .issues
                .iter()
                .any(|issue| issue.scope == IssueScope::Plan)
        {
            return Err(invalid(
                "review result",
                "replan_required review requires a plan-scoped issue",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleResultStatus {
    Completed,
    Blocked,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestOutcome {
    Passed,
    Failed,
    NotRun,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoderResult {
    pub task_id: String,
    pub status: LifecycleResultStatus,
    pub summary: String,
    pub changed_files: Vec<String>,
    pub tests_added: Vec<String>,
    pub tests_run: Vec<String>,
    pub test_result: TestOutcome,
    pub commit: Option<String>,
    pub blockers: Vec<String>,
}

impl CoderResult {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.status == LifecycleResultStatus::Completed && self.commit.is_none() {
            return Err(invalid(
                "coder result",
                "a completed coder result requires a commit",
            ));
        }
        if self.status == LifecycleResultStatus::Completed
            && self.test_result != TestOutcome::Passed
        {
            return Err(invalid(
                "coder result",
                "a completed coder result requires passed tests",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestFailure {
    pub description: String,
    pub reproduction: String,
    pub owner_task_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    Passed,
    Failed,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestResult {
    pub task_id: String,
    pub status: TestStatus,
    pub tests_executed: Vec<String>,
    pub tests_added: Vec<String>,
    pub failures: Vec<TestFailure>,
    pub commit: Option<String>,
}

impl TestResult {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.status == TestStatus::Failed && self.failures.is_empty() {
            return Err(invalid(
                "test result",
                "a failed test result requires at least one failure",
            ));
        }
        if self.status == TestStatus::Passed && !self.failures.is_empty() {
            return Err(invalid(
                "test result",
                "a passed test result cannot contain failures",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationResult {
    pub command: Vec<String>,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunResult {
    pub status: LifecycleResultStatus,
    pub summary: String,
    pub integrated_commits: Vec<String>,
    pub validations: Vec<ValidationResult>,
    pub issues: Vec<Issue>,
}

impl RunResult {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.status == LifecycleResultStatus::Completed
            && self.validations.iter().any(|item| item.exit_code != 0)
        {
            return Err(invalid(
                "run result",
                "completed run contains a failed validation",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Planned,
    Running,
    ReplanRequired,
    FinalValidating,
    Completed,
    Blocked,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunState {
    pub run_id: Uuid,
    pub status: RunStatus,
    pub goal: String,
    pub base_commit: String,
    pub created_at: String,
    pub updated_at: String,
    pub integration_branch: Option<String>,
    pub integration_worktree: Option<String>,
    pub integrated_commits: Vec<String>,
    pub result: Option<Value>,
}

impl RunState {
    pub fn validate(&self) -> Result<(), ModelError> {
        if self.goal.is_empty()
            || self.base_commit.is_empty()
            || self.created_at.is_empty()
            || self.updated_at.is_empty()
        {
            return Err(invalid("state", "required string is empty"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunRecord {
    pub run_id: String,
    pub task_id: String,
    pub agent: String,
    pub role: String,
    pub model: String,
    pub cwd: String,
    pub start_time: String,
    pub end_time: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub structured_result: Option<Value>,
    pub state_transition: Option<String>,
}

pub trait StructuredResult: DeserializeOwned + Serialize {
    fn validate_result(&self) -> Result<(), ModelError>;
}

impl StructuredResult for Plan {
    fn validate_result(&self) -> Result<(), ModelError> {
        self.validate()
    }
}

impl StructuredResult for CoderResult {
    fn validate_result(&self) -> Result<(), ModelError> {
        self.validate()
    }
}

impl StructuredResult for TestResult {
    fn validate_result(&self) -> Result<(), ModelError> {
        self.validate()
    }
}

impl StructuredResult for ReviewResult {
    fn validate_result(&self) -> Result<(), ModelError> {
        self.validate()
    }
}

impl StructuredResult for RunResult {
    fn validate_result(&self) -> Result<(), ModelError> {
        self.validate()
    }
}
