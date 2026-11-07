# AGENTS.md

> This file is the repo-specific contract for any coding agent working here. `CLAUDE.md` is a symlink to it. The shared vibe protocol lives in `.vibe/PROTOCOL.md` and is imported at the end.

## Project Overview

CAMsocs is a verified, current database of Cambridge student societies and sports clubs, built from automated harvesting plus LLM extraction. Every field records its source and status. On top of the database sit a public discovery site (browse, filter, events calendar) and a **private brokering CRM** (people, needs and offers, interactions, introductions).

- Personal / portfolio project by Joshua Fehn.
- **Unofficial.** It is not affiliated with the University of Cambridge or Cambridge SU. Never use the crest or logo, or "University of Cambridge" / "Cambridge University", as branding.
- Read first:
  - `PLAN.md`: spec, tasks, decisions log;
  - `docs/data-model.md`: the schema contract;
  - `docs/source-research.md`: per-source rules (cite as §N);
  - `docs/webapp.md`: webapp internals;
  - `docs/ops-vps.md`: the scheduled harvests on the VPS host (D5);
  - `docs/rollback.md`, `docs/key-rotation.md`, `docs/platform-limits.md`: production runbooks (ENG-37);
  - `docs/glossary.md`: the project's terms (campus, pillar, source, stage, phase, group, claim, suppression…);
  - `docs/campuses/README.md`: the multi-campus programme, the onboarding contract and the live gate (decision D8); `docs/campuses/cambridge.md` for the live campus.

## Techstack

- **Python pipeline** (`pipeline/`, package `camsocs_pipeline`, run through pixi): harvests public sources and extracts structured claims with an LLM, then pushes them into Convex over authenticated HTTP. Stages are discover → fetch → parse → extract → resolve → transform → load.
  - Fetching uses a polite client (`sources/base.py`). It checks robots.txt for each host, keeps one request in flight per host and honours Crawl-delay, and never connects to a non-public address (loopback, private, link-local, CGNAT: checked after DNS, on every redirect and at connect time). Raw pages are cached in `var/cache/` with a SHA-256.
  - Every fetch carries a purpose, `general` or `society` (`sources/policy.py`, decision D3). Only a `society` fetch of a D3 URL class (a society's website, its Linktree, a Google Calendar ICS feed it links, an SU `/asset/` file from its profile, a college / JCR / MCR society list) may override a robots.txt disallow or an AI opt-out. Such a fetch is recorded `robots_override:society` / `ai_optout_override:society` on its `sources` row. Paths a publisher gave us recorded permission to read (`policy.RECORDED_PERMISSIONS`, decision D3a: the University's events API and event images) may be read whatever the purpose and are recorded `robots_override:permission` / `ai_optout_override:permission`.
  - LLM calls go through cliproxy, an OpenAI-compatible endpoint backed by Joshua's ChatGPT Codex Pro login. The model is `gpt-6-luna` for bulk work and `gpt-6.1-sol` for vision and hard cases; a failed `gpt-6-luna` request is asked once more on `gpt-6.1-sol` (ENG-23, `extract/llm.py` docstring).
- **Convex** (`webapp/convex/`) is the database and backend. Tables written by the pipeline are changed only through internal mutations behind `/api/pipeline/*` (Bearer `PIPELINE_API_KEY`). Resolved field values and the derived fields are computed on the server.
- **Next.js 16 + Tailwind v4 + shadcn (radix-nova, mauve)** (`webapp/`) renders the public site and the private `/dashboard` broker area. Data comes only from Convex hooks; there is no REST layer.
- **Better Auth inside Convex** provides Google sign-in for the admin. A `@cam.ac.uk` email sign-in link (via Resend) unlocks the Cambridge-only tier.

## Non-obvious structure

- **Provenance is per field, not per row.**
  - `fieldClaims` is an append-only log of observed values.
  - Each entity holds plain resolved values plus `meta[field]` = `{status, evidence, confidence, sourceUrl, retrievedAt, method}`.
  - Precedence and confidence rules are in `docs/data-model.md` §1. Confidence is computed by rule, **never self-reported by the LLM**.
