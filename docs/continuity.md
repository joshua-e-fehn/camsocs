# After the MPhil: continuity plan (DRAFT for Joshua's decision)

> **Status: draft, 2026-11-04 (ENG-37).** Joshua's current expectation (2026-11-04) is **D. keep running it himself** after the MPhil; the final choice is open until the decision date below and is recorded in PLAN.md's decisions log, when this file becomes the plan.

CAMsocs is run by one person, Joshua Fehn, as a personal / portfolio project during the MPhil ACS 2026-27. He is the **controller** for every piece of personal data it holds (record-of-processing.md). The course ends with the vivas of **28–30 June 2027**. After that someone has to keep the site honest and answer requests, or it has to stop in an orderly way: a database of societies that silently goes stale is worse than none, and personal data kept with no one answering for it is a compliance problem, not a neutral state.

## What has to be decided

One of four end states, reached by **31 August 2027**:

- **A. Hand over** to a successor that becomes the new controller (a student society, the SU, or a named student maintainer).
- **B. Archive read-only**: harvesting stops, the site stays up with a dated "no longer updated" notice, Joshua stays the controller.
- **C. Shut down** and delete the data on the retention schedule's terms.
- **D. Keep running it** (Joshua's current expectation): Joshua stays the controller and runs it remotely after the course. What changes is listed under "Option D" below.

## What the site depends on

| Dependency | Tied to | After the MPhil |
|---|---|---|
| Vercel Pro (team `joshuas-projects-dc895e08`) | Joshua's card, $20 a month + usage | his to keep, transfer or end (docs/platform-limits.md §1) |
| Convex Professional (team `joshua-fehn`, shared with relio and thirtysecond) | Joshua's card, $25 a month | as above; a project can move to another team |
| VPS runner on `srv1608974` | Mya's host and Slack bot | cannot be handed over: a successor needs its own host or scheduler |
| LLM (cliproxy → Joshua's ChatGPT subscription) | Joshua personally | cannot be handed over; a successor needs its own model access (or the model stages off, which costs enrichment and makes D1 redaction withhold more text) |
| University events API (D3a) | permission given to Joshua for camsocs by UIS and the Office of External Affairs and Communications | does not pass to a successor: ask again, or stop reading it (docs/ops-vps.md "Revoking the University events permission") |
| camsocs.uk | IONOS, registrant Joshua; expires **31 Oct 2027** | transfer (Nominet registrant change), keep or let lapse |
| Admin sign-in | Google Workspace admin@joshua-fehn.de (Internal OAuth app) | a successor needs its own OAuth client and `BROKER_EMAILS` |
| Contact addresses `privacy@`, `security@`, `hello@`, `requests@camsocs.uk` | CAMsocs' own Google Workspace (camsocs.uk, Business Starter, Joshua's card; admin joshua@camsocs.uk) | stays reachable whatever happens, until the data is gone; the whole Workspace can be handed to a successor. The old `camsocs@joshua-fehn.de` forwards there until at least November 2027 |
| `@cam.ac.uk` mailbox | his University account | only the list-mail inbox (J4, not set up) would depend on it; the account closes some time after the course (ask UIS for the date) |
| PostHog (EU, free plan) | Joshua's organisation | not transferred; delete or leave to age out (R12, one year) |
| GitHub `joshua-e-fehn/camsocs` (public) | Joshua | transfer, fork, or archive |

## Controller duties until the end state

These stay Joshua's under every option until a successor has formally taken over (A) or the data is deleted (C):

1. **Rights requests** (access, objection, erasure, rectification) through `/request` and `privacy@camsocs.uk`, answered within one month; accepted removals become suppressions (retention.md R8).
2. **Breach procedure** (docs/compliance/breach-procedure.md): 72 hours to the Information Commission where the test says so.
3. **The annual review in July 2027** (retention.md "Annual review", DPIA-lite and record of processing, `security.txt` `Expires` renewed) — it falls inside the handover window, so it is done as part of whichever option runs.
4. **Retention keeps running** while Convex runs: R3 events at a year, R5 people 30 days past 30 June (so the CRM's 2026-27 committee members are deleted by **30 July 2027** whatever is chosen), R11 talks at 30 days, R4 mail.
5. **Tell people about a change of controller** (A): the new controller gives its own Art 13/14 information; Joshua tells the societies on the outreach list that he hands over, to whom, and from when.
6. **Keep the privacy notice true**: a frozen site (B) must say so on `/privacy` and `/about`, with the freeze date and who still answers requests.
7. The Information Commission fee: no fee was payable on 2026-11-03 (ENG-38); a successor makes its own assessment.

## Option A — hand over

**Who.** Realistic successors: the SU's societies team (it holds the official register; a hand-over could also settle the database-right question about republishing its directory, `docs/research/2026-10-07-landscape-brief.md` §5.4), a student computing or entrepreneurship society that would run it as a service, or a named student maintainer. Ask in Lent term 2027 while committees are in post. An agreement in writing names the new controller, the date and what moves.

**What moves, what does not.**

- Moves: the public directory (organisations, events, their claims and sources), **the suppression list and open listing requests** (they protect people who asked to be removed; a successor that drops them re-publishes what was taken down), the code, optionally the domain.
- Does **not** move: the private broker CRM (`people`, interactions, introductions, needs and offers). It exists for Joshua's own brokering purpose, holds named officers including special category data under Art 9(2)(e) (DPIA-lite §5), and a successor has no basis for it. Delete it before the transfer (Convex: the broker tables; retention.md R5–R6), unless the successor documents its own purpose and assessment first.
- Does not move: PostHog data, the VPS runner, the LLM access, the University events permission, Joshua's accounts and keys (rotate every key the successor will hold, docs/key-rotation.md, so Joshua's copies stop working).

**Mechanics.** GitHub → Settings → Transfer (or the successor forks); Vercel → project Settings → Transfer to the successor's team; Convex → project Settings → move the project to the successor's team (or a fresh deployment and `convex export` / `import` of the public tables plus `suppressions` and `listingRequests` only); domain: a registrant transfer to the successor through IONOS (check IONOS's process and any fee) or a 308 redirect to their domain until 31 Oct 2027; scheduler: the successor's own host following docs/ops-vps.md, or a GitHub Actions schedule (public repository: secrets in Actions secrets).

**Cost to the successor.** Today's stack is about $45 a month plus the LLM. On free tiers (Vercel Hobby is for non-commercial personal use, a society's own account may qualify; Convex's free plan) measure one month's usage first (`vercel billing usage`, Convex usage page) against those plans' limits.

## Option B — archive read-only

1. Stop the harvest: `systemctl disable --now camsocs-harvest-events.timer camsocs-harvest-full.timer camsocs-monitor.timer` (docs/ops-vps.md §4), then uninstall the runner.
2. Delete the broker CRM (as in A) and the PostHog project, which a frozen site no longer needs.
3. A site-wide banner and `/about`, `/privacy` text: "No longer updated since <date>. Listings may be out of date." with the request route kept open. The calendar empties itself as events end; talks go 30 days after they end (R11).
4. Keep Convex and Vercel running (they hold the suppressions and serve the pages), or replace them by a static snapshot of the directory without events and talks (a build-time export; more work, but no database to run).
5. **Time-box it**: an archive still publishes role contacts (personal data where they name a person's address) and still owes answers to requests, so B ends in C after at most twelve months, before the domain lapses.

Cost: Vercel Pro and Convex Professional stay at about $45 a month unless both move to free plans (a static snapshot needs only Vercel Hobby).

## Option C — shut down with deletion

In this order (each step is reversible until step 4):

1. **Announce**, 30 days ahead, on the site (banner, `/about`, `/privacy`) and in one e-mail to the societies' role addresses the Art 14 notice used: the closing date, that their data will be deleted, how to ask for a copy of their own listing before then.
2. **Stop harvesting** and uninstall the runner (docs/ops-vps.md §4 "Stop", "Uninstall"): the VPS's `/opt/camsocs` (cache, staging, state), `/var/lib/camsocs`, `/var/log/camsocs`, the camsocs cliproxy key, the GitHub deploy key.
3. **Replace the site** with one static page (CAMsocs has closed, the date, what was deleted, the contact address until the domain lapses): a one-file deployment on the same Vercel project, or IONOS's redirect to a page on joshua-fehn.de.
4. **Delete the data:**
   - Convex: delete the production deployment (`cheerful-bandicoot-511`: every table, stored file, scheduled function and backup) and the dev deployment, then the project. Download nothing first except, if Joshua wants a portfolio record, aggregate counts (no rows).
   - PostHog: delete the `camsocs` project (Project settings → Danger zone).
   - The laptop: the repository's `var/` (cache, staging, reports, screenshots), `.camsocs-state*.json`, `pipeline/.env*`, `webapp/.env.local`.
   - 1Password: the camsocs items in the Mya vault (after the keys are revoked).
   - Keys: Convex deploy keys, the Google OAuth client, PostHog keys, the Vercel "Mya token" if it was only for camsocs.
5. **Tell** UIS and the Office of External Affairs and Communications that the events programme is no longer read (their permission, D3a).
6. **Close**: archive the GitHub repository (Settings → Archive; the code holds no personal data and stays a portfolio piece), delete the Vercel project after the domain's last day, let camsocs.uk lapse on 31 Oct 2027 or renew it once if a lookalike would be a risk (a lapsed .uk name can be registered by anyone and made to look like camsocs).
7. **Record** the deletion: date, what was deleted where, by whom; no personal data in it. Keep it with the breach log (outside Git), as evidence of accountability (UK GDPR Art 5(2)).

Cost: nothing after the closing month, except the domain if renewed.

## Dates

| Date | What | Option |
|---|---|---|
| 9 Nov 2026 | Art 14 notice to societies (ENG-40) | all |
| **Fri 26 Feb 2027** | **Joshua decides A, B or C** (recorded in PLAN.md) | — |
| 31 Mar 2027 | A: successor named and has agreed in principle; otherwise fall back to B→C or C | A |
| 30 Apr 2027 | A: written agreement (controller, date, what moves); the successor's own privacy notice drafted | A |
| May – June 2027 | no work on camsocs planned (dissertation 8 Jun, presentations 15–17 Jun, vivas 28–30 Jun) | — |
| 30 Jun 2027 | committees hand over; the CRM's people go stale (R5) | all |
| 1 Jul 2027 | A: announce the handover; B/C: announce the freeze or closing (30 days' notice) | all |
| July 2027 | annual review (retention, DPIA-lite, record of processing, `security.txt`) | all |
| 30 Jul 2027 | R5 deletes the 2026-27 people automatically | all |
| 31 Jul 2027 | A: transfer done, keys rotated; B: harvest stopped, banner up; C: site replaced, data deleted | all |
| 31 Aug 2027 | end state reached and recorded | all |
| 31 Oct 2027 | camsocs.uk expires unless renewed or transferred | all |
| by 31 Jul 2028 | B: the archive ends in C | B |

## Draft recommendation (for Joshua to accept or change)

Try **A** in Lent term 2027 with one or two concrete successors, because the directory is only worth keeping if someone keeps it current. If nobody has agreed in writing by **30 April 2027**, go to **C** on 31 July 2027 (with B only as a bridge if a successor is close). In every case delete the broker CRM by 31 July 2027 at the latest: it is the most sensitive data here and the one part no successor needs.


## Option D: keep running it

Joshua's current expectation (2026-11-04). Everything in "What the site depends on" stays with him, so the work is to make it run without the University:

1. **Data that depends on being a student.** The University events API permission (D3a) was given for camsocs, not for a student: ask UIS and the Office of External Affairs and Communications to confirm it continues after the course. The `@cam.ac.uk` list-mail inbox (J4) cannot continue once his University account closes.
2. **Costs.** About $45 a month (Vercel Pro, Convex Professional) plus the LLM subscription, on his card: keep the spend caps in `docs/platform-limits.md`.
3. **Freshness.** The harvest keeps running on the VPS. The yearly turnover of committees (R5 deletes people 30 days after 30 June) and the October rush of new events need the July annual review and a check in early October.
4. **Contact.** `privacy@camsocs.uk` and `/request` stay the route for rights requests; the privacy notice needs no change unless the controller's contact details change.
5. **Review each July** (retention.md "Annual review"): is the site still used (PostHog), still accurate (T15 sample), still lawful (DPIA-lite)? If not, fall back to B or C.
