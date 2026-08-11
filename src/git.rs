use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use regex::Regex;
use thiserror::Error;
use tokio::{process::Command, sync::Mutex};

use crate::model::{Task, TaskStatus};

#[derive(Debug, Error)]
pub enum GitError {
    #[error("git {command} failed with {code}: {detail}")]
    Command {
        command: String,
        code: i32,
        detail: String,
    },
    #[error("{0}")]
    Invalid(String),
    #[error("cannot start git: {0}")]
    Spawn(#[from] std::io::Error),
}

pub struct GitManager {
    pub repo_root: PathBuf,
    pub worktrees_root: PathBuf,
    worktree_lock: Mutex<()>,
}

impl GitManager {
    pub fn new(repo_root: impl AsRef<Path>, worktrees_root: impl AsRef<Path>) -> Self {
        Self {
            repo_root: absolute(repo_root.as_ref()),
            worktrees_root: absolute(worktrees_root.as_ref()),
            worktree_lock: Mutex::new(()),
        }
    }

    pub async fn current_commit(&self, cwd: impl AsRef<Path>) -> Result<String, GitError> {
        self.git(["rev-parse", "HEAD"], cwd.as_ref()).await
    }

    pub async fn prepare_task_worktree(
        &self,
        task: &mut Task,
        all_tasks: &[Task],
        orchestration_base: &str,
    ) -> Result<PathBuf, GitError> {
        let agent = task
            .assigned_agent
            .as_deref()
            .ok_or_else(|| GitError::Invalid(format!("task {} has no assigned agent", task.id)))?;
        validate_component(&task.id, "task id")?;
        validate_component(agent, "agent identity")?;
        let branch = format!("agent/{agent}/{}", task.id);
        let path = self.worktrees_root.join(format!("{}-{agent}", task.id));
        if let Some(recorded) = &task.worktree {
            if absolute(Path::new(recorded)) != path {
                return Err(GitError::Invalid(format!(
                    "task {} records unexpected worktree {recorded}; expected {}",
                    task.id,
                    path.display()
                )));
            }
            if path.is_dir()
                && task.branch.as_deref() == Some(&branch)
                && task.base_commit.is_some()
            {
                self.verify_worktree(&path, &branch).await?;
                return Ok(path);
            }
        }

        {
            let _guard = self.worktree_lock.lock().await;
            tokio::fs::create_dir_all(&self.worktrees_root).await?;
            if path.exists() {
                return Err(GitError::Invalid(format!(
                    "worktree path already exists but is not recoverable: {}",
                    path.display()
                )));
            }
            if self.branch_exists(&branch).await? {
                self.git(
                    vec![
                        "worktree".into(),
                        "add".into(),
                        path_string(&path),
                        branch.clone(),
                    ],
                    &self.repo_root,
                )
                .await?;
            } else {
                self.git(
                    vec![
                        "worktree".into(),
                        "add".into(),
                        "-b".into(),
                        branch.clone(),
                        path_string(&path),
                        orchestration_base.into(),
                    ],
                    &self.repo_root,
                )
                .await?;
            }
        }

        task.branch = Some(branch);
        task.worktree = Some(path_string(&path));
        for dependency in dependency_order(task, all_tasks)? {
            if !matches!(
                dependency.status,
                TaskStatus::Approved | TaskStatus::Completed
            ) {
                return Err(GitError::Invalid(format!(
                    "dependency {} is not approved for task {}",
                    dependency.id, task.id
                )));
            }
            for commit in self.task_commits(dependency).await? {
                self.git(vec!["cherry-pick".into(), commit], &path).await?;
            }
        }
        task.base_commit = Some(self.current_commit(&path).await?);
        Ok(path)
    }

    pub async fn task_commits(&self, task: &Task) -> Result<Vec<String>, GitError> {
        let base = task.base_commit.as_deref().ok_or_else(|| {
            GitError::Invalid(format!(
                "task {} does not record a complete commit range",
                task.id
            ))
        })?;
        let commit = task.commit.as_deref().ok_or_else(|| {
            GitError::Invalid(format!(
                "task {} does not record a complete commit range",
                task.id
            ))
        })?;
        let ancestor = self
            .run_git(
                ["merge-base", "--is-ancestor", base, commit],
                &self.repo_root,
            )
            .await?;
        if ancestor.0 != 0 {
            return Err(GitError::Invalid(format!(
                "task {} commit {commit} does not descend from {base}",
                task.id
            )));
        }
        Ok(split_lines(
            &self
                .git(
                    ["rev-list", "--reverse", &format!("{base}..{commit}")],
                    &self.repo_root,
                )
                .await?,
        ))
    }

