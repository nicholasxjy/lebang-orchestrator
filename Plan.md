You are implementing a practical multi-agent coding orchestration system for the following toolchain:

* Pi CLI: executes coding agents and different models
* Herdr: provides the human-visible workspace / agent pane environment
* Skills: define reusable behavior contracts for each role
* git worktree: isolates concurrent coding tasks
* Git: provides task ownership, commits, integration, and recovery boundaries

The system must remain small, observable, resumable, git-native, and easy to debug.

Do NOT build a generic autonomous-agent framework.

Do NOT introduce databases, distributed queues, custom RPC systems, or large provider abstraction layers unless the existing repository already requires them.

The preferred architecture is a thin orchestration layer around Pi CLI, Skills, Herdr, filesystem state, and git worktrees.

# 1. Final Agent Team

Use these logical agent identities.

## Fixed roles

* `lebang` — Planner / Orchestrator
* `westbrook` — Tester
* `curry` — Reviewer
* `duncan` — Integrator

## Coder pool

* `kd` — primary/default Coder
* `harden` — Coder
* `sga` — Coder
* `luka` — Coder
* `kawhi` — Coder
* `tatum` — Coder
* `booker` — Coder
* `giannis` — Coder
* `jokic` — Coder

These are logical agent identities, not model IDs.

Keep the following concepts separate:

Agent identity
!=
Role
!=
Skill
!=
Model

Example:

agent = harden
role = coder
skill = coder
model = configured Pi model

Never encode role behavior by hard-coding player names throughout the code.

Bad:

if (agent === "curry") {
review()
}

Good:

if (agent.role === "reviewer") {
review()
}

Names identify agents.

Roles drive orchestration behavior.

Skills define behavior contracts.

Models define execution capability.

# 2. High-Level Workflow

The target lifecycle is:

User Goal
↓
lebang
↓
Plan + Task DAG
↓
Coder workers
↓
Coder self-verification
↓
westbrook
↓
curry
↓
Rework / Replan if necessary
↓
duncan
↓
Final repository validation
↓
Complete

More explicitly:

PLAN
→ IMPLEMENT
→ SELF_VERIFY
→ INDEPENDENT_TEST
→ REVIEW
→ REWORK / REPLAN
→ INTEGRATE
→ FINAL_VALIDATE
→ COMPLETE

# 3. Core Responsibility Boundaries

## lebang — Planner / Orchestrator

lebang owns:

* understanding the user's high-level goal
* inspecting the repository
* identifying existing project conventions
* creating the implementation plan
* decomposing work into tasks
* defining acceptance criteria
* constructing the task DAG
* defining dependencies
* identifying tasks that can run in parallel
* assigning coder workers
* monitoring task states
* responding to blocked/failed work
* replanning when curry requests it
* escalating when retry limits are exceeded
* determining when the overall goal is complete

lebang decides:

WHAT should be done

WHY it should be done

ORDER / dependencies

WHO owns each task

lebang should NOT normally implement production code.

The Planner Skill must explicitly contain:

"Do not perform implementation work that can reasonably be delegated to a worker."

lebang may make trivial orchestration-only changes when required, but production feature work should belong to coders.

## Coder pool

All coder agents use the same fundamental `coder` Skill.

Coder responsibilities:

* work only on the assigned task
* operate inside the assigned git worktree
* implement production code
* write the most direct task-local unit tests
* run relevant tests
* perform self-verification
* commit successful work
* return structured results
* handle rework for their own task

Important rule:

Whoever writes production code also owns the most direct tests for that code.

Do not make westbrook responsible for basic unit-test coverage that belongs naturally with implementation.

## westbrook — Tester

westbrook independently validates completed coder work.

westbrook owns:

* validating acceptance criteria
* identifying missing edge cases
* adding regression tests
* adding integration tests where appropriate
* testing interactions across task boundaries
* trying to invalidate coder assumptions
* producing reproducible failure reports

westbrook should NOT normally modify production code.

westbrook may modify:

* test files
* fixtures
* mocks
* test helpers
* test utilities

If westbrook discovers a production bug:

westbrook reports it
→ task returns to its owning coder

westbrook does not silently fix the production implementation.

## curry — Reviewer

curry decides whether completed work is acceptable.

curry receives:

* original task
* acceptance criteria
* coder result
* westbrook result
* git diff
* relevant test results

curry must return exactly one of:

