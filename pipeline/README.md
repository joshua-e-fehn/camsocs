# camsocs pipeline

Python harvester for camsocs: fetches public society and sports-club sources politely, extracts
facts (deterministic rules first, then an LLM over cached text with verbatim-evidence checks) and
loads them into Convex over `/api/pipeline/*`.

Run everything through pixi from the repo root.

## Running

```bash
pixi run pipeline -- status              # resolved config (secrets shown only as set/unset), state
pixi run pipeline -- health              # GET /api/pipeline/health with the Bearer key
pixi run pipeline -- sync --dry-run      # every stage, no credentials needed, nothing written
pixi run pipeline -- sync                # health → runs/start → stages → runs/finish
pixi run pipeline -- sync --stages term_dates,load --limit 20
pixi run pipeline -- derive              # re-derive statuses / term weeks / stale flags now
pixi run pipeline -- purge-dev --yes     # empty pipeline tables on the DEV deployment only
pixi run pipeline -- worklist            # rank societies for mailing-list sign-up → var/reports/
pixi run pipeline -- coverage [--before DIR]  # field coverage of staged organisations, offline
pixi run harvest                         # the full harvest + coverage report (below)
pixi run prune-cache                     # retention R7: var/cache + old staging, 90 days
pixi run pipeline -- --env prod status   # any command against production (below)
```

**Which deployment.** `pipeline/.env` is the dev deployment. `--env <name>` (before the
command) reads `pipeline/.env.<name>` on top of it, or `CAMSOCS_ENV_FILE=<path>` (relative to the
repo root) names that file; the flag wins. The environment file must exist and must state
`CONVEX_HTTP_URL` / `CONVEX_URL` and `PIPELINE_API_KEY` itself — inherited from `pipeline/.env` or
exported in the shell, the run stops before any request. A non-dev environment keeps its own run
state (`.camsocs-state.<name>.json`); the cache and staging are shared. `purge-dev` refuses any
environment but dev. `status` prints the environment. Setup: `docs/deploy.md` §4.

`sync` exits non-zero if any stage failed, even though the stages that succeeded kept their
work — a cron that sees success because most of it worked is how a broken source stays broken.

### The full harvest: `pixi run harvest`

One command for a full run (`camsocs harvest`; `pixi run harvest -- --dry-run` reads but writes
nothing, `-- --limit N` for a trial):

1. every stage in registry order — `term_dates` → the seed harvesters → `resolve` → `enrich`
   → the events stages → `inbox` / `instagram` / `termcards` → `load` → `report` — inside one
   run-log row (`runs/start` … `runs/finish`, which also refreshes the broker overview's
   coverage);
2. `derive`: the background re-derivation (statuses, term weeks, stale flags);
3. the **coverage report**, `var/reports/coverage-<YYYY-MM-DD>.md` (London date), written by
   the `report` stage from the deployment itself (`POST /api/pipeline/coverage` and
   `coverage/events`, the same fold the broker overview shows): listed organisations,
   hidden, counterparts; by level, status and type; every organisation field with how many
   listed organisations hold it and the share; upcoming events per source and visibility;
   the 15 tracked fields most often missing; the quarantine; the run's stages.

To keep a log, run `pixi run harvest 2>&1 | tee .logs/harvest-$(date +%Y%m%d).log`. **On a
laptop, keep it awake** (`caffeinate -i pixi run harvest …` on macOS): a full run takes about
two hours, and a sleeping machine stalls it. In the 2026-10-09 harvest the SU stage took 96
minutes instead of about 11 — its requests were 1.1 s apart (median), but two requests hung for
26 and 58 minutes while the machine slept (a 24 s back-off took 12.5 minutes of wall time), and
the load stage later stalled the same way. Pacing was not at fault. The daily cron
(`scripts/daily-sync.sh`) runs `sync` over the same registry, so it writes the day's coverage
report too.

### Retention on the pipeline host: `pixi run prune-cache`

`camsocs prune-cache [--older-than 90d] [--dry-run] [--no-staging]` deletes what
docs/compliance/retention.md R7 allows to keep for 90 days: cached pages (a page's body,
meta and last-failure note go together, once all are older), LLM replies under
`var/cache/llm/`, and superseded staging files (never the latest file of each part, which
`load` still reads). Add it to the host's cron next to the daily sync.