    pub async fn prepare_integration_worktree(
        &self,
        tasks: &[Task],
        base: &str,
        run_id: &str,
        integrator: &str,
        already_integrated: &HashSet<String>,
    ) -> Result<(PathBuf, Vec<String>), GitError> {
        validate_component(run_id, "run id")?;
        validate_component(integrator, "integrator identity")?;
        let invalid: Vec<_> = tasks
            .iter()
            .filter(|task| {
                !matches!(
                    task.status,
                    TaskStatus::Approved | TaskStatus::Completed | TaskStatus::Integrating
                )
            })
            .map(|task| format!("{}:{}", task.id, task.status.as_str()))
            .collect();
        if !invalid.is_empty() {
            return Err(GitError::Invalid(format!(
                "integration received tasks that are not approved: {}",
                invalid.join(", ")
            )));
        }
        let branch = format!("orchestrator/{run_id}/integration");
        let path = self.worktrees_root.join(format!("{run_id}-{integrator}"));
        {
            let _guard = self.worktree_lock.lock().await;
            tokio::fs::create_dir_all(&self.worktrees_root).await?;
            if path.exists() {
                self.verify_worktree(&path, &branch).await?;
            } else if self.branch_exists(&branch).await? {
                self.git(
                    vec![
                        "worktree".into(),
                        "add".into(),
                        path_string(&path),
                        branch.clone(),
                    ],
                    &self.repo_root,
                )
                .await?;
            } else {
                self.git(
                    vec![
                        "worktree".into(),
                        "add".into(),
                        "-b".into(),
                        branch.clone(),
                        path_string(&path),
                        base.into(),
                    ],
                    &self.repo_root,
                )
                .await?;
            }
        }
        let mut commits = Vec::new();
        for task in topological_tasks(tasks)? {
            for commit in self.task_commits(task).await? {
                if !already_integrated.contains(&commit) {
                    self.git(vec!["cherry-pick".into(), commit.clone()], &path)
                        .await?;
                }
                commits.push(commit);
            }
        }
        Ok((path, commits))
    }

    pub async fn changed_files(&self, task: &Task) -> Result<Vec<String>, GitError> {
        let (base, commit) = commit_range(task)?;
        Ok(split_lines(
            &self
                .git(
                    ["diff", "--name-only", &format!("{base}..{commit}")],
                    &self.repo_root,
                )
                .await?,
        ))
    }

    pub async fn changed_files_between(
        &self,
        before: &str,
        after: &str,
    ) -> Result<Vec<String>, GitError> {
        Ok(split_lines(
            &self
                .git(
                    ["diff", "--name-only", &format!("{before}..{after}")],
                    &self.repo_root,
                )
                .await?,
        ))
    }

    pub async fn task_diff(&self, task: &Task) -> Result<String, GitError> {
        let (base, commit) = commit_range(task)?;
        self.git(
            ["diff", "--no-ext-diff", &format!("{base}..{commit}")],
            &self.repo_root,
        )
        .await
    }

    pub async fn head_is_clean(&self, cwd: &Path) -> Result<bool, GitError> {
        let (_, stdout, _) = self
            .run_git(
                ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
                cwd,
            )
            .await?;
        for entry in stdout.split('\0').filter(|entry| !entry.is_empty()) {
            if entry.len() < 4 {
                return Ok(false);
            }
            if entry.starts_with("??") && is_ephemeral_path(&entry[3..]) {
                continue;
            }
            return Ok(false);
        }
        Ok(true)
    }

    async fn verify_worktree(&self, path: &Path, expected: &str) -> Result<(), GitError> {
        let actual = self.git(["branch", "--show-current"], path).await?;
        if actual != expected {
            return Err(GitError::Invalid(format!(
                "worktree {} uses branch {actual}, expected {expected}",
                path.display()
            )));
        }
        Ok(())
    }

    async fn branch_exists(&self, branch: &str) -> Result<bool, GitError> {
        let result = self
            .run_git(
                [
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}"),
                ],
                &self.repo_root,
            )
            .await?;
        Ok(result.0 == 0)
    }

