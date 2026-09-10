#!/usr/bin/env python3
"""Contract fixture: reject mismatched CLI flags and retain per-pane shell state."""
import json
import os
import shlex
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as handle:
    handle.write(json.dumps(args) + "\n")
try:
    with open(os.environ["FAKE_STATE"]) as handle:
        state = json.load(handle)
except FileNotFoundError:
    state = {"counter": 1, "panes": {}, "agents": {}, "configs": {}}


def arg(name):
    return args[args.index(name) + 1]


result = {}
if args[:2] == ["pane", "current"]:
    result = {"pane_id": "w1:p1", "tab_id": "w1:t1"}
elif args[:2] == ["pane", "split"]:
    state["counter"] += 1
    pane = "w1:p" + str(state["counter"])
    state["panes"][pane] = {"pane_id": pane, "tab_id": "w1:t1", "cwd": arg("--cwd"), "env": {}}
    result = state["panes"][pane]
elif args[:2] == ["pane", "run"]:
    words = shlex.split(args[3])
    if words[0] == "cd":
        assert len(words) == 3 and words[1] == "--", words
        state["panes"][args[2]]["cwd"] = words[2]
    else:
        assert len(words) == 2 and words[0] == "export", words
        name, _, value = words[1].partition("=")
        state["panes"][args[2]]["env"][name] = value
elif args[:2] == ["pane", "process-info"]:
    result = {"process_info": {"shell_pid": 1, "foreground_process_group_id": 1}}
elif args[:2] == ["pane", "get"]:
    result = state["panes"][args[2]]
elif args[:2] == ["pane", "read"]:
    result = {"output": "gpt-5.6-sol high medium Context"}
elif args[:2] == ["agent", "get"]:
    if args[2] not in state["agents"]:
        sys.exit(1)
    result = state["agents"][args[2]]
elif args[:2] == ["agent", "start"]:
    identity, kind, pane = args[2], arg("--kind"), arg("--pane")
    native = args[args.index("--") + 1:]
    assert not any("\n" in value for value in native), native
    writable = identity == "kd"
    cwd = state["panes"][pane]["cwd"]
    if kind == "codex":
        cwd = arg("--cd")
    else:
        assert "--cd" not in native and "--sandbox" not in native, native
        if kind == "pi":
            assert arg("--thinking") == "high"
            assert ("bash" in arg("--tools").split(",")) == writable
            with open(arg("--append-system-prompt")) as handle:
                assert "Follow this role Skill" in handle.read()
            assert "--approve" in native and "--resume" not in native
        elif kind == "opencode":
            assert native[0] == cwd
            config = json.loads(state["panes"][pane]["env"]["OPENCODE_CONFIG_CONTENT"])
            assert config["small_model"] == "openai/gpt-5-mini"
            member = config["agent"][arg("--agent")]
            assert "Follow this role Skill" in member["prompt"]
            assert member["reasoningEffort"] == "high"
            assert member["permission"]["*"] == "deny"
            assert (member["permission"].get("bash") == "allow") == writable
            state["configs"][identity] = config
        elif kind == "gemini":
            assert "--thinking" not in native
            assert "--skip-trust" in native
            assert arg("--approval-mode") == "default"
            assert ("--include-directories" in native) == writable
            with open(arg("--policy")) as handle:
                policy = handle.read()
            assert 'decision = "deny"' in policy and 'decision = "allow"' in policy
            assert ("run_shell_command" in policy) == writable
            state["configs"][identity] = policy
        else:
            raise AssertionError(kind)
    session_kind = os.environ.get("SESSION_KIND", "id") if kind != "codex" else "id"
    session_value = identity + "-session"
    if session_kind == "path":
        session_value = os.path.join(cwd, identity + " session.jsonl")
    state["panes"][pane]["agent_session"] = {"agent": kind, "kind": session_kind, "value": session_value}
    state["agents"][identity] = {"agent": kind, "pane_id": pane, "cwd": cwd}
elif args[:2] == ["agent", "prompt"]:
    kind = state["agents"][args[2]]["agent"]
    if args[3] in ["/quit", "/exit"]:
        assert args[3] == ("/exit" if kind == "opencode" else "/quit")
        del state["agents"][args[2]]
    elif kind == "gemini":
        assert "Follow this role Skill" in args[3]
        assert "Herdr result transport" in args[3]
elif args[:2] == ["agent", "read"]:
    result = {"output": "task response"}

with open(os.environ["FAKE_STATE"], "w") as handle:
    json.dump(state, handle)
print(json.dumps({"result": result}))
