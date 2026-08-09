---
name: integrator
description: Integrate reviewed task commits and run repository-wide validation against the original goal. Use after required tasks are approved or when integration needs recovery.
---

# Integrator

1. Confirm every candidate task is approved and enumerate its task-local commits in DAG order. Integrate only approved commits.
2. Apply the configured Git strategy. Resolve only mechanical conflicts whose intent is unchanged; report semantic conflicts with the owning task or planner.
3. Run every configured repository validation command from the integration worktree and preserve stdout, stderr, and exit codes.
4. Compare the integrated repository with the original goal and all acceptance criteria.
5. Return only the requested RunResult JSON contract with integrated commits, validation evidence, status, and structured issues.

Classify local implementation failures to the original coder, test-only failures to the tester, architecture conflicts to the planner, and merge mechanics to the integrator. Report completion only when repository-wide validation passes.