* `approved`
* `changes_requested`
* `replan_required`

### approved

The implementation satisfies the task and can proceed toward integration.

### changes_requested

The issue is local to one or more existing tasks.

Examples:

* implementation bug
* missing task-local test
* weak error handling
* maintainability issue
* missed edge case
* regression
* task did not fully satisfy acceptance criteria

Return the issue to the original owner whenever possible.

### replan_required

The current plan itself is incorrect or insufficient.

Examples:

* wrong task decomposition
* incompatible APIs between parallel tasks
* invalid architecture assumption
* cross-task design conflict
* acceptance criteria cannot be satisfied cleanly under the current plan

Return control to lebang.

curry should identify:

* what is wrong
* why it matters
* expected behavior
* affected task
* severity
* whether the issue is task-level or plan-level

curry should NOT normally take over implementation.

## duncan — Integrator

duncan owns:

* integrating approved commits
* cherry-picking or merging task branches
* resolving trivial merge conflicts
* running repository-wide validation
* detecting integration failures
* confirming the original user goal is satisfied

duncan should not redesign features during integration.

If integration exposes a local implementation bug:

duncan
→ owning coder

If integration exposes an architectural/cross-task issue:

duncan
→ lebang

# 4. Coder Routing

Use `kd` as the default coder.

Suggested coder pool:

[
"kd",
"harden",
"sga",
"luka",
"kawhi",
"tatum",
"booker",
"giannis",
"jokic"
]

Suggested initial routing preferences:

## kd

Primary/default coder.

Use for:

* important implementation tasks
* medium/high complexity production changes
* tasks with no stronger specialization signal

## harden

Prefer for:

* backend implementation
* APIs
* service logic
* data flow
* larger backend features

## sga

Prefer for:

* focused isolated features
* medium-sized tasks
* cleanly scoped implementation

## luka

Prefer for:

* complex cross-module implementation
* broader-context reasoning
* difficult feature logic

## kawhi

Prefer for:

* careful refactors
* correctness-sensitive changes
* disciplined low-noise modifications

## tatum

Prefer for:

* frontend work
* UI implementation
* general client-side feature tasks

## booker

Prefer for:

* smaller independent tasks
* straightforward parallel work
* fast isolated implementation

## giannis

Prefer for:

* broad mechanical changes
* repetitive multi-file refactors
* large-surface implementation

## jokic

Prefer for:

* architecture-heavy implementation
* dependency-sensitive work
* integration-oriented coding

These are routing hints, not hard rules.

Model capability and availability should take priority.

lebang may assign any coder based on:

* task type
* task risk
* complexity
* specialization
* context size
* worker availability
* configured model capability

# 5. Preserve Task Ownership

Once a coder owns a task, preserve that ownership across rework.

Example:

T4
owner = luka

westbrook finds a bug
→ return T4 to luka

curry requests changes
→ return T4 to luka

Do NOT automatically send rework to kd.

Only lebang may explicitly reassign ownership.

If ownership changes, persist the reassignment in task history.

# 6. Skills Architecture

Use role-based Skills, not per-player copies.

Preferred layout:

.skills/
planner/
SKILL.md

coder/
SKILL.md

tester/
SKILL.md

reviewer/
SKILL.md

integrator/
SKILL.md

If the repository already has a different supported Skill location, follow that convention.

Do NOT create:

.skills/kd/
.skills/harden/
.skills/luka/

unless agents genuinely require different behavior contracts.

All coder identities should normally share:

coder/SKILL.md

Their differences belong in configuration.

## Planner Skill

Must define:

* repository inspection
* goal understanding
* task decomposition
* acceptance criteria
* dependency analysis
* parallelism detection
* coder assignment
* no delegated implementation
* replan handling
* structured plan output

## Coder Skill

Must define:

* work only on assigned task
* work only in assigned worktree
* do not expand scope
* implement production code
* add task-local unit tests
* self-verify
* run tests
* commit successful work
* return structured result

## Tester Skill

Must define:

* independently validate requirements
* do not merely repeat coder tests
* add regression / edge / integration coverage
* avoid production-code modifications
* report reproducible failures
* identify owning task

## Reviewer Skill

Must define:

* compare work against acceptance criteria
* inspect diff and tests
* return exactly approved / changes_requested / replan_required
* distinguish task issues from plan issues
* avoid becoming implementation owner

## Integrator Skill

Must define:

* integrate approved commits
* resolve trivial merge conflicts
* run final validation
* escalate semantic conflicts
* confirm overall goal completion

# 7. Model Configuration

Skills must NOT hard-code model names.

Create configuration-driven agent/model mapping.

Example shape:

agents:
lebang:
role: planner
model: <reasoning-model>

kd:
role: coder
model: <primary-coding-model>

harden:
role: coder
model: <coding-model>

sga:
role: coder
model: <coding-model>

luka:
role: coder
model: <deep-coding-model>

kawhi:
role: coder
model: <coding-model>

tatum:
role: coder
model: <frontend-capable-model>

booker:
role: coder
model: <fast-coding-model>

giannis:
role: coder
model: <coding-model>

jokic:
role: coder
model: <deep-coding-model>

westbrook:
role: tester
model: <testing-model>

curry:
role: reviewer
model: <review-model>

duncan:
role: integrator
model: <integration-model>

The exact file format should follow repository conventions.

Prefer YAML if the repository already uses YAML.

Otherwise JSON or another existing config format is acceptable.

# 8. Task Schema

Define a strongly typed or schema-validated Task structure.

Minimum conceptual shape:

{
"id": "T1",
"title": "Implement retry support",
"type": "implementation",
"description": "...",
"acceptanceCriteria": [
"...",
"..."
],
"dependencies": [],
"workerRole": "coder",
"assignedAgent": "harden",
"risk": "medium",
"status": "pending",
"reviewAttempts": 0,
"branch": null,
"worktree": null,
"baseCommit": null,
"commit": null
}

Support at least:

* id
* title
* type
* description
* acceptanceCriteria
* dependencies
* workerRole
* assignedAgent
* risk
* status
* reviewAttempts
* branch
* worktree
* baseCommit
* commit

Task types may include:

* implementation
* refactor
* test
* investigation
* documentation
* integration

# 9. Structured Result Contracts

Avoid depending on arbitrary prose.

Define structures for:

* Plan
* Task
* CoderResult
* TestResult
* ReviewResult
* AgentConfig
* RunResult
* Issue
* TaskHistoryEntry

## Example CoderResult

{
"taskId": "T2",
"status": "completed",
"summary": "...",
"changedFiles": [
"src/example.ts"
],
"testsAdded": [
"test/example.test.ts"
],
"testsRun": [
"npm test -- example.test.ts"
],
"testResult": "passed",
"commit": "abc123",
"blockers": []
}

## Example TestResult

{
"taskId": "T2",
"status": "failed",
"testsExecuted": [
"..."
],
"testsAdded": [
"..."
],
"failures": [
{
"description": "...",
"reproduction": "...",
"ownerTaskId": "T2"
}
]
}

## Example ReviewResult

{
"taskId": "T2",
"status": "changes_requested",
"issues": [
{
"severity": "high",
"scope": "task",
"description": "Retry count exceeds configured maximum",
"expected": "Maximum three attempts",
"ownerTaskId": "T2"
}
]
}

Valid ReviewResult.status values are only:

* approved
* changes_requested
* replan_required

# 10. Task DAG

Tasks must form a DAG.

A task can become ready only when all required dependencies are satisfied.

Example:

T1: define API contract

T2: backend implementation
depends on T1

T3: frontend implementation
depends on T1

T4: integration validation
depends on T2 and T3

After T1 completes:

T2 and T3 should be eligible to run in parallel.

The scheduler must:

1. inspect persisted tasks
2. find pending tasks whose dependencies are satisfied
3. mark them ready
4. assign available workers
5. execute independent work concurrently
6. respect a configured concurrency limit
7. prevent duplicate task ownership
8. persist every meaningful state transition

# 11. Task State Machine

Use explicit states.

Do not infer state from free-form agent text.

Suggested states:

* pending
* ready
* running
* self_verifying
* testing
* reviewing
* changes_requested
* reworking
* approved
* integrating
* completed
* blocked
* failed

Typical flow:

pending
→ ready
→ running
→ self_verifying
→ testing
→ reviewing

Then:

reviewing
→ approved
→ integrating
→ completed

or:

reviewing
→ changes_requested
→ reworking
→ testing
→ reviewing

If curry returns replan_required:

reviewing
→ lebang replanning path

Replanning may:

* update existing tasks
* invalidate tasks
* add tasks
* modify dependencies
* reassign ownership
* unblock new work

Track task history so decisions remain auditable.