## Stages, staging and loading

`camsocs_pipeline/stages/__init__.py` holds the one ordered registry `sync` runs:

    seed → harvest → resolve → enrich → classify → events → inbox → load → report

- **Adding a stage** is one line: write `stages/<name>.py` with `run(ctx)` and uncomment
  (or add) `Stage("<name>")` in its phase. The module is imported when the stage runs, so
  there is no import line to add; the docstring of `stages/__init__.py` has the full
  convention.
- **Harvest and enrichment stages only write observations** to staging —
  `var/staging/<source_type>/<run_key>--<stage>.jsonl` via `ctx.staging.writer(...)` with
  the stage name as the part (`sources/observe.run_harvest` does it), so two stages of one
  source type never hide each other; `read_latest` returns the latest file of each part —
  using the models in `models/observation.py` and the helpers in `claims.py`
  (`parser_field`, `llm_field`, `missing_field`). They never mint organisation keys and
  never call Convex.
- **In a dry run a harvest stage makes no request**: it replays what `var/cache` holds
  (`PoliteClient.cached`) and stages nothing, so `sync --dry-run` stays offline.
- **Seed harvesters** (T3): `su_directory` (§1), `proctors_register` (§2), `sport_clubs`
  (§3), `sport_guide_pdf` (§4), `camdram_societies` (§5), `cucbc_clubs` (§7), `colleges`
  (§8), in `sources/`.
- Shared helpers for harvesters: `sources/links.py`, the one module that says what a link or
  address is — one social-link classifier (`social_link`; never a person's LinkedIn, a post
  or a video), one `classify_email` (role / general / personal / unknown), one CRSid rule
  (`is_crsid_address`: cam.ac.uk and subdomains, SRCF, cantab), the server's email kinds
  (`email_type`), chat platforms, mailing lists, obfuscated addresses detected and never
  decoded, CRSids and chat invites withheld from free text — and `sources/markdown.py`
  (HTML → the markdown stored in free-text fields).
