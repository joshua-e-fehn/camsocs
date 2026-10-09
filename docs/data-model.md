# camsocs data model

This file is the contract for the Convex schema (`webapp/convex/schema.ts`), the pipeline's wire models (`pipeline/src/camsocs_pipeline/models/`) and the UI. Any change goes here first, then into code.

Decisions behind it: see PLAN.md §6 (Decisions log). Field research: `docs/research/2026-10-07-landscape-brief.md` §8.

## 0. Rules

1. **Keys.** Every entity has a minted string `key`. `v.id` is never used across tables or in the wire format (only for `_storage` files). Minting lives in `webapp/lib/keys.ts` and `pipeline/.../keys.py`, asserted against shared fixtures (`webapp/lib/keys.fixtures.json`):

   | Entity | Key |
   |---|---|
   | organisation | `org-<slug(name)>`; `slug` = key without `org-` |
   | venue | `ven-<slug(name)>` |
   | team | `team-<org slug>--<slug(team name)>` |
   | session | `ses-<sha1(orgKey:slug(title):dayOfWeek:startTime)>` |
   | event | `evt-<sha1(source:externalId)>` |
   | relationship | `rel-<sha1(fromKey:type:toKey)>`, minted by the server |
   | source | `src-<sha1(url)>` |
   | person | `per-<sha1(orgKey:slug(name))>` |

   `slug`: NFKD, a fixed transliteration (ß→ss, æ→ae, ø→o, …), combining marks dropped, `&`→`and`, apostrophes deleted, ASCII lowercase, runs of non-`[a-z0-9]` → `-`, at most 80 characters.
2. **The pipeline is the source of truth.** Tables marked *pipeline-owned* are written only by internal mutations called through `/api/pipeline/*`. The two exceptions are manual or owner overrides, written as `fieldClaims` rows with `method: "manual" | "owner_submitted"`.
3. **Provenance for every field.**
   - `fieldClaims` is an append-only log of every observed value.
   - Resolved current values are denormalised onto the entity as plain fields, plus a `meta` map: `field → FieldMeta`.
   - Resolved values are derived on the server and never posted by the pipeline.
4. **Unknown is not empty.**
   - A field with no value has `meta[field].status = "missing"` and a `missingReason`.
   - Plain fields are optional (`v.optional`), and arrays are always present.
   - The pipeline never sends `null` for an unobserved field. Upserts are patches, so it simply omits the field.
5. **Privacy boundary.**
   - Public queries return only the public projection (§7).
   - Everything under `convex/broker/*`, plus the internal tables, sits behind `requireBrokerUser`.
   - Rows whose `visibility = "cam_only"` (events) need a verified `@cam.ac.uk` session.
6. **Times.** Instants are stored as epoch milliseconds (UTC). Dates are stored as ISO `YYYY-MM-DD`. Display is in `Europe/London`.
7. **Vocabularies.** Vocabularies are `as const` tuples in `webapp/lib/vocab.ts`, turned into validators via `literalUnion`. The Python side mirrors them in `models/vocab.py`. A test asserts the two match.

## 1. FieldMeta: provenance on every resolved field

```ts
FieldMeta = {
  status: "found" | "inferred" | "owner_confirmed" | "manual" | "conflicting" | "missing" | "not_applicable",
  evidence?: "primary" | "secondary",          // primary = the organisation's own channel, or the official register for registration facts
  missingReason?: "not_found" | "not_published" | "access_restricted" | "unreachable" | "not_attempted",
  confidence?: number,                          // 0..1, computed by rule (§1.1), never self-reported by the LLM
  sourceUrl?: string,
  sourceType?: SOURCE_TYPES,                   // decides whether sourceUrl may be shown (§7)
  retrievedAt?: number,                         // the winning claim's latest sighting (lastSeenAt)
  method?: "parser" | "llm" | "manual" | "owner_submitted",
  claimCount?: number,                          // independent sources (distinct hosts) that agree
  conflicts?: { value, sourceUrl, sourceType, retrievedAt, method }[],  // when status = conflicting: the other readings
  winnerStatus?: FieldStatus,                   // when status = conflicting: the displayed value's own status (found, inferred, …)
}
```

A field nobody has claimed has `{status: "missing", missingReason: "not_attempted"}`, or `{status: "not_applicable"}` when the field does not apply (sport fields of a non-sports group; college fields of a University-level group). Every claimable field has a `meta` entry.

The engine is `webapp/convex/lib/resolve.ts` (pure, unit-tested). Its rules, in order:

1. **Live claims.** `rejected` and `superseded` claims are ignored. Of the rest, only the newest claim per (`sourceKey`, `method`) counts, by latest sighting: a newer reading of the same page by the same method replaces the older one (the server marks it `superseded`), so a page that stops listing an email retracts it. A page that goes back to an earlier value (X → Y → X) revives the earlier claim: it is accepted again and Y is superseded. A parser and an LLM reading the same page are separate readings.
2. **Status is normalised on the server**, whatever the caller asks for: `manual` → `manual`; `owner_submitted` → `owner_confirmed`; an LLM claim is `found` only with a non-empty `evidenceQuote` and `quoteCheck` `exact` or `normalised`, otherwise `inferred`; a parser claim is `found` unless it says `inferred` (a heuristic). A claim without a value is `missing` (with a `missingReason`, default `not_found`) or `not_applicable`. An empty array is not a value: it counts as `not_found`.
3. **Merge rules per field** (`webapp/convex/lib/fields.ts`): `single` fields take the precedence winner (§1.2); array fields (`aliases`, `categories`, `socials`, `roleEmails`, …) take the **union** of every `found` claim's items (de-duplicated: URLs by normalised URL, role emails by role + address), or of the `inferred` ones when nothing was found, and a manual claim replaces the union; `lastActiveAt` takes the **maximum**; an event's `visibility` takes the **strictest** live reading (`members_only` > `cam_only` > `public`), whatever its precedence or age — only a manual / owner claim lifts it.
   - **Dead links (`website`).** When the newest primary reading *from a URL itself* is negative (`not_found`, `access_restricted`, `unreachable`: the stated website answered 404, a login wall or nothing), claims whose value is that URL are set aside, so a register's stale link is not shown as a working site; a later answer from the URL lifts it.
4. **Missing.** With no live value claim, the best negative claim (primary first, then newest) gives `status` and `missingReason`; a value from any source beats a negative claim from another.

### 1.1 Confidence (by rule, not by asking the LLM)

| Method / evidence | Base confidence |
|---|---|
| parser on a primary source | 0.95 |
| parser on a secondary source | 0.85 |
| llm + verbatim quote check EXACT or NORMALISED, primary | 0.85 |
| llm + verbatim quote check, secondary | 0.75 |
| llm without a verifiable quote, i.e. `inferred` | 0.50 |
| owner_submitted / manual | 1.00 |

- Negative claims use the same table (a parser reading "no email on this page" is as reliable as one reading an email); an LLM negative claim is 0.50.
- Add 0.05 for each additional agreeing independent source, capped at 0.99. *Independent* means a different host of `sourceUrl` (the SU directory and an SU profile are one publisher).
- A value that disagrees with an equal-rank claim makes the status `conflicting`. The precedence winner stays the displayed value, every other reading is kept in `fieldClaims` **and** in `meta.conflicts`, and the UI shows both. Comparison is case-insensitive for emails and ignores scheme, `www.` and trailing slashes for URLs. Free-text fields (`description`, `howToJoin`, `name`, …) never conflict: two sources' prose always differs. Manual claims never conflict (the latest override wins).

### 1.2 Precedence when resolving

1. `owner_submitted` / `manual`.
2. `found` + primary.
3. `found` + secondary.
4. `inferred`.

Ties go to the most recent sighting (`lastSeenAt`, else `retrievedAt`). Claims with `reviewStatus: "rejected"` or `"superseded"` are ignored.

## 2. Pipeline-owned public tables

### organisations