# 12. Rework Rules

Use this ownership policy:

production bug
→ original coder

missing direct unit test
→ original coder

missing regression test
→ westbrook

missing integration test
→ westbrook

architecture problem
→ lebang

cross-task incompatibility
→ lebang

integration-only merge problem
→ duncan

Do not allow infinite loops.

Track:

reviewAttempts

Make the limit configurable.

Suggested default:

maxReviewAttempts = 3

Flow:

attempt 1
→ original owner rework

attempt 2
→ original owner rework

attempt 3 failure
→ escalate to lebang

lebang may:

* replan
* reassign
* split the task
* block the task
* require human attention

# 13. git worktree Isolation

Every production coding task must run in its own worktree.

Invariant:

# 1 coding task

# 1 worktree

# 1 task branch

1 primary coder

Preferred layout:

.worktrees/
T1-kd/
T2-harden/
T3-tatum/

Preferred branch naming:

agent/kd/T1
agent/harden/T2
agent/tatum/T3

Record:

* task ID
* assigned agent
* worktree path
* branch
* base commit
* resulting commit

Conceptual creation:

git worktree add .worktrees/T2-harden 
-b agent/harden/T2  <base-ref>

Do not assume the exact command until repository/git state is inspected.

Do not let multiple coding workers modify the same worktree.

Coder must commit successful work before returning completed status.

# 14. Base Commit Semantics

Be explicit about what commit each worktree starts from.

When a task depends on another task, do not blindly create all worktrees from the initial repository HEAD if the task requires dependency code.

Determine a clear strategy.

For example:

* task with no dependency starts from orchestration base commit
* dependent task starts from an integration/base branch that already contains approved dependency commits

or another simple git-safe approach appropriate to the repository.

This must be designed carefully before implementation.

Avoid hidden dependency assumptions between isolated worktrees.

# 15. Pi CLI

Pi CLI is the primary agent execution mechanism.

Do NOT build a separate agent runtime.

The orchestrator should invoke Pi through a thin execution module.

Conceptual interface:

runPiAgent({
agent,
role,
model,
taskId,
cwd,
prompt
})

Keep this abstraction intentionally small.

A module could be named:

pi-runner

The implementation must inspect the installed Pi CLI first.

Before deciding invocation syntax:

* run Pi help
* inspect supported model-selection mechanism
* inspect non-interactive execution options
* inspect structured output support if any
* inspect working-directory behavior
* inspect exit-code behavior
* inspect environment/config conventions

Do NOT invent unsupported Pi flags.

Use the simplest officially supported invocation.

# 16. Pi Prompt Construction

Build role-scoped prompts.

Do not send the full orchestration history to every worker.

## Coder prompt context

Include:

* overall goal summary
* agent identity
* role
* assigned task
* acceptance criteria
* relevant dependency outputs
* relevant repository instructions
* expected files/modules if known
* worktree location
* branch
* scope restrictions
* Coder Skill instructions
* required structured result contract

Do not include unrelated task discussions.

## westbrook prompt context

Include:

* overall feature goal
* target task(s)
* acceptance criteria
* coder output
* relevant diff
* test commands
* known risks
* Tester Skill

## curry prompt context

Include:

* task
* acceptance criteria
* coder result
* westbrook result
* git diff
* relevant test results
* Reviewer Skill

## duncan prompt context

Include:

* original overall goal
* approved tasks
* commits
* integration branch
* repository validation commands
* Integrator Skill

# 17. Herdr

Treat Herdr as the human-visible workspace and pane layer.

Herdr is NOT the source of truth.

Authoritative state lives in persisted orchestration files and git.

The core system must remain resumable if:

* Herdr restarts
* a pane closes
* a Pi process exits
* the orchestrator process stops

Use Herdr where practical for visibility.

Suggested conceptual pane names:

lebang

T1-kd
T2-harden
T3-tatum

westbrook

curry

duncan

When testing/reviewing a specific task, task-prefixed names are also acceptable:

T2-westbrook

T2-curry

If Herdr supports stable pane naming and launching commands, use it.

However:

Do not make the MVP depend on undocumented or fragile Herdr automation.

Inspect the installed/current Herdr interface before implementing integration.

Core orchestration must work with:

Pi CLI
+
git
+
filesystem state

even if Herdr-specific pane automation is unavailable.

# 18. Persistence

Use filesystem persistence for the MVP.

