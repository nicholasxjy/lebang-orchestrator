#![cfg(unix)]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, time::Duration};

use lebang_orchestrator::{
    config::{Config, DEFAULT_CONFIG},
    runtime::{AgentInvocation, AgentRuntime, HerdrRuntime, parse_marked_result},
};
use tempfile::tempdir;

#[tokio::test]
async fn bootstraps_two_rows_in_the_current_tab_with_codex_arguments() {
    let root = tempdir().unwrap();
    let fake = root.path().join("fake-herdr");
    let log = root.path().join("commands.log");
    let counter = root.path().join("counter");
    fs::write(
        &fake,
        r#"#!/bin/sh
echo "$*" >> "$HERDR_FAKE_LOG"
if [ "$1 $2" = "pane current" ]; then
  echo '{"result":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1"}}}'
elif [ "$1 $2" = "agent get" ]; then
  exit 1
elif [ "$1 $2" = "pane split" ]; then
  n=1
  if [ -f "$HERDR_FAKE_COUNTER" ]; then n=$(tr -d '\n' < "$HERDR_FAKE_COUNTER"); fi
  n=$((n + 1))
  echo "$n" > "$HERDR_FAKE_COUNTER"
  printf '{"result":{"pane":{"pane_id":"w1:p%s"}}}\n' "$n"
elif [ "$1 $2" = "pane read" ]; then
  echo '{"result":{"output":"gpt-5.6-sol high Build mode"}}'
else
  echo '{"result":{}}'
fi
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake, permissions).unwrap();

    let config_text = DEFAULT_CONFIG
        .replace(
            "command = \"herdr\"",
            &format!("command = {:?}", fake.display().to_string()),
        )
        .replace("mode = \"plan\"", "mode = \"build\"")
        .replace("thinking = \"medium\"", "thinking = \"high\"");
    let config = Config::parse(&config_text).unwrap();
    let environment = BTreeMap::from([
        ("HERDR_ENV".into(), "1".into()),
        ("HERDR_WORKSPACE_ID".into(), "w1".into()),
        ("HERDR_TAB_ID".into(), "w1:t1".into()),
        ("HERDR_PANE_ID".into(), "w1:p1".into()),
        ("HERDR_FAKE_LOG".into(), log.display().to_string()),
        ("HERDR_FAKE_COUNTER".into(), counter.display().to_string()),
    ]);
    let runtime = HerdrRuntime::with_environment(root.path(), config, environment);

    let layout = runtime.bootstrap().await.unwrap();
    assert_eq!(layout.tab_id, "w1:t1");
    assert_eq!(layout.coordinator_pane, "w1:p1");
    assert_eq!(layout.agents.len(), 5);

    let commands = fs::read_to_string(log).unwrap();
    assert!(!commands.contains("tab create"));
    assert!(commands.contains("pane split --pane w1:p1 --direction right --percent 80"));
    assert!(commands.contains("--direction down --percent 50"));
    for identity in ["lebang", "kd", "westbrook", "curry", "duncan"] {
        assert!(commands.contains("pane rename "));
        assert!(
            commands.contains(&format!(" {identity}\n"))
                || commands.contains(&format!(" {identity} "))
        );
        assert!(commands.contains(&format!("agent start {identity} --kind codex")));
    }
    assert!(commands.contains("--model gpt-5.6-sol"));
    assert!(commands.contains("--cd"));
    assert!(commands.contains("--no-alt-screen"));
    assert!(commands.contains("--sandbox read-only"));
    assert!(commands.contains("--sandbox workspace-write"));
    assert!(commands.contains("--ask-for-approval never"));
    assert!(commands.contains("model_reasoning_effort=\"high\""));
    assert!(commands.contains("developer_instructions="));
}

#[test]
fn marked_transport_uses_the_last_valid_result() {
    let transcript = concat!(
        "RESULT_BEGIN\nnot json\nRESULT_END\n",
        "RESULT_BEGIN\n{\"status\":\"approved\"}\nRESULT_END\n"
    );
    let value: serde_json::Value = parse_marked_result(transcript, "RESULT").unwrap();
    assert_eq!(value["status"], "approved");
}