One row per group. This covers societies, clubs, JCRs/MCRs and boat clubs, and also counterpart organisations (colleges, departments, University offices, companies, NGOs, public bodies, other universities' societies).

| Field | Type | Notes |
|---|---|---|
| key, slug | string | `org-<slug>`. Slugs are unique. |
| name | string | Canonical display name. Required to create the row; never blanked once set |
| aliases | string[] | e.g. "CU German Society", "German Soc", "CUGS" |
| shortName | string? | Acronym |
| orgType | vocab `ORG_TYPES`? | society, sports_club, college_club, jcr, mcr, college_boat_club, college, department, uni_office, student_union, company, ngo, public_body, other_university_society, media, theatre_company, other. Optional until a source says (meta says missing) |
| level | vocab `ORG_LEVELS`? | university, college, department, intercollegiate, external. Optional until a source says |
| collegeKeys | string[] | For college-level groups: the college(s), many-to-many (shared clubs) |
| collegeBody | `jcr \| mcr \| college_run \| joint`? | For college-level groups |
| parentKey | string? | Hierarchy, e.g. a team club inside a University club, or a JCR within its college |
| isCounterpart | boolean | true for external or institutional parties that exist only because they are linked to a society. Default false. Counterparts are never listed in the directory and have no `missingFields` |
| defunct | boolean? | Marked defunct by a source (a college's inactive list) or manually; makes `status` `archived` |
| hidden | boolean? | Hidden from the public site by the broker after a remove / object request (`broker.orgs.setHidden`). Not claimable; the pipeline never sets it and re-resolution keeps it. A hidden organisation has no `orgCards` row, so no public query lists, names or links it, and `orgs.getBySlug` is null |
| status | `active \| dormant \| archived \| unknown` | Derived (§6) |
| lastActiveAt | number? | Latest dated activity: the maximum of claimed values (a post, a page update) and the start of the latest past **public** event it organised or co-hosted (derived; its meta then is that event's start's provenance). `cam_only` / `members_only` events never move it |
| registrations | object | `{ su?, proctors?, sportsService?, camdram?, cucbc? }`, each `{ registered: boolean, year?: string, sourceUrl?: string }`, `year` an academic year like `2026-27`. Claimed per register as `registrations.su`, `registrations.proctors`, … These lapse independently. |
| categories | vocab[] `CATEGORIES` | Our taxonomy (§5). An organisation can have several. |
| activityTypes | vocab[] `ACTIVITY_TYPES` | talks, socials, competitions, performances, workshops, trips, training, publications, volunteering, careers_events, formals, worship, meetings |
| audiences | vocab[] `AUDIENCES` | undergraduates, postgraduates, staff, alumni, public, own_college_only, women, men, mixed, lgbtq, international, beginners |
| languages | string[] | ISO 639-1 codes |
| tags | string[] | Free-form, lower-kebab |
| suCategory | string? | Raw SU category; mapped into `categories` |
| department | string? | |
| logo | `{ storageId?: Id<"_storage">, sourceUrl?: string, credit?: string }`? | Always stored as our own copy. Never hotlinked. |
| shortDescription | string? | ≤ 200 characters |
| description | string? | Long description in markdown |
| howToJoin | string? | |
| joinUrl | string? | |
| membership | `{ tiers: { label, pricePence?, period?: "life"\|"year"\|"term"\|"one_off"\|"free", note? }[], bursaryNote?, collegeReimbursable?: boolean }`? | `period` only when the source states it, never assumed |
| beginnerFriendly | boolean? | |
| trials | `{ required: boolean, dates?: string[], note? }`? | Trials or auditions. `dates` are as the source wrote them ("open on 4th October"), ISO `YYYY-MM-DD` only when it gave a full date; the UI formats ISO and shows the rest verbatim |
| timeCommitment | string? | Free text, e.g. "2 trainings/week + Wed matches" |
| termcardUrl | string? | |
| accessibilityNote | string? | |
| sport | object? | `{ sport?, blueStatus?: "full"\|"full_some"\|"discretionary_full"\|"half"\|"none", varsity?: boolean, bucs?: boolean, collegeCompetition?: boolean, genderCategories: ("men"\|"women"\|"open"\|"mixed")[], kitCostNote?, venues?: string[] }`. Each part is claimed separately (`sport.blueStatus`, `sport.genderCategories`, …) because different sources state different parts; the object exists once any part has a value |
| website | string? | Final URL after redirects |
| email | string? | General contact address, published by the organisation or a register |
| emailType | vocab? `EMAIL_TYPES` | role_own_domain, cambridgesu, srcf, lists_cam, college_domain, webmail, personal_crsid, legacy_cusu. **Derived on the server** from `email` (`classifyEmail`), never claimed: the public projection depends on it. `personal_crsid` = a CRSid-shaped local part on cam.ac.uk or a subdomain (not lists.cam.ac.uk), or on srcf.net, srcf.ucam.org, cantab.ac.uk or cantab.net, which issue addresses by CRSid |
| roleEmails | `{ role: vocab ROLES, email }[]` | president, secretary, treasurer, sponsorship, events, publicity, welfare, captain, other. Only addresses the organisation publishes. |
| contactFormUrl | string? | |
| mailingList | `{ platform?: "sympa"\|"mailchimp"\|"google_group"\|"other", address?, signupUrl? }`? | Public shows the sign-up only |
| socials | `{ platform: vocab SOCIAL_PLATFORMS, url, handle? }[]` | instagram, facebook_page, facebook_group, x, linkedin, tiktok, youtube, linktree, website_blog, wechat, threads, bluesky |
| chatChannels | `{ platform: "whatsapp"\|"discord"\|"telegram"\|"slack"\|"groupme", howToJoin?: string }[]` | Never store invite URLs (a `howToJoin` containing one is rejected) |
| searchText | string | Derived: name, aliases, short description, tags and categories. Has a search index. |
| meta | `Record<string, FieldMeta>` | One entry per resolvable field above |
| missingFields | string[] | Derived: fields whose status is `missing`. Drives the phase-2 outreach. |
| createdAt, updatedAt | number | Stamped by mutations |

**Indexes:** `by_key`, `by_slug`, `by_level_status`, `by_orgType`, `by_isCounterpart`, plus a search index `search_text` on `searchText` with filter fields level, status and orgType.

**Claimable fields.** The fields a claim may target are the tuples `ORGANISATION_FIELDS`, `EVENT_FIELDS`, `TEAM_FIELDS`, `SESSION_FIELDS` and `VENUE_FIELDS` in `webapp/lib/vocab.ts` (mirrored in the pipeline). Each has a value validator (the schema column's), a merge rule and checks in `webapp/convex/lib/fields.ts`: URLs must be `http(s)`, keys must have their prefix, times are `HH:MM`, `shortDescription` ≤ 200 characters, tags lower-kebab, languages ISO 639-1. Derived fields are never claimable.

### orgCards (derived, public)

A small copy of each organisation for the directory list and its filters (`key, slug, name, nameSort, shortName, shortDescription, orgType, level, status, isCounterpart, collegeKeys, categories, activityTypes, audiences, beginnerFriendly, sport {sport, blueStatus, genderCategories}, logoStorageId, searchText, updatedAt`), maintained by the server whenever the organisation changes. `orgs.list` and `orgs.facets` scan it (a few hundred bytes per row) instead of the full rows (~10 KB each with descriptions and meta). It holds nothing that is not public. **Indexes:** `by_key`, `by_isCounterpart_nameSort`, `by_orgType`, search index `search_text` (filters isCounterpart, level, status, orgType).

### teams

Child rows of a sports club. Created by claims for `orgKey` and `name`.

| Field | Type | Notes |
|---|---|---|
| key | string | |
| orgKey | string | |
| name | string | e.g. "Blues", "LX", "Jays" |
| rank | number? | |
| gender | `men\|women\|open\|mixed`? | |
| league | string? | e.g. "BUCS Midlands Tier 2" |
| memberCollegeKeys | string[] | |
| meta | `Record<string, FieldMeta>` | |

### sessions

Regular activities: trainings, weekly meetings, services. Created by claims for `orgKey` and `title`; `dayOfWeek` and the times are optional (a source may give only "weekly").

| Field | Type | Notes |
|---|---|---|
| key | string | |
| orgKey | string | |
| title | string | |
| dayOfWeek | 0..6? | 0 = Sunday |
| startTime / endTime | "HH:MM" | |
| venueKey / venueText | string? | |
| termScope | `full_term \| all_year \| michaelmas \| lent \| easter`? | |
| note | string? | |
| meta | `Record<string, FieldMeta>` | |

### events

| Field | Type | Notes |
|---|---|---|
| key | string | `evt-<sha1(source + ":" + externalId)>` |
| title | string | |
| description | string? | |
| startsAt | number | |
| endsAt | number? | |
| spanEndsAt | number? | Derived: `endsAt` of a multi-day event (longer than 25 h), so a run that began before a view still shows in it |
| allDay | boolean | Default false |
| termWeekLabel | string? | e.g. "MT26 Wk 3" (derived from `termDates`, §6) |
| venueKey / venueText | string? | |
| organiserKeys, coHostKeys, sponsorKeys | string[] | Organisation keys, set only by `eventOrganisers` (not claimable). Sponsors and co-hosts also create `relationships` edges. |
| speakers | `{ name, affiliation? }[]` | Only as published |
| price | `{ free: boolean, minPence?, maxPence?, text? }`? | |
| bookingUrl | string? | |
| signupRequired | boolean? | |
| visibility | `public \| cam_only \| members_only` | Required. Mailing-list-derived events default to `cam_only` and are never `public` (refused on ingest, clamped on materialise). The strictest live reading wins (§1 rule 3). `members_only` is never shown publicly. |
| eventType | vocab `EVENT_TYPES` | talk, social, performance, competition, match, workshop, trip, formal, careers, meeting, training, worship, fair, other. Default `other` |
| image | `{ storageId?, sourceUrl? }`? | Our own stored copy |
| cancelled | boolean | Default false |
| status | `confirmed \| tbc` | Default `confirmed` |
| source | vocab `EVENT_SOURCES` | camdram, talks_cam, ics, luma, google_calendar, playwaze, uni_events_api, cucbc, su_whatson, mailing_list, instagram_api, termcard, website, manual |
| externalId | string | |
| sourceUrl | string | The event's page, or an opaque internal URI (`inbound:<message-id>`) for mailing-list events, never shown |
| lastSeenAt | number | Derived: latest sighting of any of its claims |
| sweepGroup | string? | Derived: the listing it was read from — the source (Camdram, CUCBC, SU What's On) or source + listing URL (a feed, a talks list, a league); none for mail, posts, termcards. A **future event whose `lastSeenAt` lags its listing's newest sighting by more than 3 days is withdrawn** (moved, renamed or dropped by a listing that is still read) and no public query returns it; a listing nobody reads any more (a feed down, the pipeline paused) withdraws nothing |
| confidence | number | Derived: the lower of `title` and `startsAt` confidence |
| meta | `Record<string, FieldMeta>` | |

An event row is created by its first claims, which must include `title`, `startsAt`, `visibility`, `source`, `externalId` and `sourceUrl`; the pipeline's `claims_for_event` always sends the last four.

**`externalId` per source** (the events stages, `pipeline/.../events/`; source-research §5–§12):

| `source` | `externalId` | Notes |
|---|---|---|
| camdram | `show:<show id>/performance:<run id>/<YYYY-MM-DD>`; `show:<id>/performance:<run id>` for a run over 21 days (one all-day event); `event:<id>/<date>` for a non-show diary event | **Series:** every night of a show shares the `show:<id>/` prefix and the show page as `sourceUrl` |
| talks_cam | talk id | |
| ics, luma, google_calendar, uni_events_api, cucbc (calendar) | the iCalendar `UID`; `<UID>/<original start, UTC>` for an occurrence of a recurring event (all-day: `<UID>/<YYYYMMDD>`) | An override (`RECURRENCE-ID`) keeps its occurrence's id |
| cucbc | `bumps:<lent\|may>:<year>`; `timetable:<academic year>:<term>:<slug(name)>` | Timetable dates are computed from Full Term weeks: `status: tbc`, times `inferred` |
| playwaze | fixture id (`Fixtures/<n>-B`) | |
| su_whatson | `events/<SU org id>/<event id>` or `ents/<id>` | The same id whether What's On or a society profile's own event list (`.soc-event-list`) lists it |
| website | `<org key>:<London date>:<slug(title)>` | A society's own events page: structured data or the bulk model (stage `website_events`) |
| termcard, instagram_api, mailing_list | `<org key>:<London date>:<slug(title)>` (else the list or message as scope) | LLM readings (`extract/events.py`), so a card re-read with the same event updates it |

**One event, several sources** (`pipeline/.../events/duplicates.py`, applied by the load stage to everything it posts). Two staged readings are one event when they have the same visibility, a resolved organiser in common, the same London date and similar titles (one's words contain the other's, or they share half), and — when both are timed — starts at most 30 minutes apart. The higher-evidence reading keeps the event: timed before all-day, a stated start before an inferred one, parser before LLM, primary before secondary evidence, then structured listings first (Camdram, talks.cam, CUCBC, SU What's On, Google / ICS / Luma feeds, Playwaze, then websites, termcards, Instagram, mail). Each other reading is posted as claims on that event's key, with its own source URL, method and quote, but without the identity claims (`source`, `externalId`, `sourceUrl`) — the event keeps its listing and `sweepGroup` — and without a start of a different granularity (an all-day reading adds no midnight start to a timed event). Its organisers are added (`merge`), never replacing the event's set. Readings are compared with a cluster's primary only, so a matinee and an evening of one show stay two events. A `cam_only` reading never merges into a public event, since the strictest visibility would hide it.

**Event images** are our own copy (as logos): a stage that finds an image checks it (raster, ≤ 2 MB) and stages `image: {sourceUrl}`; the load stage uploads the bytes (`/api/pipeline/files`) and posts `{storageId, sourceUrl}`. An image it cannot store is not posted (`pipeline/.../media.py`). The pipeline remembers which bytes the deployment already stores (`var/state/stored-files.json`: sha256 → storageId per deployment, 30 days; forgotten by `purge-dev`), so an unchanged image is posted with its storage id and not uploaded again (`pipeline/.../pipeline/stored_files.py`).

**Indexes:** `by_key`, `by_startsAt`, `by_visibility_startsAt`, `by_visibility_spanEndsAt`, `by_sweepGroup_lastSeenAt`. A title search filters the window's events (every word in the title).

`eventOrganisers` is a join table, `{ eventKey, orgKey, role: organiser|co_host|sponsor, startsAt, spanEndsAt?, visibility }` (the last three denormalised from the event and kept in step), with indexes `by_org_startsAt`, `by_org_spanEndsAt` and `by_event`. It exists for "events of organisation X". The pipeline sends an event's organiser set whole (`replace`), or — when the source names organisers it could not resolve — as `merge`, which adds and never removes.

### venues

| Field | Type |
|---|---|
| key | string |
| name | string |
| aliases | string[] |
| address | string? |
| collegeKey | string? |
| lat / lng | number? |
| meta | `Record<string, FieldMeta>` |

### relationships

Graph edges between organisations.

| Field | Type | Notes |
|---|---|---|
| key | string | `rel-<sha1(from:type:to)>` |
| fromKey / toKey | string | |
| type | vocab `RELATIONSHIP_TYPES` | sponsors, co_hosted, sister_of, affiliated_with, parent_of, member_college, speaker_from, partner_of, venue_host |
| evidence | `{ sourceUrl, eventKey?, note?, seenAt, confidence? }[]` | Newest first, at most 50, de-duplicated by (sourceUrl, eventKey). `confidence` is the rule-based confidence of that one sighting (§1.1), computed by the server |
| firstSeenAt / lastSeenAt | number | |
| confidence | number | The best sighting's confidence + 0.05 per additional independent host, capped at 0.99 |
| visibility | `public \| internal` | Default `internal`. Only `sponsors` and `co_hosted`, only on primary evidence (published by the organisation), may become public; once public it stays public. |

### termDates

| Field | Type |
|---|---|
| academicYear | e.g. "2026-27" |
| term | `michaelmas \| lent \| easter` |
| fullTermStart / fullTermEnd | ISO dates |
| sourceUrl | the official page |

The table is seeded from the University's published Full Term dates (source-research §19) and is used for `termWeekLabel`.

## 3. Pipeline-owned internal tables

These are never returned by public queries.

- **fieldClaims** (append-only)

  | Field | Type |
  |---|---|
  | entityType | `organisation \| event \| team \| session \| venue` |
  | entityKey, field | string |
  | value | any |
  | valueRaw | string? |
  | sourceKey, sourceUrl | string (`sourceKey` = `src-<sha1(sourceUrl)>`) |
  | sourceType | vocab `SOURCE_TYPES` |
  | retrievedAt | number |
  | lastSeenAt | number (bumped, at most daily, when the same observation is posted again) |
  | contentSha256 | string? |
  | method | |
  | extractor | rule id or model id |
  | promptVersion | string? |
  | evidenceQuote | string? |
  | quoteCheck | `exact \| normalised \| absent`? |
  | status, evidence | |
  | confidence | number |
  | reviewStatus | `proposed \| accepted \| rejected \| superseded` |
  | runKey | |
  | fingerprint | sha256 (`claimFingerprint` in lib/keys.ts) |
  | createdAt | number |

  Indexes: `by_entity_field` (entityType, entityKey, field, reviewStatus), `by_entity_review` (entityType, entityKey, reviewStatus), `by_run`, `by_fingerprint`.

  `status`, `confidence` and `fingerprint` are computed by the server; the API refuses a posted `confidence`. The fingerprint is sha256 over entity, field, canonical JSON of the value (or `!status:missingReason` for a negative claim), `sourceUrl` and `method` — not `contentSha256`, which is stored but changes on every fetch of a page with per-request tokens (the SU's `__VIEWSTATE`): re-posting the same reading of the same page is a no-op. Resolution reads only live (`accepted` / `proposed`) claims (index `by_entity_review`).
- **sources**: one row per fetched URL.

  | Field | Type |
  |---|---|
  | key, url, host | string |
  | sourceType | vocab `SOURCE_TYPES` |
  | orgKey | string? |
  | httpStatus | number? |
  | accessNote | string? |
  | contentSha256 | string? |
  | lastFetchedAt | number |
  | yielded | string[] |
  | robotsVerdict | `allowed \| disallowed \| crawl_delay` |
  | robotsCheckedAt | number |

  `SOURCE_TYPES` = su_directory, su_profile, proctors_register, sport_az, sport_club_page, sport_guide_pdf, camdram, talks_list, society_website, linktree, college_list, cucbc, playwaze, uni_events_api, ics_feed, luma, su_whatson, mailing_list_email, instagram_api, termcard, wayback, manual. URLs of `mailing_list_email` and `manual` sources are internal.
- **orgInternal**: one row per organisation.
  - Feed and source identifiers: `suOrgId`, `suSlug`, `proctorsName`, `sportSlug`, `camdramSlug`/`camdramId`, `talksListIds[]`, `icsUrls[]`, `lumaCalendarIds[]`, `googleCalendarIds[]`, `playwaze {communityId?, leagueIds[], teamIds[]}`, `cucbcClub`, `sympaList`, `ticketingUrls[]`, `instagramHandle`, `instagramBusiness` (bool), `instagramUserId`, `websiteDomain`.
  - Patched by `orgKey`; list fields **merge** (several harvesters contribute feeds).
  - Also `seniorTreasurer {name?, department?}`, `legalForm`, `emailHealth {mxOk, lastBounceAt}` and `websiteHealth {lastStatus, checkedAt, platform}`. `websiteHealth.lastStatus` is the home page's HTTP status at `checkedAt`, `0` when the site could not be reached at all (DNS, connection, robots.txt unreachable); `platform` is what the enrichment stage detected (`wordpress`, `wordpress_com`, `wix`, `squarespace`, `webflow`, `google_sites`, `github_pages`, `nextjs`, `sveltekit`, `astro`, `drupal`, `spa`, …).
  - The pipeline's identity resolver reads every organisation with these identifiers back through `POST /api/pipeline/crosswalk` (`ingest/orgInternal.ts` `crosswalk`), so keys stay stable on a machine without its local crosswalk cache.
- **harvestRuns**

  | Field | Type |
  |---|---|
  | runKey | string |
  | mode | |
  | stages | string[] |
  | startedAt / finishedAt | number |
  | status | `running \| success \| partial \| failed` |
  | counts | Record |
  | warnings, failedUrls | string[] |
- **inboundEmails**: forwarded society list mail.

  | Field | Type |
  |---|---|
  | messageId | string |
  | receivedAt | number |
  | from | string |
  | listId, listName | string? |
  | subject | string |
  | text | string |
  | htmlStorageId | Id? |
  | attachments | `{ storageId, filename, contentType }[]` |
  | orgKey | string?, resolved |
  | senderVerified | boolean? — a trusted receiver verified the `From` domain (DKIM / DMARC); only then may the mail be attributed |
  | extraction | `pending \| done \| failed \| skipped` |
  | extractedEventKeys | string[] |
  | extractionNote | string? |

  The inbound webhook (`POST /api/inbound/email`, source-research §16) stores each mail once per `messageId`: `from` is the `From` header as sent, `receivedAt` the `Date` header clamped to now (else the time of receipt), `listId` / `listName` from `List-Id`, the HTML body and kept attachments in storage (`extractionNote` names skipped attachments). The pipeline's `inbox` stage fetches `pending` rows, extracts, posts the events, then marks each row `done` (with `extractedEventKeys` and the resolved `orgKey`), `skipped` (not list mail, or no events) or `failed` (the LLM reply never validated). Raw mail is internal only.
- **listingRequests**: submissions from the public claim / correct / remove / object form.

  | Field | Type |
  |---|---|
  | key | string |
  | orgKey | string? |
  | kind | `claim \| correct \| remove \| object \| add` |
  | submitterEmail | string |
  | role | string? |
  | message | string |
  | fields | Record? |
  | status | `open \| accepted \| rejected \| done` |
  | createdAt | number |
  | resolvedAt | number? |

  Submitted through the public `listingRequests.submit` (validated, length-limited, at most 5 per address per hour; claims, corrections and additions at most 200 an hour overall, removals and objections their own 1,000 an hour so a flood of the others never shuts the GDPR route). The submitter's address is not verified (the broker inbox says so). Accepted corrections become `owner_submitted` claims, never direct edits. Index `by_kind_createdAt` besides those below.
- **signInLinkSends**: `{ emailHash, clientHash?, sentAt }`, indexes `by_emailHash_sentAt`, `by_clientHash_sentAt`, `by_sentAt`. The throttle for the `@cam.ac.uk` sign-in link (`convex/authEmail.ts`): one row per link sent, the address only as a sha256 of its normalised form and the caller's IP only as a sha256, rows pruned after a day. Limits per address, per client and overall; an address that has signed in before is never refused by the overall cap. Not pipeline-owned and never read by a public query.
- **storedFiles**: `{ sha256, storageId, contentType, size, createdAt }`, index `by_sha256`. Our own copies of logos, event images and termcards, uploaded through `/api/pipeline/files` (≤ 2 MB; PNG, JPEG, WebP, GIF, AVIF or PDF, checked against the bytes; never SVG) and de-duplicated by content.

## 4. Broker tables (private)

These live under `convex/broker/*` and every function calls `requireBrokerUser`.

- **people**

  | Field | Type |
  |---|---|
  | key, name, orgKey, role | string |
  | academicYear | e.g. "2026-27" |
  | startDate | string? |
  | staleAfter | ISO date (next handover; default the next 30 June) |
  | stale | boolean (derived daily: `staleAfter` has passed) |
  | sourceUrl | string |
  | seenAt | number |
  | publicLinks | `{ platform, url }[]` |
  | consentBasis | `public_source \| consent \| legitimate_interest` |
  | method | `parser \| llm` rows are pipeline-owned; `manual` rows are never overwritten by the pipeline |
  | notes | string? |
  | archived | boolean |

  A person may also appear in a public listing, but only by role and never by name, unless the organisation itself publishes the name *and* we have consent. That is out of scope for v1, which is why `people` is private.
- **orgBrokerProfiles**: one per organisation.

  | Field | Type |
  |---|---|
  | orgKey | string |
  | needs, offers | `{ item: vocab NEED_OFFER_ITEMS, status: "inferred"\|"confirmed"\|"rejected", evidenceQuote?, sourceUrl?, method?, updatedAt }[]`. The pipeline's inferred list replaces its previous inferred entries; the broker's verdicts (`confirmed`, `rejected`) are never touched, and a rejected item is never re-inferred (a tombstone, hidden in the UI) |
  | optIns | `{ openToSponsors?, openToCollaborations?, careersEvents? }` (unknown until phase 2) |
  | pecrSubscriberType | `individual \| corporate \| unknown` |
  | suppressed | boolean |
  | ethicsFlags | string[] |
  | sponsorNotes | string? |
  | pastSponsorKeys | string[], mirrors `relationships` |
  | notes | string? |

  `NEED_OFFER_ITEMS` = sponsorship, speakers, co_hosting, venue, members, volunteers, media_coverage, funding, mentoring, expertise, equipment, careers_access.
- **interactions**

  | Field | Type |
  |---|---|
  | key | string |
  | date | number |
  | orgKey, personKey | string? |
  | channel | `email \| meeting \| call \| message \| event \| other` |
  | summary | string |
  | nextStep | string? |
  | followUpOn | ISO date? |
- **introductions**

  | Field | Type |
  |---|---|
  | key | string |
  | partyA, partyB | `{ orgKey?, personKey? }` |
  | reason | string |
  | date | number |
  | status | `idea \| proposed \| sent \| accepted \| met \| declined \| stale` |
  | outcome | string? |

## 5. Taxonomy: CATEGORIES (our own; the SU's 7 are mapped onto these)

| Key | Label | SU mapping (non-exclusive) |
|---|---|---|
| academic | Academic & Subject | Academic Life |
| science_tech | Science, Tech & Engineering | Academic Life / Skills |
| careers_professional | Careers & Professional | Skills & Professional Development |
| entrepreneurship | Entrepreneurship & Innovation | Skills & Professional Development |
| arts_creative | Arts, Design & Creative Writing | Creative & Media |
| music | Music | Creative & Media |
| theatre_film_dance | Theatre, Film & Dance | Creative & Media |
| media_publishing | Media & Publishing | Creative & Media |
| cultural_international | Cultural & International | Cultural & Faith |
| faith | Faith & Belief | Cultural & Faith |
| politics_debate | Politics, Debate & Law | Political & Causes |
| causes_volunteering | Campaigns, Charity & Volunteering | Political & Causes |
| identity_wellbeing | Identity, Community & Wellbeing | Cultural & Faith / Hobbies |
| sport | Sport & Fitness | Sports & Activities |
| outdoors | Outdoors & Adventure | Sports & Activities |
| hobbies_games | Hobbies, Games & Food | Hobbies & Interests |

Assignment: the LLM assigns 1–3 categories, using the SU category as a hint plus the description. A deterministic rule assigns `sport` to sportsService-registered clubs.

## 6. Derived fields

These are computed in Convex by `convex/derive.ts`, which runs on ingest and from a daily cron.

- **status**
  - `archived` if the organisation is marked `defunct`.
  - `active` if `lastActiveAt` falls within 180 days, or if the organisation is on any register for the current academic year (`registrations.*.registered` with `year` equal to it, or with no `year` but reported by a claim retrieved in it).
  - `dormant` if the last activity was more than 180 days ago and there is no current registration.
  - Otherwise `unknown`.
  - Academic years turn over on **1 July** (London), e.g. `2026-27` runs 1 Jul 2026 – 30 Jun 2027.
- **lastActiveAt**: see §2.
- **missingFields**: the *tracked* fields (the ones worth asking a society about: description, contacts, socials, membership, categories, sport basics, …; `tracked` in fields.ts) whose status is `missing`. Empty for counterparts.
- **searchText**: name, aliases, short name, short description, tags and category labels, lowercased.
- **emailType**: from `email` (§2).
- **termWeekLabel**: `MT26 Wk 3` / `LT27 Wk 1` / `ET27 Wk 1`; Week 1 starts on the first Thursday of Full Term, Week 0 is the week before; none outside Week 0 … the last day of Full Term (the last week ends with Full Term, source-research §19).
- **event confidence / lastSeenAt**: §2.
- **staleAfter** for people, which defaults to the next 30 June; **stale** turns on once it has passed.

## 7. Public projections

Implemented in `webapp/convex/lib/projections.ts`; the projections are the `returns` validators of the public queries, so nothing else can leave.

- **Hidden organisations** (`hidden: true`) are absent from every public query: no card, `getBySlug` null, dropped from event organisers and relationship counterparts; an event whose every organiser and co-host is hidden is not shown, and `events.list` with a hidden organisation's key lists nothing.
- **orgPublic** removes `orgInternal`, the broker data, `searchText`, and any `meta.sourceUrl` (and conflict reading) from an internal source (`mailing_list_email`, `manual`) or that is not `http(s)`, and keeps the rest. A `conflicting` field whose other readings are all removed shows its winner's own status (`winnerStatus`), never a promotion to `found`. A `personal_crsid` email is removed (its meta reads `missing` / `not_published`), personal role emails are dropped, and the mailing list shows only `platform` and `signupUrl`. Stored logos become URLs.
- **eventPublic** is `visibility === "public"`; `cam_only` needs a verified `@cam.ac.uk` session (or the broker); `members_only` is never shown. A mailing-list event has no `sourceUrl`. Organisers are resolved to `{key, slug, name, role}`.
- **relationships**: only `visibility === "public"` edges, with the counterpart's name and the `http(s)` evidence URLs.
- **Counts and times, not rows.** Two public queries read past the gate but return only a number: `events.restrictedCount` (how many `cam_only` events the viewer cannot see, for the sign-in prompt — deliberately coarse: text, type, category and college filters are ignored and the window is widened to whole London weeks, at least four with an organisation, so the count cannot spell out titles or bisect start times) and `runs.lastHarvest` (the finish time of the last run that wrote data; nothing else from `harvestRuns`).