Preferred conceptual layout:

.orchestrator/
config.yaml
plan.json
state.json

tasks/
T1.json
T2.json
T3.json

runs/
T1/
coder/
tester/
reviewer/

logs/
T1-kd.log
T1-westbrook.log
T1-curry.log

history/
T1.jsonl

.worktrees/
T1-kd/
T2-harden/

Adapt this to project conventions.

Do not introduce a database for the first version.

# 19. Resume / Recovery

The system must be resumable.

After process restart:

* inspect persisted state
* inspect existing worktrees
* inspect existing task branches
* inspect recorded commits
* do not rerun completed tasks
* do not create duplicate worktrees
* recover ready/blocked/failed state safely
* make interrupted tasks explicitly recoverable

Do not silently assume a task completed because a worktree exists.

Persist enough information to distinguish:

* scheduled
* running
* successfully committed
* failed
* interrupted
* approved
* integrated

# 20. Logging

Every Pi execution must preserve:

* run ID
* task ID
* agent identity
* role
* configured model
* cwd
* start time
* end time
* exit code
* stdout
* stderr
* structured result
* state transition

Logs must be useful even if the Herdr pane no longer exists.

# 21. Concurrency

Support parallel independent coding tasks.

Example:

lebang creates:

T1
↓
T2 + T3

T2 assigned to harden

T3 assigned to tatum

After T1 is satisfied:

harden and tatum may execute concurrently in separate worktrees.

Add configuration such as:

maxWorkers: 3

Prevent:

* same task running twice
* same worktree being used by multiple coders
* same agent being accidentally assigned conflicting simultaneous ownership if the execution model does not support it

Use explicit task locks/ownership state if necessary.

Keep locking implementation simple.

# 22. Testing Lifecycle

Testing happens at three levels.

## Level 1 — Coder self-test

Owner:

Coder

Timing:

during implementation

Includes:

* direct unit tests
* local behavior tests
* relevant lint/type checks when cheap

Purpose:

prove basic task correctness before handoff.

## Level 2 — Independent testing

Owner:

westbrook

Timing:

after coder completion

Includes:

* acceptance criteria
* edge cases
* regression
* integration tests
* attempts to break assumptions

Purpose:

independently discover problems the coder missed.

## Level 3 — Final integration validation

Owner:

duncan

Timing:

after approved commits are integrated

Includes repository-appropriate:

* full unit test suite
* integration suite
* typecheck
* lint
* build
* other project-specific validation

Purpose:

prove individually correct tasks work together.

# 23. Review Lifecycle

After westbrook finishes:

→ curry reviews

Possible outcomes:

## approved

Task becomes approved.

Dependencies may become eligible.

## changes_requested

Determine owner.

Return task to original coder or westbrook as appropriate.

Then:

rework
→ test
→ curry again

## replan_required

Return to lebang.

lebang modifies the task DAG.

Never let curry silently rewrite the implementation plan itself.

# 24. Integration

Do not integrate unapproved implementation tasks.

Once required tasks are approved:

duncan integrates their commits.

Use the simplest safe Git strategy.

Prefer cherry-pick if it produces clear task-level integration history and fits the repository.

Prefer merge if repository conventions make that safer.

Do not hard-code one strategy until repository conventions are inspected.

After integration:

run final validation.

If validation succeeds:

mark goal complete.

If validation fails:

classify the failure.

Local task bug:
→ owning coder

Test-only issue:
→ westbrook

Architecture/cross-task issue:
→ lebang

Merge mechanics:
→ duncan

# 25. CLI

Implement a thin CLI.

Suggested commands:

orchestrator plan "<goal>"

orchestrator run

orchestrator status

orchestrator task T1

orchestrator retry T1

orchestrator review T1

orchestrator integrate

orchestrator resume

Optional later commands:

orchestrator graph

orchestrator logs T1

orchestrator agent status

Do not build a custom TUI for the MVP.

Herdr already provides the primary visual multi-agent environment.

# 26. Status Output

`orchestrator status` should make orchestration understandable at a glance.

Prefer showing:

* task ID
* title
* status
* assigned agent
* dependencies
* branch
* review attempts
* blockers

Example conceptual output:

T1  API contract       completed   kd       -
T2  Backend API        running     harden   T1
T3  Frontend UI        testing     tatum    T1
T4  Integration tests  pending     -        T2,T3

Also summarize:

ready tasks
running tasks
blocked tasks
approved tasks

