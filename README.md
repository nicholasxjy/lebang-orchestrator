# lebang

`lebang` is a single Rust binary for running mixed Codex, OpenCode, Pi, and Gemini teams in Herdr, with Claude Code support also retained. Each identity can select its own agent type and model. It turns one goal into a persisted task DAG, gives coder tasks isolated Git worktrees, gates every task through testing and review, and integrates approved commits in a separate worktree.

Lebang itself is a standalone Rust binary; agent CLIs run as separate processes.

## Requirements

- Rust 1.89 or newer, for installation from source
- Git
- Herdr with `pane split`, `pane rename`, and named `agent` commands
- The configured CLIs (`codex`, `opencode`, `pi`, `gemini`, `claude`) installed and authenticated in Herdr's shell environment

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

The generated configuration defaults to an all-Codex roster and remains compatible with existing configurations:

```toml
max_workers = 1
max_review_attempts = 3
agent_timeout_seconds = 3600
validation_timeout_seconds = 3600
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

Agent identities and Skill names must match `[a-z][a-z0-9_-]{0,31}`. A roster must contain exactly one planner, tester, reviewer, and integrator, plus at least one coder. Each identity independently chooses `agent = "codex"`, `"opencode"`, `"pi"`, `"gemini"`, or `"claude"`. Mode is `build` or `plan` and is supplied through role instructions. Omit `thinking` or set it to `"default"` to use the native CLI/model configuration.

| Agent type | Thinking values | Native configuration |
| --- | --- | --- |
| `codex` | `minimal`, `low`, `medium`, `high`, `xhigh` | `--model`, `-c model_reasoning_effort`, `--cd`, role sandbox |
| `opencode` | `minimal`, `low`, `medium`, `high`, `xhigh` | `--model provider/model`, named primary agent, scoped inline configuration; explicit thinking becomes the provider's `reasoningEffort` option |
| `pi` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `--model` (also accepts `provider/model`), `--thinking`, `--append-system-prompt`, role tool allowlist |
| `gemini` | `default` only | `--model`, role policy file, instructions included with every task prompt; thinking remains controlled by Gemini's native model configuration |
| `claude` | `low`, `medium`, `high`, `xhigh`, `max` | `--model`, `--effort`, `--append-system-prompt-file`, explicit tools and `dontAsk` permissions |

All types accept `default`. Model availability and supported effort levels depend on the installed CLI and account. OpenCode explicit thinking is intended for providers that support `reasoningEffort` (such as OpenAI); omit it for other providers. Unsupported agent types or type/effort combinations fail during configuration parsing. Both timeout settings are positive seconds, defaulting to 3600 when omitted.

For a complete six-person Codex + OpenCode + Pi + Gemini team with two concurrent coders, use [examples/mixed-agents.toml](examples/mixed-agents.toml). It assigns Codex to planning/integration, OpenCode and Pi to coding, Pi to testing, and Gemini to review. Set real validation commands for the target repository before running:

```sh
lebang --config /path/to/mixed-agents.toml plan "implement the goal"
lebang --config /path/to/mixed-agents.toml run
```

Use the same configuration for subsequent lifecycle commands. A recorded layout must match its repository, tab, identities, and complete configuration; mismatches fail before prompting an agent.

Codex is launched with explicit `--model`, `--cd`, `--no-alt-screen`, sandbox, and approval flags, plus `developer_instructions`, `model_reasoning_effort`, and `plan_mode_reasoning_effort` config overrides. Planner, reviewer, and integrator use a read-only sandbox; coder and tester use workspace-write; approval is `never` for unattended runs.

Claude Code receives its instructions through a file so multiline Skills survive Herdr's shell argument encoding. Read-only roles receive `Read,Glob,Grep`; coder and tester additionally receive `Bash,Edit,Write`. `dontAsk` denies unapproved operations without prompting, and these selected tools are explicitly allowed. MCP tools are disabled for these sessions. These are Claude tool permissions, not a Codex filesystem sandbox. Its native flags follow the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

OpenCode receives a generated named primary agent through `OPENCODE_CONFIG_CONTENT` in its own pane. Existing inline provider settings are preserved; the generated agent supplies role instructions and denies tools outside its allowlist. Native options follow the [OpenCode CLI](https://opencode.ai/docs/cli/) and [agent configuration](https://opencode.ai/docs/agents/) documentation.

Pi receives an appended prompt file and an explicit tool allowlist: read/grep/find/ls for read-only roles, plus bash/edit/write for coders and testers. `--approve` trusts the selected project for that session, preventing a project-trust question during an unattended start. Native options follow the [Pi CLI documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

Gemini uses `--policy` with a generated role allowlist and `--approval-mode default`; every task prompt includes the role Skill. `--skip-trust` trusts the selected workspace for that session. The adapter preserves Gemini's existing settings and system prompt. It requires a CLI exposing these flags, as documented in the [native argument parser](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts) and [policy engine](https://geminicli.com/docs/reference/policy-engine/). OpenCode, Pi, Gemini, and Claude use native tool permissions; only Codex's adapter configures a filesystem sandbox.

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

The normalized roster and pane IDs are saved in `.orchestrator/herdr-layout.json`. A retry in the same repository and tab can reuse a complete matching layout. Native session references reported by Herdr are stored in `.orchestrator/agent-sessions.json`, keyed by agent type, identity, and working directory. Both ID and file references are supported for Pi and Gemini; older bare-ID records remain readable. An exited agent resumes that specific session; if no supported reference was reported, it starts fresh with the task context. A live same-name agent in another pane or of another type is reported as a conflict. An agent still working or awaiting input is not sent an overlapping retry. If bootstrap fails, only panes created by that attempt are closed. Once the complete team is recorded, planner or later failures leave the team open for inspection and retry.

Agents are started one at a time, and each start gives Herdr 120 seconds to detect readiness. Codex's explicit model/thinking settings are checked in the footer; other types use Herdr's agent detection. Writable roles receive access to shared Git metadata through the native adapter where required. Rebinding exits Codex, Pi, and Gemini with `/quit`, or OpenCode and Claude with `/exit`. Codex uses `--cd`; other types wait for the pane's shell, change its cwd with a quoted `cd`, verify cwd, and then start. Per-identity async locks prevent overlapping prompts; a repository-level file lock prevents separate CLI commands from concurrently mutating the same run. Read-only commands remain available.

| Type | Resume argument |
| --- | --- |
| Codex | `resume ID` |
| OpenCode | `--session ID` |
| Pi | `--session ID_OR_FILE` |
| Gemini | `--resume ID` or `--session-file FILE` |
| Claude Code | `--resume ID` |

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

Only approved task commit ranges are integrated in DAG order. Repeated integration verifies the already applied prefix against approved patches, so a crash before JSON state is saved does not duplicate commits. A failed cherry-pick is aborted while preserving earlier successful picks. Every configured validation command runs in the integration worktree before the integrator can report completion. Missing commands, failures, and timeouts are persisted as failed validation evidence. Validation and review must leave the tested commit and worktree unchanged.

Independent test failures cannot be approved. Test-only rework includes the reviewer's issues in the tester prompt. Replanning waits for the active batch to finish, reloads current task evidence, preserves approved/completed tasks, and requires fresh IDs for replacement tasks.

## Persistence and recovery

State is human-readable under `.orchestrator/`:

```text
.orchestrator/
├── config.toml
├── herdr-layout.json
├── agent-sessions.json
├── agent-prompts/<identity>.txt
├── agent-config/<identity>.opencode.json
├── agent-config/<identity>.gemini.toml
├── plan.json
├── state.json
├── tasks/<task-id>.json
├── runs/<task-id>/<role>/<run-id>.json
├── logs/<task-id>-<identity>-<run-id>.log
├── history/run.jsonl
├── history/<task-id>.jsonl
└── locks/<task-id>.lock
```

Plan, state, task, history, log metadata, and run records preserve the existing camelCase JSON protocol. Run records now also include `agentKind`; older records without it remain readable. Fixtures produced by the earlier Python/TypeScript implementations are read by the Rust version. JSON snapshots use atomic temporary-file replacement; initialization publishes the plan only after task and state snapshots exist. History is append-only JSONL; task locks recover dead-owner PIDs, and the orchestration lock is automatically released by the OS on process exit.

Useful recovery commands:

```sh
lebang status
lebang logs T1
lebang retry T1
lebang review T1
lebang resume
lebang integrate
```

`resume` detects work left during coding, testing, review, integration, or final validation. A clean committed coder result can be revalidated from its run record and continue at independent testing without redoing implementation. If an agent completed its work but omitted a valid marked result, `retry` continues the same session and asks it only to resend the structured result with a fresh marker.

## Role Skills

Planner, coder, tester, reviewer, and integrator Skills are compiled into the binary. A repository may override one with `.skills/<skill>/SKILL.md`. The role Skill, identity, role, and full roster are passed through Codex developer instructions, OpenCode's agent prompt, Pi/Claude appended prompts, or every Gemini task prompt.

## Development

The required local gate is:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

Tests require Git, a POSIX shell, and Python 3 for executable Herdr fixtures. They use temporary Git repositories and the in-memory `AgentRuntime` adapter and do not require a live Herdr session. A real Herdr smoke test remains an explicit manual/opt-in acceptance step because it changes the current terminal layout.

From a Herdr shell, opt in with an initialized disposable repository:

```sh
LEBANG_REAL_HERDR_SMOKE=1 \
LEBANG_REAL_HERDR_REPO=/path/to/disposable/repo \
cargo test --test real_herdr_smoke -- --ignored --nocapture
```
