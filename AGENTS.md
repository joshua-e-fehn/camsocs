# AGENTS.md

> This file is the repo-specific contract for any coding agent working here. `CLAUDE.md` is a symlink to it. The shared vibe protocol lives in `.vibe/PROTOCOL.md` and is imported at the end.

## Project Overview

camsocs is a verified, current database of Cambridge student societies and sports clubs, built from automated harvesting plus LLM extraction. Every field records its source and status. On top of the database sit a public discovery site (browse, filter, events calendar) and a **private brokering CRM** (people, needs and offers, interactions, introductions).

- Personal / portfolio project by Joshua Fehn.
- **Unofficial.** It is not affiliated with the University of Cambridge or Cambridge SU. Never use the crest or logo, or "University of Cambridge" / "Cambridge University", as branding.
- Read first:
  - `PLAN.md`: spec, tasks, decisions log;
  - `docs/data-model.md`: the schema contract;
  - `docs/source-research.md`: per-source rules (cite as §N);
  - `docs/webapp.md`: webapp internals;
  - `docs/ops-vps.md`: the scheduled harvests on the VPS host (D5).

## Techstack

- **Python pipeline** (`pipeline/`, package `camsocs_pipeline`, run through pixi): harvests public sources and extracts structured claims with an LLM, then pushes them into Convex over authenticated HTTP. Stages are discover → fetch → parse → extract → resolve → transform → load.
  - Fetching uses a polite client (`sources/base.py`). It checks robots.txt for each host, keeps one request in flight per host and honours Crawl-delay. Raw pages are cached in `var/cache/` with a SHA-256.
  - Every fetch carries a purpose, `general` or `society` (`sources/policy.py`, decision D3). Only a `society` fetch of a D3 URL class (a society's website, its Linktree, a Google Calendar ICS feed it links, an SU `/asset/` file from its profile, a college / JCR / MCR society list) may override a robots.txt disallow or an AI opt-out. Such a fetch is recorded `robots_override:society` / `ai_optout_override:society` on its `sources` row.
  - LLM calls go through cliproxy, an OpenAI-compatible endpoint backed by Joshua's ChatGPT Codex Pro login. The model is `gpt-6-luna` for bulk work and `gpt-6.1-sol` for vision and hard cases.
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
- **Scheduled runs are stage groups** (`GROUPS` in `stages/__init__.py`): `sync --group events` daily, `--group full` weekly. They run on the VPS host under systemd timers as the `camsocs` user (`ops/vps/`, `docs/ops-vps.md`, decision D5), never inside Mya's Hermes container; a failure DMs the operator on Slack. Nothing in the repo installs or deploys them: Joshua's operator does.
- **Pipeline stages are one ordered registry**, `pipeline/src/camsocs_pipeline/stages/__init__.py` (seed → harvest → resolve → enrich → classify → events → inbox → load → report). Adding a stage is one line; its docstring has the convention. Harvest stages only write observations (`models/observation.py`) to `var/staging/`; `resolve` assigns keys; `load` posts. Events stages (`camsocs_pipeline/events/`) write keyed events to `var/staging/<source_type>.events/`. Calendar noise (decision D6) is judged at load, not in staging: notices (a prayer room closed, a deadline) are never posted, and someone else's event a society only takes part in is posted `hosting: takes_part` (`events/noise.py` rules, `extract/event_noise.py` model); the UI never shows such an event as organised by the society. Images are stored copies, uploaded by `load` (`media.py`), never hotlinks.
- **Vocabularies live in `webapp/lib/vocab.ts`** (as-const tuples, no server imports) and are mirrored in the pipeline. A test asserts the two match.
- **Privacy boundary:**
  - Every `convex/broker/*` function calls `requireBrokerUser`. Only verified emails in the `BROKER_EMAILS` Convex env var get in; unset means nobody does.
  - Public queries return the public projection only.
  - `cam_only` events need a verified `@cam.ac.uk` session.
  - `members_only` events are never shown.
  - Accepted removals and objections are **suppressions** (listing, field, contact address as a sha256, broker person, event, a person's name as a sha256): the load filters them out before posting (`pipeline/.../suppressions.py`), every ingestion route refuses them and the public projection strips them (`convex/lib/suppressions.ts`, data-model §3). Never work around one.
- **LLM guard:** `extract/llm.py` refuses any model id containing `claude` or `anthropic` (any provider prefix or separator), and any id that is not plain printable ASCII. Never route Claude subscription credentials through cliproxy; Anthropic's terms prohibit it.
- **talks.cam content is parsed deterministically and is never passed to the LLM.** Its robots.txt blocks AI agents; see source-research §6. No fetch purpose overrides that, nor tbc.xyz's block.
- **Public free text is redacted on its way to Convex** (decision D1). `ConvexLoader.post_observations` runs `extract/redact.py`: names of private individuals in descriptions, how-to-join and other notes, event and session titles, venues and price notes become roles; a title that cannot be made safe keeps its event from being posted. Links to personal profiles and URLs that spell a redacted name are cut to their text. The original goes only into `fieldClaims.valueRaw`. Staging keeps the source's own words. Speakers are published only for talks and workshops, never a known committee member.
- `webapp/convex/_generated/` is committed, and `check:codegen` guards it.
- Convex test files need two dots in their names (`*.test.ts`, `*.testing.ts`) so they are never deployed. Register any new module in `convex/lib/harness.testing.ts`.
- `MAX_BATCH = 500` must stay equal in `webapp/convex/lib/ingest.ts` and `pipeline/.../load.py`.

## Data honesty rules

- Every public fact carries a source URL, a retrieval date, a status and a confidence.
- Never invent or guess emails, handles or URLs. An unknown value stays missing, with a `missingReason`.
- A failed fetch is never recorded as found. A 404 is recorded as `not_found`.
- An LLM claim without a verifiable verbatim quote is recorded as `inferred`, never `found`.
- No scraping of Instagram, Facebook or LinkedIn. Store links only. The only access to Meta data is the official Business Discovery API.
- Do not decode obfuscated emails. Do not fetch Raven-gated, members-only or 403 pages.
- Respect robots.txt on every non-society page. Society pages and feeds of the D3 classes may be read where robots.txt or an AI opt-out disallows, but only through `sources/policy.py`, and the override is recorded. Never override talks.cam or tbc.xyz. Never fetch the University Events API (webservices.admin.cam.ac.uk).
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
pixi run pipeline -- --env prod status   # pipeline/.env.prod on top of pipeline/.env (docs/deploy.md §4)
cd webapp && bun run e2e                 # Playwright smoke + screenshots → var/screenshots/<date>/ (read-only guard)
cd webapp && unset CONVEX_DEPLOY_KEY && bunx convex dev --once   # push to dev and regenerate convex/_generated (commit it)
cd webapp && bunx convex env list                                # add --prod for production
```

- Dev Convex deployment: `hushed-rhinoceros-215` (team `joshua-fehn`, project `camsocs`). Production (Vercel + Convex prod + the pipeline's `--env prod`): `docs/deploy.md`.
- **Never export `CONVEX_DEPLOY_KEY` in a shell.** It overrides `.env.local`, and once deployed one project's functions onto another project's production. `scripts/convex-deploy-if-key.sh` deploys only on Vercel.
- Secrets live in `webapp/.env.local` (Convex) and `pipeline/.env` (pipeline). Both are gitignored, and their values must never be printed.
- Bun is the only JS/TS package manager. Never use npm, pnpm or yarn.
- Gates before review: `pixi run lint` (Ruff, ShellCheck, Biome), `typecheck`, `test`, `check-codegen`, plus `cd webapp && bun run build`.
- Any time you create or change UI, consult `webapp/DESIGN.md`. Follow the Atomic Design import rules in `docs/webapp.md`.
- Third-party source is vendored under `.vibe/sources/`. To read a dependency's real implementation instead of guessing, run `vibe vendor <pkg>`. Prefer this over recalling the API from memory.
- Commits follow conventional style (`feat:`, `fix:`, `refactor:`, `docs:`).

@.vibe/PROTOCOL.md
