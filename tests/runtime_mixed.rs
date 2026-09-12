#![cfg(unix)]

use lebang_orchestrator::{
    config::{AgentKind, Config, DEFAULT_CONFIG},
    runtime::{AgentInvocation, AgentRuntime, HerdrRuntime},
};
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, time::Duration};
use tempfile::tempdir;

#[tokio::test]
async fn mixed_team_uses_native_arguments_and_rebinds_claude_in_its_pane() {
    let root = tempdir().unwrap();
    let fake = root.path().join("herdr");
    let state = root.path().join("fake.json");
    let log = root.path().join("commands.jsonl");
    fs::write(&fake, r#"#!/usr/bin/env python3
import json, os, sys, shlex
args = sys.argv[1:]
with open(os.environ['FAKE_LOG'], 'a') as f: f.write(json.dumps(args) + '\n')
try:
    with open(os.environ['FAKE_STATE']) as f: state = json.load(f)
except FileNotFoundError: state = {'panes': {}, 'agents': {}, 'counter': 1}
def arg(name): return args[args.index(name) + 1]
result = {}
if args[:2] == ['pane', 'current']:
    result = {'pane_id':'w1:p1', 'tab_id':'w1:t1'}
elif args[:2] == ['pane', 'split']:
    state['counter'] += 1
    pane = 'w1:p' + str(state['counter'])
    state['panes'][pane] = {'cwd':arg('--cwd'), 'pane_id':pane, 'tab_id':'w1:t1'}
    result = state['panes'][pane]
elif args[:2] == ['pane', 'run']:
    words = shlex.split(' '.join(args[3:]))
    assert words[0] == 'cd', words
    state['panes'][args[2]]['cwd'] = words[-1]
elif args[:2] == ['pane', 'get']:
    result = state['panes'][args[2]]
elif args[:2] == ['pane', 'process-info']:
    result = {'process_info': {'shell_pid':1, 'foreground_process_group_id':1}}
elif args[:2] == ['agent', 'start']:
    kind = arg('--kind')
    pane = arg('--pane')
    native = args[args.index('--')+1:]
    assert not any('\n' in a for a in native), native
    if kind == 'claude':
        assert '--cd' not in native and '--sandbox' not in native
        assert '--effort' in native and '--append-system-prompt-file' in native
        assert arg('--permission-mode') == 'dontAsk'
        assert arg('--disallowedTools') == 'mcp__*'
        assert ('Bash' in arg('--tools')) == (args[2] == 'kd')
        with open(arg('--append-system-prompt-file')) as f: assert 'Follow this role Skill' in f.read()
        cwd = state['panes'][pane]['cwd']
    else:
        cwd = arg('--cd')
    result = {'pane_id':pane, 'cwd':cwd, 'kind':kind}
    state['agents'][args[2]] = result
    state['panes'][pane]['agent'] = kind
    state['panes'][pane]['agent_session'] = {'agent':kind, 'kind':'id', 'value':args[2] + '-session'}
elif args[:2] == ['agent', 'get']:
    if args[2] not in state['agents']: sys.exit(1)
    result = state['agents'][args[2]]
elif args[:2] == ['agent', 'prompt'] and args[3] in ['/quit', '/exit']:
    state['agents'].pop(args[2], None)
elif args[:2] == ['pane', 'read']:
    result = {'output':'gpt-5.6-sol high medium Context'}
elif args[:2] == ['agent', 'read']:
    result = {'output':'response'}
with open(os.environ['FAKE_STATE'], 'w') as f: json.dump(state, f)
print(json.dumps({'result':result}))
"#).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let mut config = Config::parse(&DEFAULT_CONFIG.replace(
        "[agents.kd]\nrole = \"coder\"\nagent = \"codex\"\nmodel = \"gpt-5.6-sol\"",
        "[agents.kd]\nrole = \"coder\"\nagent = \"claude\"\nmodel = \"sonnet\"",
    ))
    .unwrap();
    let reviewer = config.agents.get_mut("curry").unwrap();
    reviewer.agent = AgentKind::Claude;
    reviewer.model = "sonnet".into();
    config.herdr.command = fake.to_string_lossy().into_owned();
    let coder = config.agents["kd"].clone();
    let runtime = HerdrRuntime::with_environment(
        root.path(),
        config,
        BTreeMap::from([
            ("HERDR_ENV".into(), "1".into()),
            ("HERDR_TAB_ID".into(), "w1:t1".into()),
            ("FAKE_STATE".into(), state.to_string_lossy().into_owned()),
            ("FAKE_LOG".into(), log.to_string_lossy().into_owned()),
        ]),
    );
    let layout = runtime.bootstrap().await.unwrap();
    let worktree = root.path().join("task's worktree $literal");
    fs::create_dir(&worktree).unwrap();
    let request = || AgentInvocation {
        agent: coder.clone(),
        cwd: worktree.clone(),
        prompt: "task".into(),
        marker: "RESULT".into(),
        timeout: Duration::from_secs(1),
        resume_session: false,
    };
    runtime.invoke(request()).await.unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&state).unwrap()).unwrap();
    assert_eq!(
        saved["agents"]["kd"]["cwd"],
        worktree.to_string_lossy().as_ref()
    );
    assert_eq!(
        saved["agents"]["kd"]["pane_id"],
        layout.agents["kd"].pane_id
    );
    let mut saved = saved;
    saved["agents"].as_object_mut().unwrap().remove("kd");
    fs::write(&state, serde_json::to_vec(&saved).unwrap()).unwrap();
    let mut retry = request();
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
    assert!(starts.last().unwrap().contains(&"--resume".into()));
    assert!(starts.last().unwrap().contains(&"kd-session".into()));
}
