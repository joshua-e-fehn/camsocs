# Rolling back production (ENG-37)

What to do when a release breaks camsocs.uk, in the order to try it. Three things ship separately and roll back separately: the **site** (a Vercel deployment), the **Convex functions and schema** (pushed by the same Vercel build, `scripts/convex-deploy-if-key.sh`), and the **harvester** (the VPS checkout, which pulls `main` before every run, docs/ops-vps.md). A Vercel rollback moves only the first; nothing moves the data back except a backup.

Checked against the live setup on 2026-11-04: Vercel Pro (team `joshuas-projects-dc895e08`, project `camsocs`, Git-connected to `main`, `autoAssignCustomDomains: true`), Convex Professional (production `cheerful-bandicoot-511`, `aws-us-east-1`), the VPS runner of docs/ops-vps.md.

**Status codes only.** Every check below reads status codes and counts. Never open or print a `/talks*` body or the home page's body (talks.cam content must not reach a model, docs/deploy.md "Bot policy").

## 0. Decide what broke

| Symptom | Likely layer | Go to |
|---|---|---|
| Pages 500, blank or wrong after a merge; the Convex dashboard's functions look fine | the site | §1 |
| Every page that reads data fails; Convex logs show errors from functions changed in the release; or a schema change was in it | Convex functions | §2 (and §1 at once if the release changed both) |
| Data looks wrong (blanked fields, duplicate or vanished events) after a harvest; Slack alert from `camsocs-harvest@*` | harvester | §3, then §4 |
| Rows deleted or overwritten by hand, a wrong `clean-events --apply`, a wrong migration | data | §4 |

Logs: `vercel logs --environment production --status-code 5xx --since 30m` (from `webapp/`, `--scope joshuas-projects-dc895e08`), the Convex dashboard (Production → Logs), the PostHog "camsocs: Reliability" dashboard, and the VPS monitor's Slack DMs (`error_spike`, `site_home`, `site_societies`).

## 1. The site: Vercel instant rollback

Instant: it points the production domains at an earlier, already built deployment. No build runs, so **Convex is not touched** and the rolled-back site talks to the current functions.

1. Find the last good deployment: `vercel list --prod --scope joshuas-projects-dc895e08` (or Vercel → `camsocs` → Deployments, filter Production). Each row names its commit.
2. Roll back: Vercel → Deployments → that deployment → ⋯ → **Instant Rollback**, or `vercel rollback <deployment url or id> --scope joshuas-projects-dc895e08`, then `vercel rollback status camsocs --scope joshuas-projects-dc895e08`. Pro allows any earlier production deployment (Hobby only the previous one).
3. Check (expect 200 each; `/does-not-exist` 404):

   ```bash
   for p in / /societies /events /about /privacy /sitemap.xml /robots.txt /talks /does-not-exist; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://camsocs.uk$p"; done
   ```

4. **After a rollback Vercel stops assigning the production domains to new deployments**: a merge to `main` builds (and deploys Convex) but camsocs.uk keeps serving the rolled-back deployment. Fix forward on `main` (a revert PR or the fix), let it build, then **Promote** that deployment (Deployments → ⋯ → Promote, or `vercel promote <url>`), which also turns auto-assignment back on. Check `vercel api "/v9/projects/prj_capNnDOwrpJa4jvuxUo69cdtSBF2?teamId=team_BPZRUyOixqP7I7QyKQ5LoKG5" | jq .autoAssignCustomDomains` is `true` afterwards.

When a rollback is not enough: the release also changed a Convex function's arguments or return shape. The old site then calls new functions; read §2.

Not a rollback: **Redeploy** of an older deployment rebuilds it with today's environment and runs `convex deploy` again, so it moves the functions too (§2). A redeploy of the commit `main` already has is usually cancelled by the project's Ignored Build Step (`git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .`).

## 2. Convex functions and schema

Convex has **no one-click function rollback**: the dashboard lists deploys (Production → History) but cannot restore an earlier bundle. Functions go back only by deploying older code:

1. On a branch from `main`: `git revert <bad merge commit>` (squash merges make this one commit), PR, merge. Vercel's production build runs `convex deploy` for the reverted code and ships the matching site in the same build, so functions and site agree again. Takes one build (a few minutes).
2. Faster, without Git (only when the PR route is too slow): build the last good commit locally with the production key on the one command line, as docs/deploy.md §1 "Local, deliberately". It pushes that commit's functions and schema; the next merge to `main` pushes `main` again, so revert on `main` as well.
3. Check: Convex dashboard → Production → Functions shows the expected modules; `/api/pipeline/health` answers through `pixi run pipeline -- --env prod health` (laptop) or on the host (docs/ops-vps.md §5); the §1 status loop.

**Limits.**

- **Schema.** `convex deploy` checks every stored document against the schema it pushes and refuses the push if one does not match. Rolling back past a release that *added* an optional field works only while no document carries it yet; once the new code has written it, the older schema is refused. So every schema change stays widen-migrate-narrow (AGENTS.md), and a rollback across one is a forward fix: keep the field in the schema (optional), roll back the code that uses it.
- **Data written by the new code stays.** Rolling back functions changes no rows. Rows the bad release wrote are repaired by the next harvest (pipeline writes are claims; the server re-resolves) or by hand (§4).
- **Components** (`convex/betterAuth`) are deployed with the app; rolling back across a `@convex-dev/better-auth` upgrade has the same schema limit.
- **Crons and HTTP routes** are part of the bundle and roll back with it. A route the VPS posts to (`/api/pipeline/*`) that disappears makes the next harvest fail at that stage (it alerts); pin the harvester first (§3) when a rollback removes a route the current pipeline uses.

## 3. The harvester (VPS)

From docs/ops-vps.md §4, in short (on the host, as root):

- **Pin the pipeline code** to the last good commit: `echo <commit> | sudo -u camsocs tee /var/lib/camsocs/pin`. The next run checks it out instead of pulling `main`. `/var/lib/camsocs/last-good-commit` is the last commit whose run ended with exit 0. `rm /var/lib/camsocs/pin` follows `main` again.
- **The runner itself** (scripts, units, logrotate, pixi version): `bash /usr/local/lib/camsocs-ops/install.sh --revision <earlier reviewed commit> --diff`, then without `--diff`. It installs only a commit that is on `main`.
- **Stop instead:** `systemctl disable --now camsocs-harvest-events.timer camsocs-harvest-full.timer camsocs-monitor.timer`.
- **Order with §2:** when Convex goes back, pin the harvester to a commit whose routes the rolled-back functions still have, before the next 04:30 run.

## 4. Data

- **Pipeline-owned tables** (organisations, events, claims, talks): the next good run restates what it reads, so a bad harvest is repaired by a good one (`systemctl start camsocs-harvest@full.service` after the fix). Events no reader restates are what `camsocs clean-events` lists (docs/deploy.md §7, docs/data-quality.md).
- **Everything else lives only in Convex**: the broker CRM, listing requests, the **suppression list** (removals people asked for) and sign-in accounts. Without a backup a deletion there is permanent, and a lost suppression can re-publish something someone asked to remove (breach-procedure.md).
- **Backups: none as of 2026-11-04** (production's periodic backup config is unset and it holds no cloud backup; ENG-44). Until Joshua turns them on (docs/platform-limits.md "Joshua's settings"), there is nothing to restore. Once on:
  1. Convex dashboard → Production → **Backup & Restore** → pick the backup → **Restore** into the **dev** deployment first and check the tables there.
  2. Restoring into production replaces every table with the backup's contents: writes since the backup are lost, including listing requests and suppressions accepted since. List those first (dashboard → `listingRequests`, `suppressions`, sorted by creation) and re-enter them after the restore.
  3. A single table or document: download the backup (or `bunx convex export --prod --path <file>.zip`, with `--include-file-storage` for stored files) and re-insert the rows by hand in the dashboard, or one table with `bunx convex import --prod --table <table> --append <file>.jsonl`. Never `--replace-all`, and never through a pipeline route. An export holds the CRM's named people and requesters' addresses: keep it outside the repository (the repository is public) and outside `var/`, encrypted, and delete it when done.
- Treat an unintended deletion of personal data or of suppressions as a possible breach: docs/compliance/breach-procedure.md.
