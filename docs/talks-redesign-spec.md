# Talks pillar, redesign and camsocs.uk — build contract (2026-10-31)

This file is the shared contract for the parallel build of three things Joshua asked for on 2026-10-31:

1. **camsocs.uk** replaces camsocs.vercel.app as the public origin.
2. **Talks**: a third pillar next to societies and events — every public academic talk in Cambridge, across all departments, not only CS.
3. **Redesign**: a user-friendly, interactive, Cambridge-specific UI instead of the stock shadcn look.

Research behind it (kept out of the repo, summarised here): 310 University units were mapped; talks.cam.ac.uk's public API carries about 120 talks/week from about 120 series; most departments additionally (or only) publish on their own sites. Many run the UIS `cambridge_tailwind` Drupal theme (`/events` listing + schema.org `Event` JSON-LD on detail pages).

Decision **D7** (recorded in PLAN.md §6): academic talks are their own pillar with their own tables (`departments`, `talks`, `talkDetails`). They do **not** go through the claims engine. Reasons: volume (hundreds a week; the events path caps at 1000 per window and would swamp the society calendar), the provenance unit is the talk listing itself (one source URL and a read time per talk, not per field), and the talks need no D1 redaction (speakers are the point of a talk listing; talks.cam titles are works). Society-run talks stay events as before.

---

## 1. Hard rules

- **talks.cam.ac.uk is read by parser code only. It never reaches a model**: no LLM call, and no AI agent reads it with WebFetch or a browser. This is the rule from the 2026-10-07 decisions plus its robots.txt. Tests use fixtures. Debug output that is shown to an AI agent prints aggregates only: counts, ids and status codes.
- **Department sites are `GENERAL` purpose** (`sources/policy.py`). robots.txt always holds for them, so the polite client must allow every fetch. Never fetch `webservices.admin.cam.ac.uk`, `events.cam.ac.uk`, Google Calendar or Raven-gated pages.
- **All talk sources are parser-only and zero-LLM.** Add each new source type to `NO_LLM_SOURCE_TYPES` so the AI gate refuses them, whatever happens.
- Politeness: the existing polite client (`sources/base.py`). That means the honest UA, one request in flight per host, robots `Crawl-delay` honoured, and talks.cam at least 10 s between requests.
- No University crest, logo, Feijoa/Open Sans fonts, or the brand palette led by #8EE8D8. Cambridge flavour comes from our own palette, serif type, term-week vocabulary and line motifs.
- Bun only for the webapp. Never export `CONVEX_DEPLOY_KEY`. Build agents run **`bunx convex codegen` only, never `convex dev`/`deploy`**. The integrator pushes to dev.

## 2. Department registry (pipeline)

File: `pipeline/src/camsocs_pipeline/talks/departments.json`, loaded and validated by `camsocs_pipeline/talks/registry.py`.

```json
{
  "key": "dept-computer-science-and-technology",
  "slug": "computer-science-and-technology",
  "name": "Department of Computer Science and Technology",
  "shortName": "Computer Science",
  "school": "technology",
  "website": "https://www.cst.cam.ac.uk",
  "aliases": ["Computer Laboratory", "Computer Lab", "CST"],
  "venueHints": ["William Gates Building"],
  "talksCamListIds": [ ],
  "sources": [
    { "kind": "drupal_uis", "url": "https://www.example.cam.ac.uk/events", "label": "Department events", "checked": "2026-10-31" }
  ]
}
```

- `school` is one of `arts_humanities`, `humanities_social_sciences`, `biological_sciences`, `clinical_medicine`, `physical_sciences`, `technology`, `other`. `other` covers non-School institutions, museums, college lecture series and partner institutes.
- `sources[].kind` is one of `ics`, `rss`, `json_api`, `json_ld`, `drupal_uis`. A source that no parser reads is not listed. The coverage report shows departments with no sources.
- Keys are `dept-<slug>`. Slugs are stable and never reused.
- `talksCamListIds` are numeric strings, found as links on the department's own site. Never guess one.

## 3. Talk record (pipeline → Convex wire)