# 27. Failure Handling

Handle at least:

* Pi CLI exits non-zero
* Pi CLI output cannot be parsed
* coder does not commit
* test command fails
* worktree creation fails
* git branch already exists
* dependency task fails
* task is interrupted
* review retry limit reached
* integration conflict
* integration validation failure
* malformed persisted state

Prefer explicit status:

failed

or:

blocked

with a structured reason.

Do not silently retry indefinitely.

# 28. MVP Implementation Order

Implement in this order.

## Phase 0 — Repository Investigation

Before writing orchestration code:

1. inspect repository structure
2. inspect AGENTS.md or equivalent agent instructions
3. inspect existing Skills conventions
4. inspect Pi CLI with its actual help/options
5. inspect current Herdr usage and available CLI/keybinding/pane capabilities
6. inspect git branch/worktree conventions
7. inspect project language/runtime
8. inspect existing CLI framework
9. inspect test framework
10. inspect configuration conventions
11. identify reusable existing process/task/git abstractions

Produce a repository-aware implementation plan before coding.

## Phase 1 — Core Data Model

Implement:

* agent config
* task schema
* plan schema
* result schemas
* task history
* persistence
* state machine
* DAG dependency resolution
* `status`

No Pi worker execution yet.

## Phase 2 — lebang Planning

Implement:

* Planner Skill
* Pi invocation for lebang if appropriate
* planning prompt construction
* structured Plan output
* task persistence
* DAG validation

Ensure planning does not directly implement feature code.

## Phase 3 — Coder Execution

Implement:

* shared Coder Skill
* coder pool configuration
* routing/default assignment
* Pi runner
* prompt construction
* one-task execution
* structured result parsing
* logs

Start with kd only if that simplifies the first working path.

Then generalize to the coder pool without over-engineering.

## Phase 4 — git worktree

Implement:

* task branch creation
* task worktree creation
* base commit handling
* coder execution in worktree
* resulting commit capture
* restart-safe discovery

Then enable multiple concurrent coders.

## Phase 5 — westbrook

Implement:

* Tester Skill
* tester prompt
* independent test phase
* structured test results
* task-level failure routing

## Phase 6 — curry

Implement:

* Reviewer Skill
* approved
* changes_requested
* replan_required
* issue structures
* review attempt counting

## Phase 7 — Rework / Replan

Implement:

changes_requested
→ original owner
→ rework
→ westbrook
→ curry

Implement:

replan_required
→ lebang
→ DAG update

Preserve task history.

## Phase 8 — duncan

Implement:

* Integrator Skill
* approved commit integration
* final validation
* conflict classification
* complete state

## Phase 9 — Resume / Recovery

Implement:

* resume interrupted execution
* worktree discovery
* task recovery
* duplicate execution prevention
* recovery diagnostics

## Phase 10 — Herdr Convenience Integration

Only after the core flow is stable:

* launch dedicated panes if supported
* name panes
* show task/agent identity
* show worktree path
* optionally run Pi sessions in those panes

Keep this integration optional.

Do not make correctness depend on Herdr.

# 29. Things Intentionally Excluded From MVP

Do NOT implement these unless the existing repository already requires them:

* database
* Redis
* distributed scheduler
* remote worker fleet
* web dashboard
* custom TUI
* custom agent protocol
* custom model provider abstraction
* cross-machine execution
* vector database
* long-term semantic memory system
* fully autonomous dynamic role invention
* automatic unlimited retries
* automatic production-code fixes by curry
* automatic production-code fixes by westbrook

The MVP should prove the orchestration loop first.

# 30. Expected Repository Structure

Do not blindly create this structure.

Adapt to the existing repository.

Conceptually, the implementation may resemble:

src/
orchestration/
planner
scheduler
state-machine
task-store
agent-config
pi-runner
worktree
tester
reviewer
integrator

.skills/
planner/
SKILL.md
coder/
SKILL.md
tester/
SKILL.md
reviewer/
SKILL.md
integrator/
SKILL.md

.orchestrator/
config.yaml
plan.json
tasks/
runs/
logs/
history/

.worktrees/

Follow existing project conventions whenever possible.

# 31. Architecture Invariants

Preserve these invariants.

## Invariant 1

One production coding task has one primary coder owner at a time.

## Invariant 2

One active coding task has one isolated worktree.

## Invariant 3

Skills never hard-code model IDs.

