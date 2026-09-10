#![cfg(unix)]

use lebang_orchestrator::{
    config::{AgentKind, Config, DEFAULT_CONFIG, Thinking},
    runtime::{AgentInvocation, AgentRuntime, HerdrRuntime},
};
use serde_json::Value;
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, time::Duration};
use tempfile::tempdir;

async fn exercise(kind: AgentKind, model: &str, session_kind: &str) {
    let root = tempdir().unwrap();
    let fake = root.path().join("herdr");
    let state = root.path().join("fake.json");
    let log = root.path().join("commands.jsonl");
    fs::write(&fake, include_str!("fixtures/native-herdr.py")).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let mut config = Config::parse(DEFAULT_CONFIG).unwrap();
    config.herdr.command = fake.to_string_lossy().into_owned();
    for identity in ["kd", "curry"] {
        let agent = config.agents.get_mut(identity).unwrap();
        agent.agent = kind;
        agent.model = model.into();
        agent.thinking = if kind == AgentKind::Gemini {
            Thinking::Default
        } else {
            Thinking::High
        };
    }
    let coder = config.agents["kd"].clone();
    let reviewer = config.agents["curry"].clone();
    let runtime = HerdrRuntime::with_environment(
        root.path(),
        config,
        BTreeMap::from([
            ("HERDR_ENV".into(), "1".into()),
            ("HERDR_TAB_ID".into(), "w1:t1".into()),
            ("FAKE_STATE".into(), state.to_string_lossy().into_owned()),
            ("FAKE_LOG".into(), log.to_string_lossy().into_owned()),
            ("SESSION_KIND".into(), session_kind.into()),
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                "{\"small_model\":\"openai/gpt-5-mini\"}".into(),
            ),
        ]),
    );
    let layout = runtime.bootstrap().await.unwrap();
    assert_eq!(runtime.bootstrap().await.unwrap(), layout);
    let cwd = root.path().join("task's worktree $literal");
    fs::create_dir(&cwd).unwrap();
    let request = |agent| AgentInvocation {
        agent,
        cwd: cwd.clone(),
        prompt: "work on the task".into(),
        marker: "RESULT".into(),
        timeout: Duration::from_secs(1),
        resume_session: false,
    };
    for agent in [coder.clone(), reviewer] {
        assert_eq!(
            runtime.invoke(request(agent)).await.unwrap(),
            "task response"
        );
    }
    let mut saved: Value = serde_json::from_str(&fs::read_to_string(&state).unwrap()).unwrap();
    assert_eq!(saved["agents"]["kd"]["cwd"], cwd.to_string_lossy().as_ref());
    saved["agents"].as_object_mut().unwrap().remove("kd");
    fs::write(&state, serde_json::to_vec(&saved).unwrap()).unwrap();
    if session_kind == "id" {
        // Older Lebang versions persisted bare session IDs instead of typed references.
        let sessions_path = root.path().join(".orchestrator/agent-sessions.json");
        let mut sessions: Value =
            serde_json::from_str(&fs::read_to_string(&sessions_path).unwrap()).unwrap();
        for value in sessions.as_object_mut().unwrap().values_mut() {
            *value = value["value"].clone();
        }
        fs::write(sessions_path, serde_json::to_vec(&sessions).unwrap()).unwrap();
    }
    let mut retry = request(coder);
    retry.resume_session = true;
    runtime.invoke(retry).await.unwrap();
    let commands: Vec<Vec<String>> = fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let starts: Vec<_> = commands
        .iter()
        .filter(|a| a.starts_with(&["agent".into(), "start".into(), "kd".into()]))
        .collect();
    assert_eq!(starts.len(), 3);
    let resume_flag = match (kind, session_kind) {
        (AgentKind::Gemini, "path") => "--session-file",
        (AgentKind::Gemini, _) => "--resume",
        _ => "--session",
    };
    let last = starts.last().unwrap();
    let expected = if session_kind == "path" {
        cwd.join("kd session.jsonl").to_string_lossy().into_owned()
    } else {
        "kd-session".into()
    };
    assert!(last.windows(2).any(|pair| pair == [resume_flag, &expected]));
    assert!(
        !last
            .iter()
            .any(|arg| matches!(arg.as_str(), "--continue" | "--last" | "latest"))
    );
}

#[tokio::test]
async fn opencode_uses_scoped_configuration_and_exact_session() {
    exercise(AgentKind::OpenCode, "openai/gpt-5", "id").await;
}

#[tokio::test]
async fn pi_rebinds_and_resumes_both_native_session_references() {
    for reference in ["id", "path"] {
        exercise(AgentKind::Pi, "google/gemini-2.5-pro", reference).await;
    }
}

#[tokio::test]
async fn gemini_applies_role_policies_and_resumes_both_native_session_references() {
    for reference in ["id", "path"] {
        exercise(AgentKind::Gemini, "gemini-2.5-pro", reference).await;
    }
}
