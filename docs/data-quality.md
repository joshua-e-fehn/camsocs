# Data-quality checks on production (T15, J9)

Two read-only checks of what production publishes, and their results. Run both after a release that touches resolution, redaction (D1), calendar noise (D6) or the sweep, and at the annual review in July. Neither reads talks.cam content: the sample's profiles pass through the talks guard (decision G1), its calendar leaves talks.cam-derived events out, and both print counts, keys and slugs only.

## T15: the data-quality sample

`webapp/scripts/data-quality-sample.ts` draws a seeded random sample of listed profiles (from `orgs.sitemap`), reads each with `orgs.getBySlug` and reads the next 28 days of the public calendar with `events.list`, as a signed-out visitor does (public queries only, no token, no writes). It checks the data honesty rules (AGENTS.md "Data honesty rules", data-model §1):

| Check | Rule | Kind |
|---|---|---|
| every value (`found`, `inferred`, `owner_confirmed`, `manual`, `conflicting`) has a retrieval date, a confidence in 0..1 and a source type; a public source also has its URL | "every public fact carries a source URL, a retrieval date, a status and a confidence" | hard |
| every `missing` field has a known `missingReason`; every field in `missingFields` is `missing` | missing shown honestly | hard |
| an `inferred` value is below 0.75, a `found` one at or above (data-model §1.1: an LLM value is `found` only with a checked quote) | confidence by rule | hard |
| no CRSid-shaped address anywhere in the projection (`classifyEmail` → `personal_crsid`) | personal CRSids never public | hard |
| no talks.cam source URL and no talks.cam-derived event on a profile | G1 | hard |
| every profile and calendar event has a source URL (mailing-list events excepted); no calendar event is anything but `public` to a signed-out reader; none titled only "someone" | provenance; visibility; D1 | hard |
| "someone" in a description, short description or how-to-join | D1's fallback when a name cannot be made a role: correct, but read by eye | note |
| share of values last seen more than 30 days ago; calendar events by source; organiser-less events outside the University's programme; `takes_part` events without an external link | freshness and attribution | figures |

```bash
cd webapp && bun install --frozen-lockfile
NEXT_PUBLIC_CONVEX_URL=https://cheerful-bandicoot-511.convex.cloud \
  bun run scripts/data-quality-sample.ts --size 60 --seed 2026-11-04
```

Same seed, same sample (as long as the listings are the same). Exit 1 when a hard check fails; the failing profiles are named by slug.

### Result, 2026-11-04 (production, seed `2026-11-04`, 60 of 801 listings)

**All hard checks pass.**

- 2,940 fields read: 683 `found`, 245 `inferred`, 5 `conflicting`, 1,481 `missing` (50.4 %), 526 `not_applicable`. Missing reasons: 1,147 `not_attempted` (no source speaks to the field), 251 `not_found`, 51 `not_published`, 31 `access_restricted`, 1 `unreachable`.
- Freshness: no value was last seen more than 30 days ago (the daily and weekly runs restate what they read); every value from a public source carries its URL.
- 93 upcoming events on the sampled profiles: none talks.cam-derived, all with a source URL.
- Calendar, next 28 days: 486 public events (Camdram 136, website pages 98, University programme 85, Google calendars 78, term cards 69, Luma 11, SU What's On 7, CUCBC 2); none without a source URL, none talks.cam-derived. 32 events outside the University's programme have no listed organiser, all of them Camdram shows (their companies are counterparts or not in the directory, so no card is linked); 14 are `takes_part`, 3 of them (one each from a website, a term card and a Google calendar) without an external link (D6 sets `externalUrl` only when the source gives one).
- 109 of the 801 listings are thin (no description, public event or website) and `noindex`.
- Notes, read by eye: two descriptions read "founded … by someone" (`fallout-theatre` from Camdram, `graduate-orchestra` from the SU profile). That is D1 working as specified (a founder named in the source is a private individual), but the sentence reads badly; a later prompt revision could drop such clauses instead of writing "someone".

Not covered by the sample, deliberately: whether a value is *true* (that needs the source page read by a person, listing by listing), and talks (counted only: docs/talks-coverage.md).

## J9: `clean-events` on production

`camsocs clean-events` (docs/deploy.md §7, `pipeline/src/camsocs_pipeline/cleanup.py`) lists stored events no corrected reader restates. The dry run reads every event through `/api/pipeline/events/scan` and removes nothing.

```bash
pixi run pipeline -- --env prod clean-events          # dry run; never with --titles in a shared log
```

History:

- **2026-10-10**: first applied on production, 11 pre-D6 notice events removed (`--apply`).
- **2026-11-04**, dry run (read-only): 1,240 stored events; **10 candidates, all `stale-card`** (future term-card events no card has shown for three days), none `notice:*`, `external:*` or `stale-redaction`. All 10 are already invisible: `events.locate` answers `missing` for each, because the listing sweep (data-model §2 `sweepGroup`, ENG-36) withdraws them from every public query. Removing them only deletes the rows.

To finish J9 (operator, on the VPS host so it never runs next to a harvest; not between 04:30 and 06:30 or on Sunday 02:00–08:00):

```bash
sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod clean-events'          # expect 10, all stale-card
sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod clean-events --apply'  # "removed 10; already gone 0"
sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod clean-events'          # expect 0
```

If the first command lists anything other than `stale-card` rows, stop and check those keys before applying (docs/deploy.md §7 "Reasons").
