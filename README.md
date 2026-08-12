# lebang

`lebang` is a single Rust binary for running a small Codex team in Herdr. It turns one goal into a persisted task DAG, gives coder tasks isolated Git worktrees, gates every task through testing and review, and integrates approved commits in a separate worktree.

There is no Node.js runtime, npm package, Pi extension, or SDK fallback.

## Requirements

- Rust stable, for installation from source
- Git
- Herdr with `pane split`, `pane rename`, and named `agent` commands
- Codex CLI available to Herdr

The implementation baseline is Herdr 0.8.0 and Codex CLI 0.147.0. Runtime checks use capabilities and readable command errors rather than rejecting other versions by version number.

## Install

```sh
cargo install --path .
lebang --help
```

Release artifacts can instead distribute the `target/release/lebang` binary directly.

## Initialize a repository

```sh
cd /path/to/git/repository
lebang init
```

This creates `.orchestrator/config.toml` once. Existing files are never overwritten, and `init` does not require a Herdr session. Before planning, review every agent's model, mode, thinking effort, Skill, worker limits, and validation commands.

The generated schema is fixed:

```toml
max_workers = 1
max_review_attempts = 3
validation_commands = [
  ["git", "diff", "--check"],
]

[herdr]
command = "herdr"

[agents.lebang]
role = "planner"
agent = "codex"
model = "gpt-5.6-sol"
mode = "plan"
thinking = "high"
skill = "planner"

[agents.kd]
role = "coder"
agent = "codex"
model = "gpt-5.6-sol"
mode = "build"
thinking = "medium"
skill = "coder"

[agents.westbrook]
role = "tester"
agent = "codex"
model = "gpt-5.6-sol"
mode = "build"
thinking = "medium"
skill = "tester"

[agents.curry]
role = "reviewer"
agent = "codex"
model = "gpt-5.6-sol"
mode = "build"
thinking = "high"
skill = "reviewer"

[agents.duncan]
role = "integrator"
agent = "codex"
model = "gpt-5.6-sol"
mode = "build"
thinking = "high"
skill = "integrator"
```

Agent identities must match Herdr's `[a-z][a-z0-9_-]{0,31}` rule. A roster must contain exactly one planner, tester, reviewer, and integrator, plus at least one coder. Version 1 accepts only `agent = "codex"`; mode is `build` or `plan`; thinking is `minimal`, `low`, `medium`, `high`, or `xhigh`.

The bundled model value is an example. Availability depends on the user's Codex account. Codex is launched with explicit `--model`, `--cd`, `--no-alt-screen`, sandbox, and approval flags, plus `developer_instructions`, `model_reasoning_effort`, and `plan_mode_reasoning_effort` config overrides. Planner, reviewer, and integrator use a read-only sandbox; coder and tester use workspace-write; approval is `never` for unattended runs.

## Commands

```text
lebang [--repo PATH] [--config PATH] <COMMAND>

init
plan <GOAL>
run
status
task <ID>
retry <ID>
review <ID>
integrate
resume
graph
logs <ID>
```

`--repo` and `--config` are global Clap options and may appear before or after a subcommand:

```sh
lebang --repo /code/app status
lebang status --repo /code/app
lebang plan "add bounded retries" --config /tmp/team.toml
```

Read-only commands (`status`, `task`, `graph`, and `logs`) read persisted JSON without loading agent configuration. Commands that call agents require `.orchestrator/config.toml` or an explicit `--config`; there is no installed-config fallback and no support for the old `config.json`.

CLI, configuration, and protocol errors exit with code 2. A normal lifecycle result with JSON status `blocked` or `failed` is still a successful CLI invocation, so automation can inspect the structured status.

## Current-tab team layout

Run planning from a shell pane inside Herdr:

```sh
lebang plan "implement the goal"
```

`plan` keeps the caller focused as the left coordination pane, uses the right 80% for the team, and never calls `herdr tab create`:

```text
┌────────────┬──────────────────────────────────────────────────┐
│ caller     │ planner │ coder identities in sorted order      │
│ about 20%  ├─────────┴────────────────────────────────────────┤
│            │ tester  │ reviewer │ integrator                  │
└────────────┴──────────────────────────────────────────────────┘
```