#[tokio::test]
async fn calibrates_plan_mode_reuses_layout_rebinds_cwd_and_serializes_identity() {
    let root = tempdir().unwrap();
    let state = root.path().join("fake-state");
    fs::create_dir(&state).unwrap();
    let fake = root.path().join("stateful-herdr");
    let log = root.path().join("stateful.log");
    fs::write(
        &fake,
        r#"#!/bin/sh
echo "$*" >> "$HERDR_FAKE_LOG"
if [ "$1 $2" = "pane current" ]; then
  echo '{"result":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1"}}}'
elif [ "$1 $2" = "pane split" ]; then
  n=1
  if [ -f "$HERDR_FAKE_STATE/counter" ]; then n=$(tr -d '\n' < "$HERDR_FAKE_STATE/counter"); fi
  n=$((n + 1)); echo "$n" > "$HERDR_FAKE_STATE/counter"
  printf '{"result":{"pane":{"pane_id":"w1:p%s"}}}\n' "$n"
elif [ "$1 $2" = "pane rename" ]; then
  echo "$4" > "$HERDR_FAKE_STATE/pane-$3"
  echo '{"result":{}}'
elif [ "$1 $2" = "agent start" ]; then
  identity=$3; shift 3; pane=""; cwd=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--pane" ]; then shift; pane=$1
    elif [ "$1" = "--cd" ]; then shift; cwd=$1
    fi
    shift
  done
  echo "$pane" > "$HERDR_FAKE_STATE/agent-pane-$identity"
  echo "$cwd" > "$HERDR_FAKE_STATE/agent-cwd-$identity"
  echo '{"result":{}}'
elif [ "$1 $2" = "agent get" ]; then
  identity=$3
  if [ ! -f "$HERDR_FAKE_STATE/agent-pane-$identity" ]; then exit 1; fi
  pane=$(tr -d '\n' < "$HERDR_FAKE_STATE/agent-pane-$identity")
  cwd=$(tr -d '\n' < "$HERDR_FAKE_STATE/agent-cwd-$identity")
  printf '{"result":{"agent":{"pane_id":"%s","cwd":"%s"}}}\n' "$pane" "$cwd"
elif [ "$1 $2" = "agent send-keys" ]; then
  touch "$HERDR_FAKE_STATE/plan-$3"
  echo '{"result":{}}'
elif [ "$1 $2" = "pane read" ]; then
  identity=""
  if [ -f "$HERDR_FAKE_STATE/pane-$3" ]; then identity=$(tr -d '\n' < "$HERDR_FAKE_STATE/pane-$3"); fi
  mode="Build mode"
  if [ -f "$HERDR_FAKE_STATE/plan-$identity" ]; then mode="Plan mode"; fi
  printf '{"result":{"output":"gpt-5.6-sol minimal low medium high xhigh %s"}}\n' "$mode"
elif [ "$1 $2" = "agent prompt" ]; then
  identity=$3
  if [ "$4" = "/quit" ]; then
    rm -f "$HERDR_FAKE_STATE/agent-cwd-$identity"
  else
    if ! mkdir "$HERDR_FAKE_STATE/prompt-lock-$identity" 2>/dev/null; then
      touch "$HERDR_FAKE_STATE/concurrent-$identity"
    fi
    sleep 0.05
    rmdir "$HERDR_FAKE_STATE/prompt-lock-$identity" 2>/dev/null || true
  fi
  echo '{"result":{"state":"idle"}}'
elif [ "$1 $2" = "agent read" ]; then
  echo '{"result":{"output":"agent response"}}'
else
  echo '{"result":{}}'
fi
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake, permissions).unwrap();
    let config_text = DEFAULT_CONFIG.replace(
        "command = \"herdr\"",
        &format!("command = {:?}", fake.display().to_string()),
    );
    let config = Config::parse(&config_text).unwrap();
    let environment = BTreeMap::from([
        ("HERDR_ENV".into(), "1".into()),
        ("HERDR_TAB_ID".into(), "w1:t1".into()),
        ("HERDR_FAKE_LOG".into(), log.display().to_string()),
        ("HERDR_FAKE_STATE".into(), state.display().to_string()),
    ]);
    let reviewer = config.agent_for_role("reviewer").unwrap().clone();
    let runtime = HerdrRuntime::with_environment(root.path(), config, environment);

    let first = runtime.bootstrap().await.unwrap();
    let second = runtime.bootstrap().await.unwrap();
    assert_eq!(first, second);
    let commands = fs::read_to_string(&log).unwrap();
    assert_eq!(commands.matches("pane split").count(), 5);
    assert!(commands.contains("agent send-keys lebang shift+tab"));

    let worktree = root.path().join("task-worktree");
    fs::create_dir(&worktree).unwrap();
    runtime
        .invoke(AgentInvocation {
            agent: reviewer.clone(),
            cwd: worktree.clone(),
            prompt: "first".into(),
            marker: "FIRST".into(),
            timeout: Duration::from_secs(1),
        })
        .await
        .unwrap();
    let request = |marker: &str| AgentInvocation {
        agent: reviewer.clone(),
        cwd: worktree.clone(),
        prompt: marker.into(),
        marker: marker.into(),
        timeout: Duration::from_secs(1),
    };
    let (left, right) = tokio::join!(
        runtime.invoke(request("LEFT")),
        runtime.invoke(request("RIGHT"))
    );
    left.unwrap();
    right.unwrap();

    let commands = fs::read_to_string(&log).unwrap();
    assert!(commands.contains("agent prompt curry /quit"));
    assert!(commands.contains(&format!("--cd {}", worktree.display())));
    assert!(!state.join("concurrent-curry").exists());
}

