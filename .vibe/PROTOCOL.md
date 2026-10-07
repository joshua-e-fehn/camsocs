# The vibe protocol

> **Vibe-owned file. Do not hand-edit — `vibe init` overwrites it.**
> Repo-specific instructions belong in `AGENTS.md`, which imports this file.

## Working inside a vibe worktree

You are (most likely) running inside a **git worktree** on a dedicated feature
branch created by `vibe`. Everything you commit stays on that branch until it is
handed over via a PR. Do not switch branches, and do not commit to the base
branch.

**If `.vibe/TASK.md` exists in the worktree, read it first** — it contains the
full task description you were spawned for. The branch name is only a slug of
it; the detail lives in that file.

**If `HANDOFF.md` exists in the worktree root, READ IT FIRST** before doing any
work — it captures where the previous session left off (done / in progress /
next / blockers / exact state). It supersedes `TASK.md` on anything they
disagree about, since it reflects work already done.

## Reference the codebase

Before writing a new function, search for an existing one that does the job
(`rg` / Grep). Reuse or extend it. Never introduce a second way to do something
that already exists — if the existing way is wrong, change it, don't route
around it. Cite the `file:line` you're building on in the commit body.

Third-party source is vendored under `.vibe/sources/`. To read a dependency's
real implementation instead of guessing, run `vibe vendor <pkg>`. Prefer this
over recalling the API from memory.

## Size budget

A PR is done when it is **≤4000 changed lines across ≤20 files**, excluding
lockfiles, generated code, and snapshots. If your plan can't fit, it's not one
PR — split it.

`vibe ship` enforces this budget and will refuse to promote an oversized PR.
`vibe handover` warns but does not block.

## Structure pass

Before a branch becomes reviewable it gets a structure pass (`vibe structure`,
or `/structure` interactively). It is **refactor-only — no behavior change** —
and lands as separate `refactor:` commits. It answers:

1. What did this feature add that already existed elsewhere?
2. Where is there now more than one way to do the same thing?
3. What belongs in a service layer — logic that leaked into a route, handler,
   or component?
4. What would be hard for a human to read?

Report a finding count. Zero is a valid answer; silence is not.

## Commits

Match the commit style in `git log --oneline -20`. One logical change per
commit.

## Context threshold

When your context window is **~75% consumed, do not compact**. Run the handover
protocol below, then tell the human to run `vibe resume <branch>`.

## THE HANDOVER PROTOCOL

When the human says **"handover"** or runs **`vibe handover`**, do all of the
following, in order:

1. **Commit all work.** Stage and commit every outstanding change with a clear
   message. Leave no uncommitted files.
2. **Write/update `HANDOFF.md`** at the worktree root using exactly this shape:

   ```markdown
   # Handoff — <branch>

   ## Done
   - <what is finished and verified>

   ## In Progress
   - <what is partially done, and where you stopped>

   ## Next
   - <the immediate next steps, in order>

   ## Blockers
   - <anything blocking progress, or "none">

   ## Exact State
   - Last commit: <sha>
   - Tests: passing / failing (say which)
   - Uncommitted changes: none / <list>
   ```

3. **Commit `HANDOFF.md`** (`docs: handoff` is fine).
4. **Push the branch** to `origin`.
5. The PR is opened by `vibe handover` itself — you do not need to run
   `gh pr create`.

The goal: another agent on another machine can run `vibe resume <branch>`, read
`HANDOFF.md`, and continue seamlessly.

### Handover PRs vs reviewable PRs

`vibe handover` opens a **draft PR labelled `handover`**. It is a transport
mechanism for state between machines — **not a review request**. When the work
is actually finished, `vibe ship` runs the structure gate and the size check,
strips the handover markers, and promotes the same PR to reviewable in place.

## Supervised requests

Your branch may be part of a larger **request** tracked in
`.vibe/tasks/<task-id>.json`. If it is, two things follow:

- **Finishing your branch is not finishing the request.** Going idle, opening a
  PR, or getting it merged does not mean the thing the human asked for is done —
  merged is not deployed, and deployed is not working. Do not describe the
  request as complete; report what *your* branch did and stop.
- **Say when you are waiting.** If you kick off a long detached job (a build, a
  deploy, a migration), tell the human the PID and its log file so it can be
  registered with `vibe supervise watch-pid`. While a registered job is healthy,
  an idle agent is correctly read as *waiting*, not finished — but only if the
  job was registered.

Only a human marks a request verified, and only with evidence. Never claim it
for them.