The two agent rows are equal height, and panes in each row are equal width. Every split names an explicit source pane, preserves the repository cwd, and uses `--no-focus`. Pane labels and Herdr communication identities are the same, so direct inspection remains predictable:

```sh
herdr agent prompt lebang "summarize the plan" --wait
herdr agent prompt kd "report current task state" --wait
```

The normalized roster and pane IDs are saved in `.orchestrator/herdr-layout.json`. A retry in the same repository and tab can reuse a complete matching layout. A live same-name agent in another repository, tab, pane, or incompatible roster is reported as a conflict. If bootstrap fails, only panes created by that attempt are closed. Once the complete team is recorded, planner or later failures leave the team open for inspection and retry.

Agents are started one at a time, and each start gives Herdr 120 seconds to detect Codex readiness. Codex model and thinking state are then checked in the footer. Plan/build behavior is passed through developer instructions because current Codex versions no longer expose the collaboration-mode toggle. Coder and tester sessions also receive the repository `.git` directory through Codex `--add-dir`, allowing commits from linked task worktrees without granting write access to the main checkout. When a task moves an identity to a task or integration worktree, `lebang` exits Codex with `/quit` and starts it again in the same named pane with the new `--cd`. Per-identity async locks allow different coders to run concurrently while preventing one tester, reviewer, or other identity from receiving overlapping prompts or changing cwd mid-turn.

## Lifecycle and worktrees

The persisted task lifecycle is:

```text
pending → ready → running → self_verifying → testing → reviewing
                                                ↘ changes_requested → reworking
                                                ↘ approved → integrating → completed
```

`blocked`, `failed`, `interrupted`, and `invalidated` are explicit recoverable or terminal states where allowed by the state machine.

Coder branches and worktrees use:

```text
branch:   agent/<identity>/<task-id>
worktree: .worktrees/<task-id>-<identity>
```

If a generated worktree directory was removed outside Lebang, its exact prunable Git registration is removed before recreation. An unrecorded generated branch is fast-forwarded when safe; divergent commits are preserved under `archive/agent/<identity>/<task-id>/<commit>` before the task branch is reset to the current orchestration base.

Dependencies are cherry-picked into a dependent task before its local `baseCommit` is recorded. This keeps `baseCommit..commit` limited to that task's own commits. Tester commits may contain only declared test-support paths. Integration uses:

```text
branch:   orchestrator/<run-id>/integration
worktree: .worktrees/<run-id>-<integrator>
```

Only approved task commit ranges are integrated in DAG order. Every configured validation command runs in the integration worktree before the integrator can report completion.

## Persistence and recovery

State is human-readable under `.orchestrator/`:

```text
.orchestrator/
├── config.toml
├── herdr-layout.json
├── plan.json
├── state.json
├── tasks/<task-id>.json
├── runs/<task-id>/<role>/<run-id>.json
├── logs/<task-id>-<identity>-<run-id>.log
├── history/run.jsonl
├── history/<task-id>.jsonl
└── locks/<task-id>.lock
```

Plan, state, task, history, log metadata, and run records preserve the existing camelCase JSON protocol. Fixtures produced by the earlier Python/TypeScript implementations are read by the Rust version. JSON snapshots use atomic temporary-file replacement; history is append-only JSONL; task locks use exclusive creation and recover dead-owner PIDs.

Useful recovery commands:

```sh
lebang status
lebang logs T1
lebang retry T1
lebang review T1
lebang resume
lebang integrate
```

`resume` detects work left during coding, testing, review, integration, or final validation. A clean committed coder result can be revalidated from its run record and continue at independent testing without redoing implementation.

## Role Skills

Planner, coder, tester, reviewer, and integrator Skills are compiled into the binary. A repository may override one with `.skills/<skill>/SKILL.md`. The role Skill, identity, role, and full roster are injected through Codex `developer_instructions` on every start.

## Development

The required local gate is:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

Tests use temporary Git repositories, the in-memory `AgentRuntime` adapter, and fake Herdr executables. They do not require a live Herdr session. A real Herdr smoke test remains an explicit manual/opt-in acceptance step because it changes the current terminal layout.

From a Herdr shell, opt in with an initialized disposable repository:

```sh
LEBANG_REAL_HERDR_SMOKE=1 \
LEBANG_REAL_HERDR_REPO=/path/to/disposable/repo \
cargo test --test real_herdr_smoke -- --ignored --nocapture
```