- A stage after resolve finds a known organisation with `resolve.lookup.OrgLookup`
  (`reference_key`, plus the inbox's list / address / domain / name lookups, feeds, venues,
  Instagram targets and termcards): keyed staging plus the crosswalk (local cache merged
  with Convex's, never in a dry run), unique answers only. Enrichment's sponsors, which may
  create counterparts, go through `resolve.Resolver.reference_key`. Neither ever calls
  `keys.org_key` directly.
- **resolve** (T4, `stages/resolve.py`, `camsocs_pipeline/resolve/`) decides which observations
  are one organisation and keys everything: the persisted crosswalk first (`var/state/crosswalk.json`
  merged with Convex's `POST /api/pipeline/crosswalk`), then SU id, the other source ids, Instagram
  handle, website, and normalised name within level and college. It never merges across type
  families, levels or colleges, nor two entries one source lists separately; a strong match it
  refuses holds the weaker side back. It writes `var/staging/_resolved/` and the quarantine
  `var/reports/quarantine.json` (held records, dropped references, matches to review).
  Decide a quarantined case in `pipeline/resolve-decisions.json` (`same` groups / `distinct`
  pairs of the refs the report prints, each `{"refs": [...], "why": "the evidence"}`) and
  the next run applies it; a `same` group that joins keys loaded apart keeps the first and
  reports the others for `ingest/purge:removeEntity`. `claims` there (`{ref, field, value,
  why, decided}`) are posted as `manual` claims on the ref's organisation (the SU's Test Soc
  is `defunct`). A page observed for several groups (a college's "JCR and MCR" page) is no
  group's identifier.
- **enrich** (T5, `stages/enrich.py`, `sources/websites/`, prompt `extract/prompts/org_v1.md`)
  reads each resolved organisation's website and Linktree with the society fetch purpose (D3:
  robots.txt and AI opt-outs may be overridden there, and the override is recorded):
  home page plus one page per kind, deterministic socials / role emails / feeds / mailing lists /
  join links / health, then the bulk LLM with every value's quote checked against the page it is
  attributed to. Committee names go to the private broker tables only (and privately onto the
  page record, so the load step's redaction removes them from public text); named sponsors
  become counterpart organisations, restated from the page that names them on every run (the
  crosswalk outlives the deployment's rows, so a counterpart staged only by the run that first
  met it would be missing after a dev purge or in a new production deployment). It writes keyed observations to `var/staging/society_website/` and
  `var/staging/linktree/`. LLM answers are cached under `var/cache/llm/`.
- **classify** (R2, `stages/classify.py`, `camsocs_pipeline/classify/`, prompt
  `extract/prompts/classify_v1.md`) fills what no source states for every listed
  organisation — `orgType` / `level` / `collegeKeys` of a registered society, `categories`,
  `activityTypes`, `audiences`, `languages`, `tags`: deterministic rules first (`inferred`),
  then the bulk model, eight organisations a call, with every value's quote checked against
  the organisation's own texts. Its keyed observations sit beside their source
  (`var/staging/<source_type>/<run>--classify.jsonl`); a value it no longer claims is
  restated `not_found`. Model answers are cached per organisation under
  `var/cache/llm/classify_v1/`.
- **Events stages** (T6, `camsocs_pipeline/events/`, one module per source: Camdram, talks.cam,
  CUCBC, Playwaze, University events, society ICS/Luma/Google feeds, SU What's On) run after
  resolve. They resolve organiser hints with `resolve.lookup.OrgLookup` (never minting an org
  key), keep unmatched ones in
  `unresolved_organisers` instead of holding the event back, and write keyed
  `EventObservation`s to `var/staging/<source_type>.events/` — a directory of their own,
  because Camdram and CUCBC also feed harvest stages. Stages that read the network say
  `fetches=True` in the registry. Times, the window, recurrence and the bogus-time-zone
  heuristic are documented in `events/common.py` and `events/ics.py`.
- **load** posts every keyed observation from the latest file of each directory —
  `_resolved` first, since it creates the organisations later stages add fields to — through
  `ConvexLoader.post_observations`: sources → (images) → claims → orgInternal → relationships →
  event organisers → broker inferences. Convex resolves values and computes confidence.
  On the way, public free text is redacted (decision D1, `extract/redact.py`, prompt
  `redact_names_v2`; titles, venues and price notes included, a title that cannot be made
  safe keeps its event out): names of private individuals become roles, the original travels as the
  claim's internal `valueRaw`, and a text that cannot be made safe is posted `not_published`.
  The bulk model's replies are cached by the input's sha256; a dry run uses the cache and the
  deterministic rule only.
  Images staged as `{sourceUrl}` are uploaded first (our own copy, never a hotlink;
  `media.py`); bytes the deployment already stores are not sent again (`StoredFileCache`,
  below). Event readings that another
  source already lists (same organiser, London date and visibility, similar title, starts
  ≤ 30 min apart) are posted as claims on that source's event, not as events of their own
  (`events/duplicates.py`, data-model §2 "One event, several sources"). `--limit N` loads the first N keyed records. Claims travel in batches that
  keep each entity's claims together (the server creates an entity only from a request that
  carries its required fields); a batch too heavy for one mutation is posted again in halves.
  - **The suppression list first.** Before anything is posted, the plan is filtered by what
    accepted removals and objections took off the site (`suppressions.py`, read once per
    loader from `POST /api/pipeline/suppressions`): nothing about a suppressed listing (claims,
    feed ids, edges, inferences, owned source rows, organiser links; an event it alone
    organised), no value for a suppressed field, no suppressed address (dropped from `email`,
    `roleEmails` and mailing lists, cut out of free text as `[address removed]`; addresses are
    known only as sha256 hashes), no suppressed broker person. A truncated list stops the
    load; an undeployed route filters nothing and the notes say so. Convex refuses whatever
    slips through. The `inbox` stage's posts go through the same filter.
  - **Idempotent.** Each organisation's feed identifiers travel as one merged `orgInternal`
    patch (lists merged, the later scalar wins — the state the server's sequence of patches
    used to end in), so a second identical load reports 0 updated; claims are no-ops by
    fingerprint.
  - **Images are uploaded once per deployment.** `var/state/stored-files.json` remembers
    sha256 → storageId per deployment URL (`StoredFileCache`); bytes the deployment already
    stores are not sent again (the notes count them). An id the deployment no longer has
    (the claim is refused with "storageId does not name a stored file") makes the loader
    forget the ids it reused that run; `purge-dev` forgets the dev deployment's.
- **Stage counters.** A stage that stages observations reports them as *new* (`inserted`):
  harvest stages, `resolve` (its keyed copies), `enrich`, the events stages, `termcards` and
  `instagram` (records carried forward from an earlier run count as *unchanged*). `load`
  reports what reached Convex. `resolve` also reports its quarantine as `metrics`
  (`quarantineHeld`, `quarantineDropped`, `quarantineReview`), stored with the run and shown
  on the broker overview.
- **resolve holds** a new organisation no observation names (a guide row whose A–Z club is
  not staged) and keys an organisation's `parent` like any reference, or drops it.

Contracts shared with the webapp, each guarded by a test:

| Python | TypeScript | Test |
|---|---|---|
| `models/vocab.py` | `webapp/lib/vocab.ts` | `test_vocab_parity.py` |
| `keys.py` | `webapp/lib/keys.ts` | `test_keys.py` + `keys.test.ts` on `webapp/lib/keys.fixtures.json` |
| `models/wire.py` | `webapp/convex/ingest/*.ts` validators | `test_wire.py`, `test_load_routes.py` |
| `MAX_BATCH` in `pipeline/load.py` | `webapp/convex/lib/ingest.ts` | `test_load.py` |

## Configuration

Read from `pipeline/.env` (gitignored; plus `pipeline/.env.<name>` with `--env <name>`) or the environment:

| Variable | Purpose |
|---|---|
| `CONVEX_HTTP_URL` | `https://<deployment>.convex.site` — where `/api/pipeline/*` lives (or set `CONVEX_URL` and it is derived) |
| `CAMSOCS_ENV_FILE` | A second env file read on top of `pipeline/.env` (as `--env <name>` reads `pipeline/.env.<name>`); environment only, never in an env file |
| `PIPELINE_API_KEY` | Bearer key; must equal `PIPELINE_API_KEY` on the Convex deployment |
| `LLM_BASE_URL`, `LLM_API_KEY` | OpenAI-compatible endpoint |
| `LLM_MODEL_BULK`, `LLM_MODEL_STRONG` | Model ids; any id starting with `claude` is refused |
| `LLM_CONCURRENCY` | Parallel LLM calls (default 8) |
| `CAMSOCS_USER_AGENT` | Honest crawler User-Agent with a contact URL, `camsocs-bot/0.1 (+https://camsocs.vercel.app/about)`; browser-like strings and any email address are refused |
| `CAMSOCS_CACHE_DIR` | Raw response cache (default `<repo>/var/cache`) |
| `CAMSOCS_STAGING_DIR` | Staged observations (default `<repo>/var/staging`) |
| `CAMSOCS_STATE_PATH` | Run state file (default `<repo>/.camsocs-state.json`) |
| `CAMSOCS_MIN_HOST_INTERVAL` | Minimum seconds between requests to one host (default 1.0; less than 1 is refused) |
| `CAMDRAM_API_KEY` | Optional Camdram API access token (Bearer); without it the Camdram events stage paces itself at 3 s |
| `CAMSOCS_REPORTS_DIR` | Reports such as the mailing-list worklist (default `<repo>/var/reports`) |
| `META_IG_USER_ID`, `META_ACCESS_TOKEN` | Instagram Business Discovery (both unset: the `instagram` stage skips itself); setup in `docs/setup/inbox-instagram.md` |
| `META_GRAPH_VERSION` | Graph API version (default `v25.0`) |

## Politeness rules (enforced in `sources/base.py` and `sources/policy.py`)

- robots.txt is checked per host with our User-Agent; `Crawl-delay`/`Request-rate` raise the
  per-host interval; an unreachable robots.txt (5xx, network) or 401/403 means "disallow".
- **Fetch purpose (decision D3).** `fetch(…, purpose=…)` is `GENERAL` by default: robots.txt
  and AI opt-outs hold. A `SOCIETY` purpose (`SOCIETY_WEBSITE` / `COLLEGE_SOCIETY_LIST` when
  the caller knows the page is a society's own site or a society list) may override a robots
  *disallow* and, in `ai_input_allowed`, an AI opt-out, for the D3 URL classes only: society
  websites, Linktree, Google Calendar public ICS feeds, SU `/asset/` files, college society
  lists. Never for talks.cam or tbc.xyz, a general host (the University's central sites,
  search engines, other networks), or a robots.txt that could not be reached.
  webservices.admin.cam.ac.uk, Instagram, Facebook and LinkedIn are never fetched. An
  overridden fetch carries `FetchResult.override` = `robots_override:society` (also in its
  cache entry and its `sources` row's `accessNote`); the cache never serves it to a general
  fetch.
- One request in flight per host, at least `CAMSOCS_MIN_HOST_INTERVAL` apart; different hosts
  may run concurrently.
- 429/503/transport errors back off 20 s → 300 s with jitter and honour `Retry-After`.
- 401/403 are recorded as `access_restricted` and never retried with credentials. The only
  credential ever sent is an API key a source asks for (Camdram), via `fetch(headers=…)`.
- `post_form` is for a public listing that loads by a form POST (Playwaze fixtures): same robots
  check, pacing and cache; redirects are never followed.
- Raw bodies are cached under `var/cache/<host>/` with their SHA-256; conditional requests and
  hash comparison report unchanged pages as `unchanged`.
- 404/410 are negative evidence (`not_found`), never "verified".

## LLM stages: inbox, instagram, termcards, website_events

These run after `resolve` and know organisations from the keyed observations in staging
and the crosswalk (`resolve.lookup.OrgLookup`). They share `extract/events.py`:

- The model reports what a text says, with verbatim quotes, using the prompts in
  `extract/prompts/`: `email_events_v1`, `caption_events_v1`, `image_events_v1` and
  `website_events_v1`.
- `extract/when.py` resolves "Wednesday of Week 3" and similar from the verified term dates.
- Every value becomes an `llm_field`, its quote checked against the exact text sent.
  Contact details are redacted before any LLM call. List mail is cleaned first
  (`extract/mail_text.py`, deterministic): quoted replies ("On … wrote:", `>` lines, Outlook
  reply headers), forwarded-message headers (the forwarded body stays), signatures (`-- `,
  "Sent from my iPhone", sign-off blocks — keeping a line that names an organisation) and
  list footers (unsubscribe, preferences, copyright) are cut out, then addresses and phone
  numbers redacted. The mail's extraction note counts what was cut, never what it said.
- `extract/dedupe.py` drops events another staged source already has.
- `extract/memo.py` caches validated replies under `var/cache/llm/` (the D1 redaction's too,
  under `redact_names_v2/`). Termcards and website pages give the model the Thursday that
  starts the week as the reference date (`extract.when.week_anchor`), so an unchanged card or
  page is asked about once a week.

The four stages:

| Stage | Source | Visibility | Notes |
|---|---|---|---|
| `inbox` | pending forwarded list mail (§16) | `cam_only` / `members_only` | posts its events itself, then marks each mail; also stages them under `mailing_list_email/` |
| `instagram` | Graph API Business Discovery (§17) | `public` / `members_only` | gated on `META_*`; at most 100 handles a run, rate-limit aware; stores post images as our own copy |
| `termcards` | `termcardUrl` values (§21) | `public` / `members_only` | strong-model vision, four PDF pages a call (≤ 12); PDF text layer checks quotes; old cards skipped; an HTML card page is read as text (`website_events_v1`); society fetch purpose (SU `/file/` links hit the login wall and are recorded restricted; `/asset/` files are read under the D3 override) |
| `website_events` | society websites' events / calendar / term card pages (§14) | `public` / `members_only` | structured data (JSON-LD `Event`) by parser, else the bulk model (`website_events_v1`): a dated quote per event, yearless dates checked by weekday, ≤ 9 months ahead |

In a dry run, `instagram`, `termcards` and `website_events` only report what they would read.
