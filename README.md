# lebang-orchestrator

`lebang-orchestrator` is a small, observable Pi package for coordinating coding
agents through role Skills, Git worktrees, filesystem state, and optional Herdr
workspaces.

It implements this lifecycle:

```text
PLAN -> IMPLEMENT -> SELF_VERIFY -> INDEPENDENT_TEST -> REVIEW
     -> REWORK / REPLAN -> INTEGRATE -> FINAL_VALIDATE -> COMPLETE
```

Agents run through the `@earendil-works/pi-coding-agent` SDK in-process. The
orchestrator never starts a `pi` subprocess. Git commits and worktrees isolate
production tasks, while `.orchestrator/` remains the resumable source of truth.

## Requirements

- Node.js 22.19 or newer
- Git
- Pi `0.84.1` with a configured provider
- Herdr 0.8+ only when enabled in `.orchestrator/config.json`

## Install

For local development:

```bash
npm install
npm run build
npm link
orchestrator --help
```

Install the extension and Skills into Pi from this checkout:

```bash
pi install /absolute/path/to/lebang-orchestrator
```

This provides both entry points:

```text
orchestrator plan "Implement feature X"
/orchestrator plan "Implement feature X"
```

The Pi extension registers only `/orchestrator`. It does not register a
model-callable tool or a separate TUI. Command results appear as a visible
custom message without triggering a model turn.

## Commands

```bash
orchestrator plan "Implement feature X"
orchestrator run
orchestrator status
orchestrator task T1
orchestrator retry T1
orchestrator review T1
orchestrator integrate
orchestrator resume
orchestrator graph
orchestrator logs T1
```

The same subcommands are available after `/orchestrator`. Use `--repo
/path/to/repository` to target another Git repository and `--config
/path/to/config.json` to select an explicit configuration.

Configure agent identities, roles, role Skills, models, concurrency, review
limits, Herdr, and final validation commands in `.orchestrator/config.json`.
Models belong only in configuration; Skills never select models. The legacy
`piCommand` field is still accepted when reading Python-era configuration, but
it is ignored because execution now uses the SDK.

## Execution model

`plan` asks `lebang` for a TypeBox-validated task DAG. `run` schedules a
deterministic batch of ready tasks up to `maxWorkers`, never running two tasks
with the same owner concurrently. Every production task gets:

```text
branch:   agent/<identity>/<task>
worktree: .worktrees/<task>-<identity>
```

The original coder owns task-local rework. Test-only review findings return to
`westbrook`; plan-scoped findings return to `lebang`. After every active task is
approved, `duncan` integrates task commits on an isolated
`orchestrator/<run>/integration` branch. The user's current branch is not
modified.

Each SDK run uses an independent persisted Pi session, the task worktree as its
cwd, the configured model/thinking suffix, a strict role tool allowlist, and
only the current role Skill. Extension discovery is disabled in child sessions
to prevent recursive loading, while target-repository `AGENTS.md` context is
preserved.

## Persistence and recovery

Runtime data stays plain and inspectable:

```text
.orchestrator/
  config.json
  plan.json
  state.json
  tasks/<task>.json
  runs/<task>/<role>/<run>.json
  runs/<task>/<role>/sessions/*.jsonl
  logs/<task>-<agent>-<run>.log
  history/<task>.jsonl
  locks/<task>.lock
.worktrees/
  <task>-<coder>/
  <run>-<integrator>/
```

Every SDK run records identity, role, model, cwd, timestamps, exit code, JSONL
events, stderr, and the parsed structured result. JSON state writes are atomic,
history appends are fsynced, and task locks remove stale PIDs before recovery.

The camelCase state format is compatible with the previous Python release.
`orchestrator resume` and `orchestrator retry` can continue existing
`.orchestrator` data when persisted evidence still matches a clean Git commit.
A worktree's existence alone never proves completion.

Role Skills are packaged under `skills/`. A target repository can override one
by providing `.skills/<role>/SKILL.md`.

## Development

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

Tests use temporary Git repositories and fake SDK sessions. They do not require
credentials, API calls, or paid tokens. The package intentionally excludes
databases, distributed queues, remote worker fleets, dashboards, custom model
provider layers, extra TUIs, and unbounded automatic retries.
