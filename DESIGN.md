# Design

## Goal

`lebang` is a small, observable orchestrator for one fixed class of workflow: a Codex team in Herdr working through Git-isolated tasks. It deliberately is not a generic agent framework, provider abstraction, queue, or database-backed scheduler.

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

Its interface has two operations: bootstrap the configured team and invoke one named identity in one cwd. That small interface hides current-tab topology, Codex launch configuration, footer calibration, cwd rebinding, identity mutexes, prompt transport, and screen reads. The two adapters make the seam real without leaking raw provider arguments into configuration.

`AgentRunner` sits above the seam and owns cross-runtime behavior: unique markers, parsing the last valid marked JSON result, schema validation, run records, and logs.

## Current-tab topology

Bootstrap starts with `herdr pane current --current`. The caller remains the coordination pane and keeps focus. A right split receives 80% of the tab, then splits down 50/50. The upper row contains planner then sorted coders; the lower row contains tester, reviewer, and integrator. Incremental remainder splits keep each row equal-width.

Every split has an explicit pane ID, repository cwd, and `--no-focus`. Pane rename and Codex start run together for each assignment. The completed topology is written to `herdr-layout.json`; later invocations compare repository, tab, normalized roster, live identity, and pane ID before reuse.

Bootstrap owns only panes it created. An incomplete bootstrap cleans those panes in reverse order. A completed layout is persisted before the planner is prompted, so planner failure preserves useful inspection state and a same-tab retry can reuse the team.

## Codex configuration

Herdr starts each identity with `--kind codex` and passes native Codex arguments after `--`. Model, cwd, alternate-screen behavior, sandbox, and approval are explicit. `developer_instructions`, `model_reasoning_effort`, and `plan_mode_reasoning_effort` are TOML-escaped `-c` overrides.

Planner/reviewer/integrator are read-only. Coder/tester use workspace-write. Approval is never. The footer is read after startup; plan/build mismatch is toggled once with `shift+tab`, then mode, model, and thinking are verified.

An identity mutex covers cwd inspection/rebinding, prompt submission, wait, and result read. Different coder identities remain parallel; singleton identities cannot overlap turns. Rebinding quits the old Codex process and starts a new one in the same pane and identity, preserving communication names and layout.

## Lifecycle invariants

- Plan task IDs are unique; dependencies exist and are acyclic.
- DAG work belongs to configured coders; tester, reviewer, and integrator are gates.
- A completed coder result has passed self-tests and an exact clean-worktree HEAD commit.
- Reported changed files equal the task commit range; implementation/refactor tasks include direct tests.
- Tester changes require an exact clean commit and may touch only test-support paths.
- Approved reviews have no issues; non-approved reviews have issues; replans include a plan-scoped issue.
- Integration accepts only approved/completed/integrating tasks and applies task-local commit ranges in DAG order.
- Completed runs cannot contain failed validation commands, and integrator evidence must exactly match locally observed commits and validations.

## Persistence and recovery

Task files are the live snapshots; `plan.json` preserves the DAG and is overlaid with task snapshots when read. Every state transition writes the task before appending its audit record. State and plan snapshots use fsync plus rename. History and run records preserve enough evidence to explain and resume a stopped run.

Locks contain task ID, PID, nonce, and timestamp. A live PID blocks another execution. A dead owner is removed and audited. The nonce prevents one recovery attempt from deleting a replacement lock.

Recovery treats committed, clean coder evidence as durable. It rechecks the commit, diff, declared files, and tests before advancing to independent testing. Integration/final-validation states resume through the idempotent integration worktree path.

## Compatibility

The Rust release is intentionally destructive at the packaging boundary: the only executable is `lebang`; Node/npm/Pi extension entry points and old JSON configuration are unsupported. The persisted operational JSON remains camelCase and compatible with existing plan/state/task/history/run fixtures.