#[tokio::test]
async fn retries_a_busy_start_then_cleans_only_new_panes_on_bootstrap_failure() {
    let root = tempdir().unwrap();
    let fake = root.path().join("failing-herdr");
    let log = root.path().join("failing.log");
    let state = root.path().join("failing-state");
    fs::create_dir(&state).unwrap();
    fs::write(
        &fake,
        r#"#!/bin/sh
echo "$*" >> "$HERDR_FAKE_LOG"
if [ "$1 $2" = "pane current" ]; then
  echo '{"result":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1"}}}'
elif [ "$1 $2" = "agent get" ]; then
  exit 1
elif [ "$1 $2" = "pane split" ]; then
  n=1; if [ -f "$HERDR_FAKE_STATE/counter" ]; then n=$(tr -d '\n' < "$HERDR_FAKE_STATE/counter"); fi
  n=$((n + 1)); echo "$n" > "$HERDR_FAKE_STATE/counter"
  printf '{"result":{"pane":{"pane_id":"w1:p%s"}}}\n' "$n"
elif [ "$1 $2 $3" = "agent start curry" ]; then
  n=0; if [ -f "$HERDR_FAKE_STATE/curry" ]; then n=$(tr -d '\n' < "$HERDR_FAKE_STATE/curry"); fi
  n=$((n + 1)); echo "$n" > "$HERDR_FAKE_STATE/curry"
  if [ "$n" -eq 1 ]; then
    echo '{"error":{"code":"agent_pane_busy","message":"not a shell"}}' >&2
  else
    echo 'terminal start failure' >&2
  fi
  exit 1
elif [ "$1 $2" = "pane read" ]; then
  echo '{"result":{"output":"gpt-5.6-sol high Build mode"}}'
else
  echo '{"result":{}}'
fi
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake, permissions).unwrap();
    let config_text = DEFAULT_CONFIG
        .replace(
            "command = \"herdr\"",
            &format!("command = {:?}", fake.display().to_string()),
        )
        .replace("mode = \"plan\"", "mode = \"build\"")
        .replace("thinking = \"medium\"", "thinking = \"high\"");
    let runtime = HerdrRuntime::with_environment(
        root.path(),
        Config::parse(&config_text).unwrap(),
        BTreeMap::from([
            ("HERDR_ENV".into(), "1".into()),
            ("HERDR_TAB_ID".into(), "w1:t1".into()),
            ("HERDR_FAKE_LOG".into(), log.display().to_string()),
            ("HERDR_FAKE_STATE".into(), state.display().to_string()),
        ]),
    );

    assert!(
        runtime
            .bootstrap()
            .await
            .unwrap_err()
            .to_string()
            .contains("terminal start failure")
    );
    let commands = fs::read_to_string(log).unwrap();
    assert_eq!(commands.matches("agent start curry").count(), 2);
    assert!(commands.contains("pane close w1:p"));
    assert!(!commands.contains("pane close w1:p1\n"));
}
