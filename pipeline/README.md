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
```

`sync` exits non-zero if any stage failed, even though the stages that succeeded kept their
work — a cron that sees success because most of it worked is how a broken source stays broken.

## Stages, staging and loading

`camsocs_pipeline/stages/__init__.py` holds the one ordered registry `sync` runs:

    seed → harvest → resolve → enrich → events → inbox → load → report

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
- Shared helpers for harvesters: `sources/links.py` (what a link or address is: socials,
  chat platforms, mailing lists, email kinds, withholding CRSids and chat invites from free
  text), `sources/contact_links.py` (role vs general addresses, obfuscated addresses detected
  and never decoded) and `sources/markdown.py` (HTML → the markdown stored in free-text
  fields).
- A stage after resolve that meets a new organisation (enrichment's sponsors, an event's
  organiser) keys it through `resolve.Resolver.reference_key` against the crosswalk —
  never with `keys.org_key` directly.
- **resolve** (T4, `stages/resolve.py`, `camsocs_pipeline/resolve/`) decides which observations
  are one organisation and keys everything: the persisted crosswalk first (`var/state/crosswalk.json`
  merged with Convex's `POST /api/pipeline/crosswalk`), then SU id, the other source ids, Instagram
  handle, website, and normalised name within level and college. It never merges across type
  families, levels or colleges, nor two entries one source lists separately; a strong match it
  refuses holds the weaker side back. It writes `var/staging/_resolved/` and the quarantine
  `var/reports/quarantine.json` (held records, dropped references, matches to review).
  Decide a quarantined case in `pipeline/resolve-decisions.json` (`same` groups / `distinct`
  pairs of the refs the report prints) and the next run applies it.
- **enrich** (T5, `stages/enrich.py`, `sources/websites/`, prompt `extract/prompts/org_v1.md`)
  reads each resolved organisation's website (and Linktree, which robots.txt currently disallows):
  home page plus one page per kind, deterministic socials / role emails / feeds / mailing lists /
  join links / health, then the bulk LLM with every value's quote checked against the page it is
  attributed to. Committee names go to the private broker tables only; named sponsors become
  counterpart organisations. It writes keyed observations to `var/staging/society_website/` and
  `var/staging/linktree/`. LLM answers are cached under `var/cache/llm/`.
- **Events stages** (T6, `camsocs_pipeline/events/`, one module per source: Camdram, talks.cam,
  CUCBC, Playwaze, University events, society ICS/Luma/Google feeds, SU What's On) run after
  resolve. They resolve organiser hints against the keyed organisations in staging
  (`events/organisers.py`; never minting an org key), keep unmatched ones in
  `unresolved_organisers` instead of holding the event back, and write keyed
  `EventObservation`s to `var/staging/<source_type>.events/` — a directory of their own,
  because Camdram and CUCBC also feed harvest stages. Stages that read the network say
  `fetches=True` in the registry. Times, the window, recurrence and the bogus-time-zone
  heuristic are documented in `events/common.py` and `events/ics.py`.
- **load** posts every keyed observation from the latest file of each directory —
  `_resolved` first, since it creates the organisations later stages add fields to — through
  `ConvexLoader.post_observations`: sources → (images) → claims → orgInternal → relationships →
  event organisers → broker inferences. Convex resolves values and computes confidence.
  Images staged as `{sourceUrl}` are uploaded first (our own copy, never a hotlink;
  `media.py`). `--limit N` loads the first N keyed records. Claims travel in batches that
  keep each entity's claims together (the server creates an entity only from a request that
  carries its required fields); a batch too heavy for one mutation is posted again in halves.
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

Read from `pipeline/.env` (gitignored) or the environment:

| Variable | Purpose |
|---|---|
| `CONVEX_HTTP_URL` | `https://<deployment>.convex.site` — where `/api/pipeline/*` lives (or set `CONVEX_URL` and it is derived) |
| `PIPELINE_API_KEY` | Bearer key; must equal `PIPELINE_API_KEY` on the Convex deployment |
| `LLM_BASE_URL`, `LLM_API_KEY` | OpenAI-compatible endpoint |
| `LLM_MODEL_BULK`, `LLM_MODEL_STRONG` | Model ids; any id starting with `claude` is refused |
| `LLM_CONCURRENCY` | Parallel LLM calls (default 8) |
| `CAMSOCS_USER_AGENT` | Honest crawler User-Agent with a contact URL; browser-like strings are refused |
| `CAMSOCS_CACHE_DIR` | Raw response cache (default `<repo>/var/cache`) |
| `CAMSOCS_STAGING_DIR` | Staged observations (default `<repo>/var/staging`) |
| `CAMSOCS_STATE_PATH` | Run state file (default `<repo>/.camsocs-state.json`) |
| `CAMSOCS_MIN_HOST_INTERVAL` | Minimum seconds between requests to one host (default 1.0) |
| `CAMDRAM_API_KEY` | Optional Camdram API access token (Bearer); without it the Camdram events stage paces itself at 3 s |
| `CAMSOCS_REPORTS_DIR` | Reports such as the mailing-list worklist (default `<repo>/var/reports`) |
| `META_IG_USER_ID`, `META_ACCESS_TOKEN` | Instagram Business Discovery (both unset: the `instagram` stage skips itself); setup in `docs/setup/inbox-instagram.md` |
| `META_GRAPH_VERSION` | Graph API version (default `v25.0`) |

## Politeness rules (enforced in `sources/base.py`)

- robots.txt is checked per host with our User-Agent; `Crawl-delay`/`Request-rate` raise the
  per-host interval; an unreachable robots.txt (5xx, network) or 401/403 means "disallow".
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

## LLM stages: inbox, instagram, termcards

These run after `resolve` and know organisations from the keyed observations in staging
(`known_orgs.KnownOrgs`). They share `extract/events.py`:

- The model reports what a text says, with verbatim quotes, using the prompts in
  `extract/prompts/`: `email_events_v1`, `caption_events_v1` and `image_events_v1`.
- `extract/when.py` resolves "Wednesday of Week 3" and similar from the verified term dates.
- Every value becomes an `llm_field`, its quote checked against the exact text sent.
  Contact details are redacted before any LLM call.
- `extract/dedupe.py` drops events another staged source already has.
- `extract/memo.py` caches validated replies under `var/cache/llm/`.

The three stages:

| Stage | Source | Visibility | Notes |
|---|---|---|---|
| `inbox` | pending forwarded list mail (§16) | `cam_only` / `members_only` | posts its events itself, then marks each mail; also stages them under `mailing_list_email/` |
| `instagram` | Graph API Business Discovery (§17) | `public` / `members_only` | gated on `META_*`; at most 100 handles a run, rate-limit aware; stores post images as our own copy |
| `termcards` | `termcardUrl` values (§21) | `public` / `members_only` | strong-model vision; PDF text layer checks quotes; SU `/asset/` files are robots-blocked |

In a dry run, `instagram` and `termcards` only report what they would read.