## Invariant 4

Herdr is not authoritative state.

## Invariant 5

Agent prose is not authoritative task state.

## Invariant 6

Curry does not normally implement fixes.

## Invariant 7

Westbrook does not normally modify production code.

## Invariant 8

Coder owns direct unit tests.

## Invariant 9

Rework returns to the original owner unless lebang explicitly reassigns it.

## Invariant 10

No task is integrated before required review approval.

## Invariant 11

Integration success requires repository-level validation.

## Invariant 12

No unlimited automatic retry loops.

# 32. Example End-to-End Flow

User requests:

"Implement feature X."

lebang inspects the repository and produces:

T1 — API contract
owner: kd

T2 — Backend implementation
owner: harden
depends on T1

T3 — Frontend implementation
owner: tatum
depends on T1

T4 — Integration validation
depends on T2 and T3

T1 becomes ready.

Create:

.worktrees/T1-kd

branch:

agent/kd/T1

Pi runs kd using the Coder Skill.

kd:

* implements T1
* writes unit tests
* runs tests
* commits
* returns structured result

westbrook validates T1.

curry reviews T1.

If approved:

T1 becomes approved/completed according to dependency policy.

T2 and T3 become ready.

Create:

.worktrees/T2-harden
.worktrees/T3-tatum

Run harden and tatum concurrently.

Both self-test and commit.

westbrook independently verifies the relevant work.

curry reviews.

Suppose T2 is approved.

Suppose T3 receives changes_requested.

T3 returns to tatum.

tatum fixes the issue.

westbrook reruns relevant tests.

curry reviews again.

If curry instead returns replan_required:

control goes to lebang.

lebang updates the DAG.

When all required implementation tasks are approved:

duncan integrates approved commits.

duncan runs:

* project tests
* integration tests
* typecheck
* lint
* build

using repository-appropriate commands.

If everything passes:

the orchestration run becomes completed.

# 33. First Response Required Before Coding

Do NOT begin implementation immediately.

First inspect the repository and environment.

Then return a concrete implementation plan containing:

1. Relevant current repository architecture.
2. Existing CLI framework and runtime.
3. Existing Skills structure.
4. Actual Pi CLI execution capabilities discovered.
5. Actual Herdr integration capabilities discovered.
6. Existing git/worktree conventions.
7. Proposed file/module changes.
8. Final task and result schemas.
9. State-machine design.
10. Task DAG scheduling design.
11. Worktree/base-commit strategy.
12. Pi process invocation design.
13. Prompt/context construction strategy.
14. Rework/replan flow.
15. Integration strategy.
16. Resume/recovery strategy.
17. Testing strategy.
18. Phased implementation tasks.
19. MVP definition.
20. Explicit non-goals.

For every implementation phase, include:

* files/modules affected
* acceptance criteria
* dependencies
* tests required
* likely risks

After presenting that repository-specific plan, proceed with implementation unless a genuine blocking condition exists.

Do not ask unnecessary clarification questions when repository inspection can determine the answer.

# 34. Definition of Done

The implementation is complete when the following works end-to-end:

1. A user goal can be given to lebang.
2. lebang produces a valid task DAG.
3. Tasks persist to disk.
4. Ready tasks are identified deterministically.
5. A coder is selected from the configured pool.
6. The coder runs through Pi CLI.
7. Production coding tasks run in isolated git worktrees.
8. Coder changes include task-local tests.
9. Successful coder work produces a commit.
10. westbrook independently tests the work.
11. curry returns a structured review decision.
12. changes_requested returns work to the original owner.
13. replan_required returns control to lebang.
14. Review retries are bounded.
15. Independent coder tasks can execute concurrently.
16. State survives process restart.
17. Logs survive Herdr pane closure.
18. duncan integrates only approved work.
19. Final repository validation runs after integration.
20. The system reports completed, blocked, or failed state clearly.

The final system should feel like:

lebang
= orchestration brain

kd / harden / sga / luka / kawhi / tatum / booker / giannis / jokic
= isolated implementation workers

westbrook
= independent verification

curry
= acceptance gate

duncan
= final integration

Pi CLI
= agent/model execution engine

Skills
= role behavior contracts

git worktree
= code isolation

Herdr
= human-visible workspace

filesystem + git
= authoritative state and recovery foundation

Keep the implementation small enough that a developer can understand the entire orchestration lifecycle without learning a new agent framework.