```ts
type TalkWire = {
  key: string            // "talk-" + sha1(`${sourceType}:${externalId}`).slice(0, 20)
  sourceType: "talks_cam" | "dept_ics" | "dept_rss" | "dept_json" | "dept_jsonld" | "dept_drupal"
  source: string         // the sweep scope: "talks_cam" or `${departmentKey}#${sourceIndex}`
  externalId: string     // talks.cam talk id, ICS UID, feed guid, or canonical URL
  url: string            // the public page for this talk (talks.cam /talk/index/<id>, or the dept page)
  sourceUrl: string      // where it was read (API page or feed URL)
  title: string          // ≤ 500 chars, plain text
  speakers: { name: string; affiliation?: string }[]   // ≤ 10
  series?: string        // ≤ 300
  departmentKeys: string[]    // first entry = primary; may be empty for unmapped talks.cam series
  startsAt: number       // epoch ms (UTC instant)
  endsAt?: number        // epoch ms
  allDay: boolean
  venue?: string         // ≤ 300
  online: boolean        // online-only or hybrid link present
  kind: "seminar" | "lecture" | "workshop" | "conference" | "other"
  cancelled: boolean
  abstract?: string      // plain text, ≤ 4000 (HTML stripped)
  specialMessage?: string// ≤ 1000
  retrievedAt: number    // epoch ms
}
```

Cross-source dedupe happens in the pipeline before posting. Two records are the same talk if they have the same talks.cam talk id (a department page often links to it), or the same normalised title and the same start minute. The talks.cam record wins. `departmentKeys` is the union of both, and the department's URL is dropped.

`series` mapping to departments (talks.cam): deterministic code only. First a registry `talksCamListIds` match on the series id. Then a case-insensitive whole-word match of registry `name` / `shortName` / `aliases` against the series name. Then `venueHints` against the venue name. Otherwise the talk has no department and shows up under "Other series".

## 4. Convex (webapp/convex)

### Tables (schema.ts)

- `departments`: `key`, `slug`, `name`, `shortName`, `school`, `website`, `aliases: string[]`, `updatedAt`. Indexes `by_key`, `by_slug`, `by_school`.
- `talks` (kept light, at most about 1 KB per row): `key`, `sourceType`, `source`, `externalId`, `url`, `sourceUrl`, `title`, `speakers`, `series?`, `departmentKeys: string[]`, `primaryDepartmentKey: string | null`, `school: string | null` (from the primary department), `startsAt`, `endsAt: number | null`, `allDay`, `venue: string | null`, `online`, `kind`, `cancelled`, `listing: "listed" | "missing"`, `firstSeenAt`, `lastSeenAt`, `lastRunId`, `updatedAt`, `searchText` (lower-case title + speakers + affiliations + series + venue + department short names).
  - Indexes: `by_key`, `by_listing_startsAt` [listing, startsAt], `by_listing_school_startsAt` [listing, school, startsAt], `by_listing_dept_startsAt` [listing, primaryDepartmentKey, startsAt], `by_source_startsAt` [source, startsAt].
  - Search index `search_text`: searchField `searchText`, filterFields `listing`, `school`, `primaryDepartmentKey`.
- `talkDetails`: `talkKey`, `abstract`, `specialMessage`. Index `by_talkKey`.
- `talkRuns`: `runId`, `status: "ok" | "partial" | "error"`, `startedAt`, `finishedAt`, `sourcesOk`, `sourcesFailed`, `talksReceived`, `inserted`, `updated`, `unchanged`, `missing`, `errors: string[]`. Index `by_runId`, `by_finishedAt`.

### Ingest routes (http.ts, same bearer as the other pipeline routes)

All routes accept `POST /api/pipeline/...`:

- `talks/departments`: `{ departments: Department[] }`. Upsert by key, at most 500 per call.
- `talks/batch`: `{ runId, talks: TalkWire[] }`. At most 200 per call. Upsert by key. Unchanged rows only get `lastSeenAt` and `lastRunId` bumped. A changed row also gets `updatedAt`. `listing` goes back to `listed`. Upsert `talkDetails` too. Server-side caps match §3, and the server derives `primaryDepartmentKey`, `school` and `searchText`.
- `talks/sweep`: `{ runId, from, to, sources: string[] }`. For each `source` (it was read completely this run), every row with `startsAt` in [from, to) and `lastRunId !== runId` becomes `listing: "missing"`. Rows are never deleted here. The route returns `{ missing }`. Paginate internally if needed.
- `talks/runs`: the run summary, upserted by `runId`.

Retention: a daily cron deletes talks (and their details) whose `endsAt ?? startsAt` is more than 30 days in the past.

### Public queries (convex/talks.ts)

Every query returns `listing: "listed"` rows only, with abstracts left out except in `get`:

- `list({ from, to, school?, department?, kind?, online?, paginationOpts })` → a paginated page of `TalkListItem`, ascending `startsAt`.
- `search({ q, school?, department?, from?, limit? })` → `TalkListItem[]` from the search index (upcoming only, from `from` or now).
- `get({ key })` → a `TalkPublic` (list item + `abstract`, `specialMessage`, `sourceUrl`, `firstSeenAt`, `lastSeenAt`), or null.
- `dayCounts({ from, to, school?, department? })` → `{ day: "YYYY-MM-DD" (London), count }[]` for the week strip. It reads the light rows.
- `departments()` → each department with `upcomingCount` (next 28 days) and `nextStartsAt`, plus the virtual "Other series" bucket. Read from a precomputed `departmentStats` doc that the sweep refreshes (a single doc or a small table), so the query never scans thousands of talks.
- `overview()` → `{ thisWeek, next28Days, departments, lastRunAt }`, also precomputed.

`TalkListItem` = `{ key, title, speakers, series, departments: {key, slug, shortName, school}[], startsAt, endsAt, allDay, venue, online, kind, cancelled, url }`.

### ICS

`webapp/app/talks.ics/route.ts` (Next route handler, `fetchQuery`). Query params match the `/talks` URL state (`school`, `dept`, `kind`, `q`). It returns the next 60 days as RFC 5545 (UID `<key>@camsocs.uk`, DTSTART in UTC, SUMMARY, LOCATION, URL, DESCRIPTION with speaker + series + source link). The `.ics` responses carry `Cache-Control: public, s-maxage=3600`.

## 5. Design system ("Backs & limestone")

Tokens go in `app/globals.css`. The names are part of the contract: components use only these and the shadcn semantic names, never raw hex.

| token | light | dark | use |
|---|---|---|---|
| `--background` | #F7F4EC | #0E1614 | paper |
| `--card` / `--popover` | #FFFDF8 | #15201D | |
| `--foreground` | #16231F | #ECE8DE | ink |
| `--muted` | #EFEADD | #1A2622 | |
| `--muted-foreground` | #5B6660 | #9AA49E | |
| `--border` / `--input` | #E2DCCD | #24302C | |
| `--primary` (Cam sage) | #2E6A55 | #8CC7AE | societies, primary actions |
| `--primary-foreground` | #FFFDF8 | #0E1614 | |
| `--accent` | #DCEBE2 | #1C3029 | sage tint |
| `--ring` | #2E6A55 | #8CC7AE | |
| `--events` / `--events-tint` | #A8432C / #F3DED6 | #E58B70 / #3A2019 | events pillar (Tudor brick) |
| `--talks` / `--talks-tint` | #34407A / #E1E4F2 | #A9B3EA / #1F2440 | talks pillar (lecture-hall indigo) |
| `--gilt` | #B8902F | #D9B65A | decoration only, never text |
| `--backs` | #A9CDBB | #2F5446 | decorative river green, never text |

Expose them through `@theme inline` as Tailwind colours: `bg-events`, `text-talks`, `bg-talks-tint` and so on.

**School colours** (talks), as a tint/ink pair used on chips: `--school-arts` plum, `--school-hss` brick, `--school-bio` green, `--school-clinical` teal, `--school-physical` indigo, `--school-tech` slate-blue, `--school-other` gilt-brown. Pick accessible pairs with at least 4.5:1 for text, in both modes.

**Type.** Newsreader (Google Fonts, variable, with `opsz` and italic), loaded via `next/font` as `--font-serif` / Tailwind `font-serif`. It is for h1/h2, the wordmark, big numerals, and titles on detail pages. Geist Sans stays for the UI and Geist Mono for times, counts and term stamps (`tabular-nums`).

**Motifs.**
- A term clock strip: "MICH · WK 4 · SAT 31 OCT", or "VACATION · LENT STARTS IN 9 WEEKS", computed from `termDates`.
- A meandering river-line SVG divider (the Cam) in `--backs`.
- Term-week stamps on every date.
- N°-numbered ruled index rows for departments.

**Voice.** Plain, warm, a little wry, local: Mich/Lent/Easter, Week 0, formals, bops, supos, Sidgwick Site, West Cambridge. Never imply endorsement.

**Rules.**
- Default theme: system, plus a visible theme toggle. Remove the bare single-key `d` shortcut, or make it `shift+d` with a modifier check.
- Content is never `opacity:0` in server HTML. `Reveal` must be no-JS safe: animate only after mount, and only with `prefers-reduced-motion: no-preference`.
- Use 44 px tap targets and a 16 px mobile gutter.
- Pillar colour coding: Societies = sage, Events = brick, Talks = indigo.

## 6. Pages

- **Shell.** The term strip, then the header with the wordmark (Newsreader italic "camsocs" plus a small river-line glyph, no 2×2 squares). Nav: Societies · Events · Talks · About. A search pill shows "Search ⌘K" and opens the palette. Sign in sits behind the account menu, and there is a theme toggle. The footer is editorial: river line, oversized italic wordmark, columns, disclaimer.
- **⌘K palette** (cmdk): groups Societies (`orgs` search), Events, Talks (`talks.search`), Colleges, Pages. On phones it is full screen.
- **Home.** In order:
  - serif hero with a scoped search (All / Societies / Events / Talks) and quick chips;
  - three pillar counters;
  - "This week" agenda with Events | Talks tabs;
  - category tiles with example names;
  - talks by School/department index;
  - by college;
  - a method note.
- **/societies.** A sticky search plus a chip strip. A desktop facet rail with chips and counts; on phones, a bottom-sheet filter with "Show N". Dense rows with a monogram tile (serif initials on a category tint, college stripe). Sort: relevance / A–Z / active this term. Curated sections when no filter is set.
- **/societies/[slug].**
  - Header: identity, fact row and student-first actions (Website / Instagram / Email / Add to calendar / Share). Owner actions move to a quiet "Is this your society?" link.
  - Body: About (clamped), upcoming this term, then details. Desktop has a sticky facts card. Provenance becomes compact: one subtle "Sourced" info chip per section, with details in a popover. Do not delete provenance.
- **/events.**
  - Default list: day-grouped agenda with sticky day headers, plus a week strip with counts.
  - Presets: Today / This week / Weekend / Rest of term.
  - A filter sheet on mobile. "Taking part" is off by default. Load day by day: 7 days first, then "Show next week".
- **/talks (new).**
  - School rail, week strip with counts, presets, search (`talks.search`), department combobox, kind, online.
  - Day-grouped `TalkRow`s: time column, serif title, speaker · affiliation, series + department chips, venue.
  - Paginated, with "Load more".
  - A detail sheet (`?talk=<key>`) and a shareable `/talks/[key]` page.
  - A Subscribe modal that builds a `webcal://` link to `/talks.ics` from the current filters, plus "Add to calendar" per talk.
  - A department index (`/talks/departments`) grouped by School, with N°-ruled rows and counts.
- The **About** and privacy pages name the new talk sources and the parser-only rule.

## 7. Domain

- `SITE_URL` fallback → `https://camsocs.uk`.
- The UA contact URL → `https://camsocs.uk/about` (code defaults). The VPS env keeps its explicit UA until the next runner install.
- Vercel `NEXT_PUBLIC_SITE_URL` and Convex prod `SITE_URL` → `https://camsocs.uk`.
- Better Auth trusted origins include both hosts during the move.
- The Google OAuth client needs the callback `https://camsocs.uk/api/auth/callback/google` (J2; Joshua's console).
- `camsocs.vercel.app` 308-redirects to `camsocs.uk` once DNS and OAuth work.
