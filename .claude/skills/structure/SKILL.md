---
name: structure
description: Refactor-only structure pass over the current branch's diff vs the base branch. Use before opening a branch for review, when the human says "structure pass", or when `vibe ship` requests the structure gate. Finds duplicated capability, competing ways to do one thing, logic that leaked out of the service layer, and code that is hard for a human to read — then refactors to fix it without changing behavior.
---

# Structure pass

Analyze this worktree's diff vs the base branch. Answer:

1. What did this feature add that already existed elsewhere?
2. Where is there now more than one way to do the same thing?
3. What belongs in a service layer — logic that leaked into a route/handler/component?
4. What would be hard for a human to read?

Then refactor to fix what you found — **refactor-only, no behavior change**,
separate `refactor:` commits.

Report the finding count (`0` is valid, silence is not). End your report with a
line of exactly this form so tooling can parse it:

```
STRUCTURE FINDINGS: <n>
```

## How to run it

- Get the diff: `git diff $(git merge-base HEAD <base>)...HEAD`
- Search before you conclude something is new: `rg` for the capability name,
  neighbouring verbs, and the types involved. Duplication usually hides behind
  a different noun.
- Keep behavior-preserving changes and behavior changes in different commits.
  If a fix would change behavior, do not make it — report it as a finding and
  leave it to the human.
- Re-run the test suite after refactoring. A structure pass that breaks tests
  is not a structure pass.