- **The pipeline never sends `null` for a field it didn't observe.** Upserts are patches, so it omits the field. (A null once blanked 633 records in Bundestracker.)
- **Entity values arrive only as claims.** `POST /api/pipeline/claims` appends to `fieldClaims`; the server resolves (`convex/lib/resolve.ts`), materialises and derives the row (`convex/lib/materialise.ts`). Field names, validators and merge rules are one registry, `convex/lib/fields.ts`, over the tuples in `lib/vocab.ts`. The public read API and its types are documented in `docs/webapp.md` "Public API".
- **Keys are minted identically on both sides** (`webapp/lib/keys.ts`, `pipeline/.../keys.py`); `webapp/lib/keys.fixtures.json` is asserted by both test suites.
- **Scheduled runs are stage groups** (`GROUPS` in `stages/__init__.py`): `sync --group events` daily, `--group full` weekly. They run on the VPS host under systemd timers as the `camsocs` user (`ops/vps/`, `docs/ops-vps.md`, decision D5), never inside Mya's Hermes container; a failure DMs the operator on Slack (structured facts only, never log lines). Root runs only the runner `install.sh --revision <reviewed commit>` installed root-owned in `/usr/local/lib/camsocs-ops/` from its own mirror, never a file of the camsocs-writable checkout. Nothing in the repo installs or deploys them: Joshua's operator does.
- **Pipeline stages are one ordered registry**, `pipeline/src/camsocs_pipeline/stages/__init__.py`, in phase order seed → harvest → resolve → enrich → classify → events → inbox → load → talks → report (the talks pillar's `talks` stage runs after `load`, which posts the other two pillars). Adding a stage is one registry entry with its metadata (phase, pillar, campus, reads, writes, docs, and sinks / network / llm when they apply; the registry docstring has the convention and `tests/test_stage_metadata.py` checks it), then `pixi run pipeline-graph` and commit `webapp/lib/generated/pipeline-graph.cam.json` and `docs/pipeline-map.md` (`tests/test_graph_export.py` fails while they are stale). Harvest stages only write observations (`models/observation.py`) to `var/staging/`; `resolve` assigns keys; `load` posts. Events stages (`camsocs_pipeline/events/`) write keyed events to `var/staging/<source_type>.events/`. Calendar noise (decision D6) is judged at load, not in staging, after the suppression list (no model reads a suppressed event, name or address): notices (a prayer room closed, a deadline) are never posted (the notes give keys, never titles), and someone else's event a society only takes part in is posted `hosting: takes_part` (`events/noise.py` rules, `extract/event_noise.py` model); the UI never shows such an event as organised by the society. Images are stored copies, uploaded by `load` (`media.py`), never hotlinks.
- **Vocabularies live in `webapp/lib/vocab.ts`** (as-const tuples, no server imports) and are mirrored in the pipeline. A test asserts the two match.
- **Privacy boundary:**
  - Every `convex/broker/*` function calls `requireBrokerUser`. Only verified emails in the `BROKER_EMAILS` Convex env var get in; unset means nobody does.
  - Public queries return the public projection only.
  - `cam_only` events need a verified `@cam.ac.uk` session.
  - `members_only` events are never shown.
  - Accepted removals and objections are **suppressions** (listing, field, contact address as a sha256, broker person, event, a person's name as a sha256): the load filters them out before posting (`pipeline/.../suppressions.py`), every ingestion route refuses them and the public projection strips them (`convex/lib/suppressions.ts`, data-model §3). Never work around one.
- **LLM guard:** `extract/llm.py` refuses any model id containing `claude` or `anthropic` (any provider prefix or separator), and any id that is not plain printable ASCII. Never route Claude subscription credentials through cliproxy; Anthropic's terms prohibit it.
- **talks.cam content is parsed deterministically and is never passed to the LLM.** Its robots.txt blocks AI agents; see source-research §6. No fetch purpose overrides that, nor tbc.xyz's block.
- **Public free text is redacted on its way to Convex** (decision D1). `ConvexLoader.post_observations` runs `extract/redact.py`: names of private individuals in descriptions, how-to-join and other notes, event and session titles, venues and price notes become roles; a title that cannot be made safe keeps its event from being posted. Titles are read in context: a Camdram show's or talks.cam talk's title is a work's name (never redacted), a talk's title on a society's programme names its public speaker, other titles and venues reach the model with their field, type, listing and description. Links to personal profiles and URLs that spell a redacted name are cut to their text. The original goes only into `fieldClaims.valueRaw`. Staging keeps the source's own words. Speakers are published only for talks and workshops, never a known committee member.
- `webapp/convex/_generated/` is committed, and `check:codegen` guards it.
- **Convex schema changes are widen-migrate-narrow** (docs/deploy.md §5, ENG-31). Add a field or table as optional first, deploy, backfill, and only then make it required in a later change; never narrow a validator in the same release that starts writing it. A merge to `main` deploys Convex (Vercel's build), and a rollback across a schema change is a forward fix (docs/rollback.md §2).
- **Tenant = campus = deployment** (decision D8, proposed 2026-11-07, pending Joshua sign-off; `docs/campuses/README.md`). Each university is a `campus` (`cam` live; `zz` "Testford" is synthetic, tests only) with its own Convex deployment, Vercel project and pipeline env file (the seams: `Settings.campus` / `--campus` / `CAMSOCS_CAMPUS` in `pipeline/src/camsocs_pipeline/config.py`, `deploymentCampus()` in `webapp/lib/campus/deployment.ts` for Convex, `currentCampus()` / `NEXT_PUBLIC_CAMPUS` in `webapp/lib/campus/index.ts` for the Next build); there is no tenant column on any table and no key namespace. Call it `campus`, never `university` (that word already names the events stream, an `events.list` argument and an org level). Cambridge output stays byte-identical: keys, fixtures, URLs, staging paths, stage and group names, vocab tuples, prompts, distinct ids, storage keys. Tenancy crosses the three pillars (Societies / Events / Talks) and never merges them.
- Convex test files need two dots in their names (`*.test.ts`, `*.testing.ts`) so they are never deployed. Register any new module in `convex/lib/harness.testing.ts`.
- `MAX_BATCH = 500` must stay equal in `webapp/convex/lib/ingest.ts` and `pipeline/.../load.py`.

## Data honesty rules

- Every public fact carries a source URL, a retrieval date, a status and a confidence.
- Never invent or guess emails, handles or URLs. An unknown value stays missing, with a `missingReason`.
- A failed fetch is never recorded as found. A 404 is recorded as `not_found`.
- An LLM claim without a verifiable verbatim quote is recorded as `inferred`, never `found`.
- No scraping of Instagram, Facebook or LinkedIn. Store links only. The only access to Meta data is the official Business Discovery API.
- Do not decode obfuscated emails. Do not fetch Raven-gated, members-only or 403 pages.
- Respect robots.txt on every non-society page. Society pages and feeds of the D3 classes may be read where robots.txt or an AI opt-out disallows, but only through `sources/policy.py`, and the override is recorded. Never override talks.cam or tbc.xyz. On webservices.admin.cam.ac.uk only the `RECORDED_PERMISSIONS` paths (the events API and event images, D3a) are read; the rest of the host keeps its robots.txt, and the programme list's staff contacts are never stored.
- Personal CRSids and named people never appear in public fields. Names of private individuals in public free text are replaced by roles (D1); the original lives only in `fieldClaims.valueRaw`. Speakers an organiser publishes for a public talk stay named. Named people live only in `broker` tables, with a `staleAfter` date; first-name-only committee members are kept there too (D2).
- No scraped caches, raw personal data or tokens in Git.

## Operational commands

```bash
pixi install
pixi run dev | build | lint | format | typecheck | test | check-codegen
pixi run pipeline -- status | health | sync [--dry-run] [--stages a,b] [--limit N]
caffeinate -i pixi run harvest           # full run (sync --group full): every stage, derive, var/reports/coverage-<date>.md (keep a laptop awake)
pixi run harvest-events                  # the daily run (sync --group events) over what the last full run staged
pixi run harvest -- --env prod           # arguments after `--` follow the command (`--env`, `--dry-run`, `--summary-json`)
pixi run prune-cache                     # retention R7: var/cache + superseded staging older than 90 days
pixi run pipeline -- --env prod clean-events [--apply]   # stored events no reader restates; --apply on prod only (docs/deploy.md §7)
pixi run pipeline -- --env prod status   # pipeline/.env.prod on top of pipeline/.env (docs/deploy.md §4)
pixi run pipeline -- --env prod monitor  # the VPS's hourly PostHog checks, once (docs/ops-vps.md §6 "Monitor")
pixi run posthog-dashboards -- --dry-run # PostHog dashboards as code; --validate / --apply need the personal key (docs/deploy.md)
cd webapp && bun run scripts/data-quality-sample.ts   # T15 sample over public queries; NEXT_PUBLIC_CONVEX_URL=<prod> for production (docs/data-quality.md)
cd webapp && bun run e2e                 # Playwright smoke + screenshots → var/screenshots/<date>/ (read-only guard)
cd webapp && unset CONVEX_DEPLOY_KEY && bunx convex dev --once   # push to dev and regenerate convex/_generated (commit it)
cd webapp && bunx convex env list                                # add --prod for production
```

- Dev Convex deployment: `hushed-rhinoceros-215` (team `joshua-fehn`, project `camsocs`). Production (Vercel + Convex prod + the pipeline's `--env prod`): `docs/deploy.md`.
- **Never export `CONVEX_DEPLOY_KEY` in a shell.** It overrides `.env.local`, and once deployed one project's functions onto another project's production. `scripts/convex-deploy-if-key.sh` deploys only on Vercel.
- Secrets live in `webapp/.env.local` (Convex) and `pipeline/.env` (pipeline). Both are gitignored, and their values must never be printed.
- **Never open a production backup** (`convex-prod-*.zip` on the VPS, a pre-restore export, `last-restore-test.log`) in an agent session: it holds the talks pillar's talks.cam data and the CRM. `camsocs-backup.py inspect` prints table names and counts only (docs/ops-vps.md §10). A restore test runs only into a throwaway local backend, never into dev or another cloud deployment.
- Bun is the only JS/TS package manager. Never use npm, pnpm or yarn.
- Gates before review: `pixi run lint` (Ruff, ShellCheck, Biome), `typecheck`, `test`, `check-codegen`, plus `cd webapp && bun run build`, and CI's accessibility job (`a11y`: axe-core over the public pages, `pixi run a11y`; needs `cd webapp && bun run e2e:install` once).
- Any time you create or change UI, consult `webapp/DESIGN.md`. Follow the Atomic Design import rules in `docs/webapp.md`.
- Third-party source is vendored under `.vibe/sources/`. To read a dependency's real implementation instead of guessing, run `vibe vendor <pkg>`. Prefer this over recalling the API from memory.
- Commits follow conventional style (`feat:`, `fix:`, `refactor:`, `docs:`).

@.vibe/PROTOCOL.md
