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
- **Seed harvesters** (T3b): `sport_clubs` (§3), `sport_guide_pdf` (§4), `camdram_societies`
  (§5), `cucbc_clubs` (§7), `colleges` (§8), in `sources/`. Contact and link reading is
  shared (`sources/contact_links.py`: personal CRSids never become values, role vs general
  addresses, social links classified, obfuscated addresses detected and never decoded).
- **resolve** (T4) maps identities to keys and writes `var/staging/_resolved/`.
- **load** posts every keyed observation from the latest file of each directory through
  `ConvexLoader.post_observations`: sources → claims → orgInternal → relationships →
  event organisers → broker inferences. Convex resolves values and computes confidence.

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

## Politeness rules (enforced in `sources/base.py`)

- robots.txt is checked per host with our User-Agent; `Crawl-delay`/`Request-rate` raise the
  per-host interval; an unreachable robots.txt (5xx, network) or 401/403 means "disallow".
- One request in flight per host, at least `CAMSOCS_MIN_HOST_INTERVAL` apart; different hosts
  may run concurrently.
- 429/503/transport errors back off 20 s → 300 s with jitter and honour `Retry-After`.
- 401/403 are recorded as `access_restricted` and never retried with credentials.
- Raw bodies are cached under `var/cache/<host>/` with their SHA-256; conditional requests and
  hash comparison report unchanged pages as `unchanged`.
- 404/410 are negative evidence (`not_found`), never "verified".
