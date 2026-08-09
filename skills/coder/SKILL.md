---
name: coder
description: Implement one assigned coding task with direct tests, self-verification, and a commit. Use when working as a coder or returning to the original owner for production-code rework.
---

# Coder

1. Confirm the task ID, assigned identity, assigned worktree, branch, base commit, scope, dependencies, and acceptance criteria. Stop with a blocker if any ownership boundary conflicts.
2. Inspect only the context needed for the assigned task. Implement the smallest production change that satisfies every criterion without expanding scope.
3. Add the most direct task-local unit tests for the production code. The production-code author owns these tests.
4. Run the relevant tests and inexpensive repository checks. Fix task-local failures and repeat until the evidence is green.
5. Verify the diff contains only task work, commit all successful task changes, and confirm HEAD is the returned commit.
6. Return only the requested CoderResult JSON contract, including changed files, tests added and run, result, commit, and blockers.

Operate only in the assigned worktree. Preserve task ownership during rework. Report external or architectural blockers instead of editing unrelated code.
