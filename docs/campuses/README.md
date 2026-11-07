# Campuses

CAMsocs was built for Cambridge. This folder holds what it takes to run the same product for another university, and where that work stands. Decisions D8 (campuses), D9 (scraper health) and D10 (React Flow on the dashboard) in `PLAN.md` §6 record the choices; they were **proposed on 2026-11-07 and are pending Joshua's sign-off**. Terms are defined in `docs/glossary.md`.

- `cambridge.md`: the live campus, `cam`.
- This file: the programme in brief, the onboarding contract a new campus must meet, its live gate and the launch blockers.

## The programme in brief

**What a campus is.** A campus is one university as a tenant. Each campus is a separate deployment: its own Convex backend, its own Vercel project and host, its own pipeline env file and its own private broker CRM. Nothing is shared at the database level, and no table gets a tenant column. When nothing says otherwise, the campus is `cam` (Cambridge) on every side, so production needs no change at all. The only other id is `zz`, "Testford University", a made-up campus used in tests to prove the seams work; it never appears in a production registry.

**What a pillar is.** The site is about three things, the pillars: **Societies** (the directory of listings), **Events** (the calendar) and **Talks** (academic talks, decision D7). Every pipeline stage belongs to one pillar, or to `shared` for the few that serve all three. Each campus has all three pillars, at the same URLs (`/societies`, `/events`, `/talks`). Tenancy crosses the pillars and never merges them.

**What "Cambridge stays byte-identical" means.** Every lane is checked against Cambridge's current output: organisation and event keys, the key and email-type fixtures, claim fingerprints, URLs, staging paths, stage and group names, vocabularies, LLM prompts and the calendar text that feeds their memo keys, ICS UIDs, analytics distinct ids and consent and storage keys. A lane that changes any of them for `cam` is wrong.

**What is not in scope.** No other university's sources are researched or built. The programme adds only the seam (campus profiles in both languages), tracing visuals (a pipeline map and a status page on the broker dashboard, an ecosystem map) and scraper observability (fetch statistics, yield, traces, shadow alerts).

**Later: C Combinator.** A cross-university view would be a separate aggregate that reads each campus's *public* projection and joins them by `${campus}:${key}`. Graph node ids already use that form. It is not part of this programme.

### Lanes

**Status (2026-11-07):** no lane has merged yet; wave 0 (L0a, L0b) is in review, and D8–D10 await sign-off. Update this line as lanes land.

One lane is one worktree and one squash PR of at most 20 files; a file has one owner at a time. The full spec (data model, file ownership, verification per lane) is kept outside the repo by the orchestrator; this table is the summary.

| Wave | Lane | What it delivers | Depends on |
|---|---|---|---|
| 0 | **L0a** guardrails | Snapshot tests that freeze today's stage registry, groups, loader payloads (synthetic staging), runner contract and calendar context; the opt-in `CAMSOCS_PAYLOAD_DIGEST` hook in the loader | – |
| 0 | **L0b** docs, decisions, campus facts | D8–D10 in `PLAN.md`; `AGENTS.md` rules; the deploy runbook rule; `docs/glossary.md`, this folder; `webapp/lib/campus/campuses.fixtures.json` and its Python test | – |
| 1 | **L1** pipeline campus profile | `camsocs_pipeline/campuses/` (profile, `CAMBRIDGE`), `Settings.campus` and `--campus`, stage metadata (phase, pillar, campus, reads, writes, sinks, docs), `registry(profile)` and `groups(profile)` | L0a |
| 1 | **L2** Convex run-log widen | Optional `durationMs`, `group` and `revision` on the run log; `runs.start` accepts them | L0b |
| 1 | **L3** webapp campus core | `webapp/lib/campus/` (profiles, terms, member email) and its Convex consumers | L0b |
| 1 | **L11** ecosystem map | Co-hosting, sponsor and outreach layers on `/dashboard/graph` | L0a |
| 2 | **L4** pipeline heuristics | Term calendar, other-university noise, location and member-email rules read from the profile | L1 |
| 2 | **L5** pipeline graph export | `camsocs graph`, `webapp/lib/generated/pipeline-graph.cam.json`, `docs/pipeline-map.md` | L1 |
| 2 | **L6** telemetry and fetch stats | `campus`, pillar, phase and yield on harvest events; per-stage fetch counters; LLM traces; an advisory staging write guard | L1, L2 live in production |
| 2 | **L8** webapp presentation profile | `lib/site.ts` and friends read the campus profile; `campus` on web analytics | L3 |
| 2 | **L10** broker pipeline-status queries | `broker/pipeline.ts`: stage status, runs, stage detail | L2 |
| 3 | **L7** monitor, alerts, dashboards | New checks in shadow mode (D9), campus-aware alert script, "Scraper health" PostHog dashboard | L6 |
| 3 | **L12** dashboard pages | `/dashboard/pipeline` (React Flow, D10) and `/dashboard/status` | L5, L10 |

### Rollout order (production)

