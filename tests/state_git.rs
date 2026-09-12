use std::{fs, path::Path};

use lebang_orchestrator::{
    git::{GitManager, is_test_support_path},
    model::{Plan, Risk, Task, TaskStatus, TaskType},
    state::{ready_task_ids, transition_task},
    store::RunStore,
};
use tempfile::tempdir;

fn task(id: &str) -> Task {
    Task {
        id: id.into(),
        title: "Implement feature".into(),
        task_type: TaskType::Implementation,
        description: "Implement it".into(),
        acceptance_criteria: vec!["It works".into()],
        dependencies: Vec::new(),
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

#[test]
fn ready_and_transition_rules_are_persisted_and_audited() {
    let root = tempdir().unwrap();
    let store = RunStore::new(root.path());
    let mut first = task("T1");
    let mut second = task("T2");
    second.dependencies = vec!["T1".into()];
    store
        .initialize(&Plan {
            goal: "state".into(),
            base_commit: "abc123".into(),
            tasks: vec![first.clone(), second.clone()],
        })
        .unwrap();

    assert_eq!(ready_task_ids(&[first.clone(), second]), ["T1"]);
    transition_task(
        &store,
        &mut first,
        TaskStatus::Ready,
        "lebang",
        "dependencies met",
    )
    .unwrap();
    assert!(
        transition_task(&store, &mut first, TaskStatus::Completed, "lebang", "skip")
            .unwrap_err()
            .to_string()
            .contains("invalid task transition")
    );
    assert!(
        fs::read_to_string(root.path().join("history/T1.jsonl"))
            .unwrap()
            .contains("dependencies met")
    );
}

#[tokio::test]
async fn git_worktrees_keep_dependency_commits_out_of_the_local_range() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let mut dependency = task("T1");
    let dependency_snapshot = dependency.clone();
    let dependency_path = manager
        .prepare_task_worktree(&mut dependency, &[dependency_snapshot], &base)
        .await
        .unwrap();
    fs::write(dependency_path.join("dependency.txt"), "dependency\n").unwrap();
    git(&dependency_path, &["add", "dependency.txt"]);
    git(&dependency_path, &["commit", "-m", "T1"]);
    dependency.commit = Some(git(&dependency_path, &["rev-parse", "HEAD"]));
    dependency.status = TaskStatus::Approved;

    let mut dependent = task("T2");
    dependent.assigned_agent = Some("harden".into());
    dependent.dependencies = vec!["T1".into()];
    let dependent_snapshot = dependent.clone();
    let dependent_path = manager
        .prepare_task_worktree(
            &mut dependent,
            &[dependency.clone(), dependent_snapshot],
            &base,
        )
        .await
        .unwrap();
    fs::write(dependent_path.join("dependent.txt"), "dependent\n").unwrap();
    git(&dependent_path, &["add", "dependent.txt"]);
    git(&dependent_path, &["commit", "-m", "T2"]);
    dependent.commit = Some(git(&dependent_path, &["rev-parse", "HEAD"]));

    assert_eq!(
        manager.task_commits(&dependent).await.unwrap(),
        [dependent.commit.unwrap()]
    );
    assert!(is_test_support_path("tests/feature.rs"));
    assert!(!is_test_support_path("src/feature.rs"));
}

#[tokio::test]
async fn task_worktree_recovers_a_missing_prunable_registration() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let mut first = task("T1");
    let snapshot = first.clone();
    let path = manager
        .prepare_task_worktree(&mut first, &[snapshot], &base)
        .await
        .unwrap();
    fs::write(root.path().join("next.txt"), "next\n").unwrap();
    git(root.path(), &["add", "next.txt"]);
    git(root.path(), &["commit", "-m", "next"]);
    let next_base = git(root.path(), &["rev-parse", "HEAD"]);
    fs::remove_dir_all(&path).unwrap();

    let mut retry = task("T1");
    let snapshot = retry.clone();
    let recovered = manager
        .prepare_task_worktree(&mut retry, &[snapshot], &next_base)
        .await
        .unwrap();

    assert_eq!(recovered, path);
    assert_eq!(retry.branch.as_deref(), Some("agent/kd/T1"));
    assert_eq!(retry.base_commit.as_deref(), Some(next_base.as_str()));
    assert_eq!(git(&recovered, &["rev-parse", "HEAD"]), next_base);
    assert!(recovered.is_dir());
}