    async fn git<I, S>(&self, args: I, cwd: &Path) -> Result<String, GitError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let args = args
            .into_iter()
            .map(|arg| arg.as_ref().to_owned())
            .collect::<Vec<_>>();
        let (code, stdout, stderr) = self.run_git(&args, cwd).await?;
        if code != 0 {
            return Err(GitError::Command {
                command: args.join(" "),
                code,
                detail: if stderr.trim().is_empty() {
                    stdout.trim().to_owned()
                } else {
                    stderr.trim().to_owned()
                },
            });
        }
        Ok(stdout.trim().to_owned())
    }

    async fn run_git<I, S>(&self, args: I, cwd: &Path) -> Result<(i32, String, String), GitError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let output = Command::new("git")
            .args(args.into_iter().map(|arg| arg.as_ref().to_owned()))
            .current_dir(cwd)
            .output()
            .await?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }
}

pub fn is_test_support_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    let parts: Vec<_> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let directories = [
        "test",
        "tests",
        "testing",
        "spec",
        "specs",
        "__tests__",
        "fixtures",
        "fixture",
        "mocks",
        "mock",
        "testdata",
    ];
    if parts[..parts.len().saturating_sub(1)]
        .iter()
        .any(|part| directories.contains(part))
    {
        return true;
    }
    let name = parts.last().copied().unwrap_or("");
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    name.starts_with("test_")
        || stem.ends_with("_test")
        || name.contains(".test.")
        || name.contains(".spec.")
}

fn is_ephemeral_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    let parts: Vec<_> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let directories = [
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".hypothesis",
        ".coverage_cache",
    ];
    if parts.iter().any(|part| directories.contains(part)) {
        return true;
    }
    let name = parts.last().copied().unwrap_or("");
    name == ".coverage" || name == ".ds_store" || name.ends_with(".pyc") || name.ends_with(".pyo")
}

fn dependency_order<'a>(task: &Task, all_tasks: &'a [Task]) -> Result<Vec<&'a Task>, GitError> {
    let by_id = all_tasks
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    fn visit<'a>(
        owner: &Task,
        id: &str,
        by_id: &HashMap<&str, &'a Task>,
        seen: &mut HashSet<String>,
        ordered: &mut Vec<&'a Task>,
    ) -> Result<(), GitError> {
        if seen.contains(id) {
            return Ok(());
        }
        let dependency = by_id.get(id).copied().ok_or_else(|| {
            GitError::Invalid(format!("task {} has unknown dependency {id}", owner.id))
        })?;
        for nested in &dependency.dependencies {
            visit(owner, nested, by_id, seen, ordered)?;
        }
        seen.insert(id.to_owned());
        ordered.push(dependency);
        Ok(())
    }
    for dependency in &task.dependencies {
        visit(task, dependency, &by_id, &mut seen, &mut ordered)?;
    }
    Ok(ordered)
}

fn topological_tasks(tasks: &[Task]) -> Result<Vec<&Task>, GitError> {
    let by_id = tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<HashMap<_, _>>();
    let mut ids = by_id.keys().copied().collect::<Vec<_>>();
    ids.sort();
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut visiting = HashSet::new();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a Task>,
        seen: &mut HashSet<&'a str>,
        visiting: &mut HashSet<&'a str>,
        ordered: &mut Vec<&'a Task>,
    ) -> Result<(), GitError> {
        if seen.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(GitError::Invalid(format!(
                "dependency cycle includes task {id}"
            )));
        }
        let task = by_id.get(id).copied().ok_or_else(|| {
            GitError::Invalid(format!("integration is missing dependency task {id}"))
        })?;
        for dependency in &task.dependencies {
            visit(dependency, by_id, seen, visiting, ordered)?;
        }
        visiting.remove(id);
        seen.insert(id);
        ordered.push(task);
        Ok(())
    }
    for id in ids {
        visit(id, &by_id, &mut seen, &mut visiting, &mut ordered)?;
    }
    Ok(ordered)
}

fn commit_range(task: &Task) -> Result<(&str, &str), GitError> {
    match (task.base_commit.as_deref(), task.commit.as_deref()) {
        (Some(base), Some(commit)) => Ok((base, commit)),
        _ => Err(GitError::Invalid(format!(
            "task {} does not record a complete commit range",
            task.id
        ))),
    }
}

fn validate_component(value: &str, label: &str) -> Result<(), GitError> {
    let safe = Regex::new(r"^[A-Za-z0-9._-]+$").expect("valid regex");
    if !safe.is_match(value) || matches!(value, "." | "..") {
        return Err(GitError::Invalid(format!("unsafe {label}: {value}")));
    }
    Ok(())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn split_lines(value: &str) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        value.lines().map(str::to_owned).collect()
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
