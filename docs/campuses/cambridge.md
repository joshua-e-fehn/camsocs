# Cambridge (`cam`)

The live campus, and the default everywhere: with `CAMSOCS_CAMPUS` / `NEXT_PUBLIC_CAMPUS` unset, the pipeline, Convex and the webapp all run as `cam` (decision D8, proposed 2026-11-07, pending Joshua's sign-off; `docs/campuses/README.md`).

| | |
|---|---|
| Site | https://camsocs.uk (Vercel project `camsocs`, Git-connected to `main`) |
| Convex | production `cheerful-bandicoot-511`; dev `hushed-rhinoceros-215` (docs/deploy.md) |
| Pipeline env | `pipeline/.env` (dev), `pipeline/.env.prod` (production); no `CAMSOCS_CAMPUS` needed |
| Harvests | the VPS runner, `events` daily 04:30 and `full` Sunday 02:00 Europe/London (docs/ops-vps.md) |
| Staging and reports | `var/staging`, `var/reports`; resolver decisions `pipeline/resolve-decisions.json` |
| University domain | `cam.ac.uk`; member ids are CRSids (`[a-z]{2,5}[0-9]{1,5}`); `cam_only` events need a verified `@cam.ac.uk` sign-in |
| Terms | Michaelmas, Lent, Easter (`MT`, `LT`, `ET`); a teaching week runs Thursday to Wednesday, Week 0 to Week 10 (source-research §19) |
| Facts fixture | `webapp/lib/campus/campuses.fixtures.json` → `campuses.cam`, asserted against today's constants by `pipeline/src/tests/test_campus_facts.py` |

## Sources

Cambridge's source research is **`docs/source-research.md`**. It stays at that path, not in this folder, because code and docs cite its sections as `§N` (about 127 citations); its header names it as this campus's file. Per-source rules, robots.txt verdicts, the D3 society override, the D3a recorded permission (the University's events programme, §10) and the talks.cam rules (§6, never passed to a model, G1) all live there.

## Byte-identical

Everything Cambridge produces today stays as it is through the multi-campus programme: keys, `webapp/lib/keys.fixtures.json`, `webapp/lib/email-types.fixtures.json`, claim fingerprints, URLs, staging paths, stage, group, part and source-type names, vocab tuples, prompts, the calendar context line that feeds LLM memo keys, ICS UIDs, analytics distinct ids, consent and storage keys. The guardrail tests of lane L0a and `test_campus_facts.py` hold the line.