1. L0a and L0b merge: tests and docs only, no runtime change. Joshua signs off D8–D10 before any wave 1 lane merges.
2. L2 merges and the Vercel build deploys Convex. Only optional fields are added, so nothing can be refused.
3. L1 merges with the VPS pinned (dry run on the host, unpin, check the status file). L3 and L11 merge, then the data-quality sample and the e2e smoke run against production.
4. L4 (VPS pinned) and L5 merge, then L10, then L8 (followed by an HTML diff of the prerendered pages and the smoke run).
5. L6 merges **only after L2 is live in production**, with the VPS pinned; the next run must show fetch counters, `durationMs` and `campus=cam` in PostHog.
6. L7 merges; the operator reinstalls the runner (`install.sh --revision`) and applies the dashboards. Shadow checks run for 14 days before D9 promotion.
7. L12 merges.

Every pipeline or Convex-coupled merge follows the runbook rule in `docs/ops-vps.md` §3 (pin, merge, confirm the Convex deploy in the Vercel build log, unpin; never 04:00–05:00 or Sunday 01:30–02:30 London time). Rollback is a revert plus the VPS pin; the optional Convex fields stay.

## Onboarding contract for a new campus

A new campus is added only after the launch blockers below are cleared. Then, in order:

1. **Decide the id.** Two to eight lowercase letters (`^[a-z]{2,8}$`, the shape PostHog and the alert script accept). Not `zz`.
2. **Research its sources** in `docs/campuses/<id>.md`, in the format of `docs/source-research.md`: robots.txt verdict quoted with date, terms, rate limits, fields, traps, and any recorded permission. Every source the campus reads gets a `§N`.
3. **Add its facts** to `webapp/lib/campus/campuses.fixtures.json` (terms, member-email rule with `strictForeignAcademic: true`, university domains, official event sources) and email cases that exercise them.
4. **Build its profiles**: the pipeline `CampusProfile` (term calendar and dates, member ids, name rules, branding, its own stages and groups) and the webapp profile (brand, place, member tier, terms, pillars).
5. **Widen vocabularies append-only** (source types, terms, event sources) in `webapp/lib/vocab.ts` and the pipeline mirror, only for sources actually built.
6. **Provision**: a Convex deployment, a Vercel project and host with `NEXT_PUBLIC_CAMPUS=<id>`, `CAMSOCS_CAMPUS=<id>` in Convex env, `BROKER_EMAILS`, and `pipeline/.env.<id>-prod` containing `CAMSOCS_CAMPUS=<id>`. Runner units per `docs/ops-vps.md` §11.
7. **Pass the live gate** (next section) before the first production ingest.

### Live gate (all must hold before a non-cam campus ingests into production)

- [ ] Every launch blocker below is closed.
- [ ] The zz privacy tests pass: member-email classification (`emailCases`) on both sides, other-university noise, location rules, week labels with a non-Thursday week start.
- [ ] Cambridge's snapshots are unchanged: registry, loader golden, calendar context, `keys.fixtures.json`, `email-types.fixtures.json`, and Joshua's payload digest compared base against branch.
- [ ] `docs/campuses/<id>.md` covers every source the campus's stages read, and `camsocs graph` validates (every cited `§` exists).
- [ ] A dry run of the campus's groups on the host, under the lock, writes staging, reports and crosswalk only under `var/campus/<id>/` (plus the shared, URL-keyed `var/cache`) and posts nothing.
- [ ] The campus's legal pages (privacy, removal, Art 14 basis) and its record of processing entry are approved by Joshua.
- [ ] The monitor's site checks and shadow alerts are scoped to the campus (`ifNull(properties.campus,'cam')`).
- [ ] Joshua signs off the launch in `PLAN.md` §6.

### Launch blockers for a second site

These stay Cambridge-specific on purpose in this programme, and each must be generalised (or written for the new campus) before any non-cam deployment ingests or serves:

- **Prompts.** LLM prompts name Cambridge; templating them needs a byte-identical render test for `cam` (a future "prompts" lane).
- **Colleges.** The four college lists, collegiate facets and JCR/MCR handling (`CollegeSystem`).
- **Policy hosts.** `policy.py` host rules, `LOGIN_HOSTS`, `NOT_SOCIETY_HANDLES` (`HostRules`).
- **Identity.** Identity kinds, `KNOWN_ALIASES`, `SOURCE_PRIORITY`, `IdentityHints.external_ids`.
- **Legal and copy.** Legal pages, directory title regexes, category copy, the About page's source list.
- **Talks aggregator.** The talks.cam step inside the `talks` stage is Cambridge's; it must be split out before the Talks pillar runs elsewhere.
- **Module layout.** Cambridge-only modules still live in the engine packages (`Stage.module` makes the move to `campuses/cam/` mechanical later).
- **Shared write deployment.** A `campus` column, `by_campus_*` indexes, namespaced keys (`org-<ns>--<slug>`, reserved by D8) and a shared multi-campus deployment exist only if C Combinator ever needs one.
