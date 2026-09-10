# Design

## Goal

`lebang` is a small, observable orchestrator for mixed Codex, OpenCode, Pi, Gemini, and Claude Code teams in Herdr working through Git-isolated tasks. Agent types are a closed configuration enum with explicit native launch adapters; the application remains a Git-backed task scheduler rather than a general provider framework.

The binary owns four things:

1. validate a fixed team configuration and task/result contracts;
2. persist and recover the lifecycle;
3. isolate task and integration changes with Git worktrees;
4. transport role prompts and marked JSON results through named Herdr agents.

## Deep modules

The CLI is intentionally shallow. Clap parses the command and global paths; `cli::execute` chooses read-only output or delegates a lifecycle operation. Protocol errors become exit code 2, while normal blocked/failed lifecycle values remain JSON results.

`Orchestrator` is the primary deep module. Its public interface is the command lifecycle (`plan_goal`, `run`, `retry`, `review_task`, `integrate`, and `resume`). Scheduling, evidence checks, rework/replan routing, state transitions, final validation, and integration failure reporting stay local to its implementation.

`RunStore` is a concrete deep module rather than a storage trait. It owns the on-disk camelCase protocol, atomic JSON replacement, JSONL history, result lookup, plan replacement, and recoverable exclusive locks.

`GitManager` is also concrete. It serializes topology-changing worktree commands, records dependency-aware base commits, validates commit ancestry and clean trees, and integrates task ranges in topological order.

## The one runtime seam

`AgentRuntime` is the only provider seam:

```text
Orchestrator → AgentRunner → AgentRuntime
                              ├── HerdrRuntime
                              └── RecordingRuntime (tests)
```

Its interface has two operations: bootstrap the configured team and invoke one named identity in one cwd. It hides current-tab topology, native agent launch configuration, readiness checks, cwd rebinding, identity mutexes, prompt transport, and screen reads. Agent-kind differences stay inside the runtime; scheduling and evidence validation are shared.

The private `agent_launch` module produces native arguments, generated prompt/policy/config files, and pane-local environment overrides. It keeps five CLI dialects out of scheduling and separates launch configuration from Herdr's process/layout protocol.

`AgentRunner` sits above the seam and owns cross-runtime behavior: unique markers, parsing the last valid marked JSON result, schema validation, run records, and logs.

## Current-tab topology

Bootstrap starts with `herdr pane current --current`. The caller remains the coordination pane and keeps focus. A right split receives 80% of the tab, then splits down 50/50. The upper row contains planner then sorted coders; the lower row contains tester, reviewer, and integrator. Incremental remainder splits keep each row equal-width.

Every split has an explicit pane ID, repository cwd, and `--no-focus`. Pane rename and native agent start run together for each assignment. The completed topology is written to `herdr-layout.json`; later invocations compare repository, tab, normalized roster, live identity, and pane ID before reuse.

Bootstrap owns only panes it created. An incomplete bootstrap cleans those panes in reverse order. A completed layout is persisted before the planner is prompted, so planner failure preserves useful inspection state and a same-tab retry can reuse the team.

## Agent configuration

Herdr starts each identity with its configured `--kind` and passes native arguments after `--`. For Codex, model, cwd, alternate-screen behavior, sandbox, and approval are explicit. `developer_instructions`, `model_reasoning_effort`, and `plan_mode_reasoning_effort` are TOML-escaped `-c` overrides. Omitted/default thinking preserves the CLI's own reasoning configuration.

For Codex, planner/reviewer/integrator are read-only, coder/tester use workspace-write, and approval is never. Model and thinking are checked in the footer; plan/build behavior is passed in role instructions. No UI mode toggle is used.

Claude uses native model/effort flags and an appended system-prompt file. Read-only roles receive only Read/Glob/Grep tools. Writable roles also receive Bash/Edit/Write. Explicit tool allow rules plus `dontAsk` provide unattended operation; these are tool permissions, not an OS sandbox. MCP tools are disabled. Its cwd is set in the pane's shell before launch because it has no Codex-style `--cd` flag.

OpenCode uses a named primary agent supplied through pane-local `OPENCODE_CONFIG_CONTENT`. The adapter preserves existing inline provider settings, adds role instructions and a tool allowlist, and passes the project directory as a positional argument. Explicit thinking maps to the provider-specific `reasoningEffort` option; default thinking works with other providers without injecting that option.

Pi uses a prompt file, `--thinking`, and a built-in tool allowlist. Gemini uses a generated policy file and receives role instructions with every task prompt. Gemini's reasoning configuration stays native; explicit unsupported thinking levels are rejected. Both CLIs start after switching and verifying the pane's shell cwd. Session-local project trust flags prevent startup trust questions in the selected repository; authentication remains the responsibility of the installed CLI.

Native session references are persisted by type, identity, and cwd. References retain their ID/path distinction; Pi and Gemini can restore a session file, while all adapters support their native ID form. Older bare-ID records remain readable. Retries never select an unrelated global or directory-wide "last session". Marked-result recovery carries the original JSON context when a new session is necessary. Run records carry an optional `agentKind` field for compatibility with legacy records.

An identity mutex covers cwd inspection/rebinding, prompt submission, wait, and result read. Different coder identities remain parallel; singleton identities cannot overlap turns. Rebinding uses the native exit command and starts a new process in the same pane and identity, preserving communication names and layout.

## Lifecycle invariants

- Plan task IDs are unique; dependencies exist and are acyclic.
- DAG work belongs to configured coders; tester, reviewer, and integrator are gates.
- A completed coder result has passed self-tests and an exact clean-worktree HEAD commit.
- Reported changed files equal the task commit range; implementation/refactor tasks include direct tests.
- Tester changes must descend from the coder commit, match declared test-support paths, and leave a clean tree. Recovering after a tester commit rechecks the coder's original range and the test-only extension.
- Failed independent tests cannot be approved. Review and final validation cannot silently change the checked commit or worktree.
- Approved reviews have no issues; non-approved reviews have issues; replans include a plan-scoped issue.
- Integration accepts only approved/completed/integrating tasks and applies task-local commit ranges in DAG order.
- Completed runs cannot contain failed validation commands, and integrator evidence must exactly match locally observed commits and validations.
- Replanning happens after the current batch settles. Approved/completed task records are immutable; replacements use fresh task IDs.
- Validation failures, missing executables, and timeouts produce durable failure evidence. On Unix, timeout/cancellation terminates the validation process group.

## Persistence and recovery

Task files are the live snapshots; `plan.json` preserves the DAG and is overlaid with task snapshots when read. Every state transition writes the task before appending its audit record. State and plan snapshots use fsync plus rename. History and run records preserve enough evidence to explain and resume a stopped run.

An OS file lock serializes mutating orchestration commands for each store, including across CLI processes. The lock inode is retained, and process exit releases the lock. Per-task locks contain task ID, PID, nonce, and timestamp; a live PID blocks execution and a dead owner is removed and audited. Lock failures cannot mark another execution's task failed.

Recovery treats committed, clean coder and test-only tester evidence as durable. It rechecks the commit, diff, declared files, and tests before advancing to independent testing, including tasks interrupted during review. Integration reconstructs its applied prefix from Git, checks patch identities in DAG order, and applies only missing commits. This survives a stop between cherry-picking and saving JSON state. Failed picks are aborted without discarding the successful prefix. Recreated task worktrees retain their recorded task base.

## Compatibility

The Rust release is intentionally destructive at the packaging boundary: the only executable is `lebang`; Node/npm/Pi extension entry points and old JSON configuration are unsupported. The persisted operational JSON remains camelCase and compatible with existing plan/state/task/history/run fixtures.
