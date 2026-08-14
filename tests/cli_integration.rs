use std::{fs, path::Path, process::Command};

use tempfile::tempdir;

#[test]
fn init_is_idempotent_and_read_only_commands_need_no_config() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let binary = env!("CARGO_BIN_EXE_lebang");

    let first = Command::new(binary)
        .args(["--repo", root.path().to_str().unwrap(), "init"])
        .output()
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let path = root.path().join(".orchestrator/config.toml");
    let template = fs::read_to_string(&path).unwrap();
    assert!(template.contains("[agents.lebang]"));
    assert!(template.contains("model = \"gpt-5.6-sol\""));
    assert!(
        String::from_utf8(first.stdout)
            .unwrap()
            .contains("model, mode, thinking, and validation_commands")
    );

    fs::write(&path, "custom = true\n").unwrap();
    let second = Command::new(binary)
        .args(["init", "--repo", root.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(second.status.success());
    assert_eq!(fs::read_to_string(&path).unwrap(), "custom = true\n");

    fs::remove_file(&path).unwrap();
    copy_fixture(root.path().join(".orchestrator"));
    let status = Command::new(binary)
        .args(["status", "--repo", root.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let stdout = String::from_utf8(status.stdout).unwrap();
    assert!(stdout.contains("T1"));
    assert!(stdout.contains("pending=1"));
}

#[test]
fn agent_commands_require_project_toml_and_protocol_errors_exit_two() {
    let root = tempdir().unwrap();
    init_repo(root.path());
    let output = Command::new(env!("CARGO_BIN_EXE_lebang"))
        .args(["run", "--repo", root.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("lebang init"));
    assert!(!stderr.contains("config.json"));
}

fn copy_fixture(target: std::path::PathBuf) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/python-orchestrator");
    fs::create_dir_all(target.join("tasks")).unwrap();
    fs::create_dir_all(target.join("history")).unwrap();
    fs::copy(source.join("plan.json"), target.join("plan.json")).unwrap();
    fs::copy(source.join("state.json"), target.join("state.json")).unwrap();
    fs::copy(source.join("tasks/T1.json"), target.join("tasks/T1.json")).unwrap();
    fs::copy(
        source.join("history/run.jsonl"),
        target.join("history/run.jsonl"),
    )
    .unwrap();
}

fn init_repo(path: &Path) {
    git(path, &["init", "-b", "main"]);
    git(path, &["config", "user.name", "Test User"]);
    git(path, &["config", "user.email", "test@example.com"]);
    fs::write(path.join("README.md"), "base\n").unwrap();
    git(path, &["add", "README.md"]);
    git(path, &["commit", "-m", "base"]);
}

fn git(path: &Path, args: &[&str]) {
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
}