#[tokio::test]
async fn task_worktree_archives_an_unrecorded_divergent_branch() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let mut first = task("T1");
    let snapshot = first.clone();
    let path = manager
        .prepare_task_worktree(&mut first, &[snapshot], &base)
        .await
        .unwrap();
    fs::write(path.join("old.txt"), "old task work\n").unwrap();
    git(&path, &["add", "old.txt"]);
    git(&path, &["commit", "-m", "old task work"]);
    let old_commit = git(&path, &["rev-parse", "HEAD"]);
    fs::remove_dir_all(&path).unwrap();

    let mut retry = task("T1");
    let snapshot = retry.clone();
    let recovered = manager
        .prepare_task_worktree(&mut retry, &[snapshot], &base)
        .await
        .unwrap();

    assert_eq!(git(&recovered, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        git(
            root.path(),
            &["rev-parse", &format!("archive/agent/kd/T1/{old_commit}")],
        ),
        old_commit
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

#[tokio::test]
async fn integration_recovers_commits_applied_before_state_was_saved() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let mut first = task("T1");
    let snapshot = first.clone();
    let path = manager
        .prepare_task_worktree(&mut first, &[snapshot], &base)
        .await
        .unwrap();
    fs::write(path.join("feature.txt"), "done\n").unwrap();
    git(&path, &["add", "feature.txt"]);
    git(&path, &["commit", "-m", "feature"]);
    first.commit = Some(git(&path, &["rev-parse", "HEAD"]));
    first.status = TaskStatus::Approved;
    let (integration, commits) = manager
        .prepare_integration_worktree(
            &[first.clone()],
            &base,
            "run1",
            "duncan",
            &Default::default(),
        )
        .await
        .unwrap();
    let head = git(&integration, &["rev-parse", "HEAD"]);
    let (resumed, resumed_commits) = manager
        .prepare_integration_worktree(&[first], &base, "run1", "duncan", &Default::default())
        .await
        .unwrap();
    assert_eq!(resumed, integration);
    assert_eq!(resumed_commits, commits);
    assert_eq!(git(&resumed, &["rev-parse", "HEAD"]), head);
    assert!(manager.head_is_clean(&resumed).await.unwrap());
}

#[tokio::test]
async fn missing_recorded_task_worktree_preserves_its_original_base() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let mut first = task("T1");
    let snapshot = first.clone();
    let path = manager
        .prepare_task_worktree(&mut first, &[snapshot], &base)
        .await
        .unwrap();
    fs::write(path.join("feature.txt"), "done\n").unwrap();
    git(&path, &["add", "feature.txt"]);
    git(&path, &["commit", "-m", "feature"]);
    first.commit = Some(git(&path, &["rev-parse", "HEAD"]));
    fs::remove_dir_all(&path).unwrap();
    let snapshot = first.clone();
    manager
        .prepare_task_worktree(&mut first, &[snapshot], &base)
        .await
        .unwrap();
    assert_eq!(first.base_commit.as_deref(), Some(base.as_str()));
    assert_eq!(
        manager.changed_files(&first).await.unwrap(),
        ["feature.txt"]
    );
}

#[tokio::test]
async fn cleanliness_does_not_accept_a_git_error() {
    let root = tempdir().unwrap();
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    assert!(manager.head_is_clean(root.path()).await.is_err());
}

#[tokio::test]
async fn changed_files_preserves_unicode_and_whitespace_in_paths() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let base = git(root.path(), &["rev-parse", "HEAD"]);
    let manager = GitManager::new(root.path(), root.path().join(".worktrees"));
    let names = [" 文档.md", "测试.rs", "line\nbreak.txt"];
    for name in names {
        fs::write(root.path().join(name), "content").unwrap();
    }
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "paths"]);
    let head = git(root.path(), &["rev-parse", "HEAD"]);
    let mut changed = manager.changed_files_between(&base, &head).await.unwrap();
    changed.sort();
    let mut expected = names.map(String::from).to_vec();
    expected.sort();
    assert_eq!(changed, expected);
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
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
