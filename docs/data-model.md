# camsocs data model

This file is the contract for the Convex schema (`webapp/convex/schema.ts`), the pipeline's wire models (`pipeline/src/camsocs_pipeline/models/`) and the UI. Any change goes here first, then into code.

Decisions behind it: see PLAN.md §6 (Decisions log). Field research: `docs/research/2026-10-07-landscape-brief.md` §8.

## 0. Rules

1. **Keys.** Every entity has a minted string `key`, such as `org-cu-german-society`, `evt-<sha1(source:externalId)>` or `ven-west-road-concert-hall`. `v.id` is never used across tables or in the wire format.
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
  retrievedAt?: number,
  method?: "parser" | "llm" | "manual" | "owner_submitted",
  claimCount?: number,                          // how many independent sources agree
}
```

### 1.1 Confidence (by rule, not by asking the LLM)

| Method / evidence | Base confidence |
|---|---|
| parser on a primary source | 0.95 |
| parser on a secondary source | 0.85 |
| llm + verbatim quote check EXACT or NORMALISED, primary | 0.85 |
| llm + verbatim quote check, secondary | 0.75 |
| llm without a verifiable quote, i.e. `inferred` | 0.50 |
| owner_submitted / manual | 1.00 |

- Add 0.05 for each additional agreeing independent source, capped at 0.99.
- A value that disagrees with an equal-rank claim makes the status `conflicting`. Both readings stay in `fieldClaims`, and the UI shows both.

### 1.2 Precedence when resolving

1. `owner_submitted` / `manual`.
2. `found` + primary.
3. `found` + secondary.
4. `inferred`.

Ties go to the most recent `retrievedAt`. Claims with `reviewStatus: "rejected"` are ignored.

## 2. Pipeline-owned public tables

### organisations

One row per group. This covers societies, clubs, JCRs/MCRs and boat clubs, and also counterpart organisations (colleges, departments, University offices, companies, NGOs, public bodies, other universities' societies).

| Field | Type | Notes |
|---|---|---|
| key, slug | string | `org-<slug>`. Slugs are unique. |
| name | string | Canonical display name |
| aliases | string[] | e.g. "CU German Society", "German Soc", "CUGS" |
| shortName | string? | Acronym |
| orgType | vocab `ORG_TYPES` | society, sports_club, college_club, jcr, mcr, college_boat_club, college, department, uni_office, student_union, company, ngo, public_body, other_university_society, media, theatre_company, other |
| level | vocab `ORG_LEVELS` | university, college, department, intercollegiate, external |
| collegeKeys | string[] | For college-level groups: the college(s), many-to-many (shared clubs) |
| collegeBody | `jcr \| mcr \| college_run \| joint`? | For college-level groups |
| parentKey | string? | Hierarchy, e.g. a team club inside a University club, or a JCR within its college |
| isCounterpart | boolean | true for external or institutional parties that exist only because they are linked to a society |
| status | `active \| dormant \| archived \| unknown` | Derived (§6) |
| lastActiveAt | number? | Latest dated activity: an event, a post or a page update |
| registrations | object | `{ su?, proctors?, sportsService?, camdram?, cucbc? }`, each `{ registered: boolean, year?: string, sourceUrl?: string }`. These lapse independently. |
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
| membership | `{ tiers: { label, pricePence?, period: "life"\|"year"\|"term"\|"one_off"\|"free", note? }[], bursaryNote?, collegeReimbursable?: boolean }`? | |
| beginnerFriendly | boolean? | |
| trials | `{ required: boolean, dates?: string[], note? }`? | Trials or auditions |
| timeCommitment | string? | Free text, e.g. "2 trainings/week + Wed matches" |
| termcardUrl | string? | |
| accessibilityNote | string? | |
| sport | object? | `{ sport, blueStatus?: "full"\|"full_some"\|"discretionary_full"\|"half"\|"none", varsity?: boolean, bucs?: boolean, collegeCompetition?: boolean, genderCategories: ("men"\|"women"\|"open"\|"mixed")[], kitCostNote?, venues?: string[] }` |
| website | string? | Final URL after redirects |
| email | string? | General contact address, published by the organisation or a register |
| emailType | vocab? `EMAIL_TYPES` | role_own_domain, cambridgesu, srcf, lists_cam, college_domain, webmail, personal_crsid, legacy_cusu |
| roleEmails | `{ role: vocab ROLES, email }[]` | president, secretary, treasurer, sponsorship, events, publicity, welfare, captain, other. Only addresses the organisation publishes. |
| contactFormUrl | string? | |
| mailingList | `{ platform?: "sympa"\|"mailchimp"\|"google_group"\|"other", address?, signupUrl? }`? | Public shows the sign-up only |
| socials | `{ platform: vocab SOCIAL_PLATFORMS, url, handle? }[]` | instagram, facebook_page, facebook_group, x, linkedin, tiktok, youtube, linktree, website_blog, wechat, threads, bluesky |
| chatChannels | `{ platform: "whatsapp"\|"discord"\|"telegram"\|"slack"\|"groupme", howToJoin?: string }[]` | Never store invite URLs |
| searchText | string | Derived: name, aliases, short description, tags and categories. Has a search index. |
| meta | `Record<string, FieldMeta>` | One entry per resolvable field above |
| missingFields | string[] | Derived: fields whose status is `missing`. Drives the phase-2 outreach. |
| createdAt, updatedAt | number | Stamped by mutations |

**Indexes:** `by_key`, `by_slug`, `by_level_status`, `by_orgType`, `by_isCounterpart`, plus a search index `search_text` on `searchText` with filter fields level, status and orgType.

### teams

Child rows of a sports club.

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

Regular activities: trainings, weekly meetings, services.

| Field | Type | Notes |
|---|---|---|
| key | string | |
| orgKey | string | |
| title | string | |
| dayOfWeek | 0..6 | |
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
| allDay | boolean | |
| termWeekLabel | string? | e.g. "MT26 Wk 3" (derived from `termDates`) |
| venueKey / venueText | string? | |
| organiserKeys, coHostKeys, sponsorKeys | string[] | Organisation keys. Sponsors and co-hosts also create `relationships` edges. |
| speakers | `{ name, affiliation? }[]` | Only as published |
| price | `{ free: boolean, minPence?, maxPence?, text? }`? | |
| bookingUrl | string? | |
| signupRequired | boolean? | |
| visibility | `public \| cam_only \| members_only` | Mailing-list-derived events default to `cam_only`. `members_only` is never shown publicly. |
| eventType | vocab `EVENT_TYPES` | talk, social, performance, competition, match, workshop, trip, formal, careers, meeting, training, worship, fair, other |
| image | `{ storageId?, sourceUrl? }`? | Our own stored copy |
| cancelled | boolean | |
| status | `confirmed \| tbc` | |
| source | vocab `EVENT_SOURCES` | camdram, talks_cam, ics, luma, google_calendar, playwaze, uni_events_api, cucbc, su_whatson, mailing_list, instagram_api, termcard, website, manual |
| externalId | string | |
| sourceUrl | string | |
| lastSeenAt | number | |
| confidence | number | |
| meta | `Record<string, FieldMeta>` | |

**Indexes:** `by_key`, `by_startsAt`, `by_visibility_startsAt`, plus a search index on title.

`eventOrganisers` is a join table, `{ eventKey, orgKey, role: organiser|co_host|sponsor }`, with indexes `by_org_startsAt` and `by_event`. It exists for "events of organisation X".

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
| evidence | `{ sourceUrl, eventKey?, note?, seenAt }[]` | |
| firstSeenAt / lastSeenAt | number | |
| confidence | number | |
| visibility | `public \| internal` | Default `internal`. `sponsors` and `co_hosted` may be public when published by the organisation. |

### termDates

| Field | Type |
|---|---|
| academicYear | e.g. "2026-27" |
| term | `michaelmas \| lent \| easter` |
| fullTermStart / fullTermEnd | ISO dates |

The table is seeded from the University's published Full Term dates and is used for `termWeekLabel`.

## 3. Pipeline-owned internal tables

These are never returned by public queries.

- **fieldClaims** (append-only)

  | Field | Type |
  |---|---|
  | entityType | `organisation \| event \| team \| session \| venue` |
  | entityKey, field | string |
  | value | any |
  | valueRaw | string? |
  | sourceKey, sourceUrl | string |
  | retrievedAt | number |
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
  | createdAt | number |

  Indexes: `by_entity_field`, `by_run`.
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

  `SOURCE_TYPES` = su_directory, su_profile, proctors_register, sport_az, sport_club_page, sport_guide_pdf, camdram, talks_list, society_website, linktree, college_list, cucbc, playwaze, uni_events_api, ics_feed, luma, su_whatson, mailing_list_email, instagram_api, termcard, wayback.
- **orgInternal**: one row per organisation.
  - Feed and source identifiers: `suOrgId`, `suSlug`, `proctorsName`, `sportSlug`, `camdramSlug`/`camdramId`, `talksListIds[]`, `icsUrls[]`, `lumaCalendarIds[]`, `googleCalendarIds[]`, `playwaze` IDs, `cucbcClub`, `sympaList`, `ticketingUrls[]`, `instagramBusiness` (bool), `instagramUserId`.
  - Also `seniorTreasurer {name?, department?}`, `legalForm`, `emailHealth {mxOk, lastBounceAt}` and `websiteHealth {lastStatus, checkedAt, platform}`.
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
  | extraction | `pending \| done \| failed \| skipped` |
  | extractedEventKeys | string[] |

  The pipeline fetches `pending` rows, extracts, and posts events. Raw mail is internal only.
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

## 4. Broker tables (private)

These live under `convex/broker/*` and every function calls `requireBrokerUser`.

- **people**

  | Field | Type |
  |---|---|
  | key, name, orgKey, role | string |
  | academicYear | e.g. "2026-27" |
  | startDate | string? |
  | staleAfter | ISO date (next handover) |
  | sourceUrl | string |
  | seenAt | number |
  | publicLinks | `{ platform, url }[]` |
  | consentBasis | `public_source \| consent \| legitimate_interest` |
  | notes | string? |
  | archived | boolean |

  A person may also appear in a public listing, but only by role and never by name, unless the organisation itself publishes the name *and* we have consent. That is out of scope for v1, which is why `people` is private.
- **orgBrokerProfiles**: one per organisation.

  | Field | Type |
  |---|---|
  | orgKey | string |
  | needs, offers | `{ item: vocab NEED_OFFER_ITEMS, status: "inferred"\|"confirmed", evidenceQuote?, sourceUrl?, updatedAt }[]` |
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
  - `active` if `lastActiveAt` falls within 180 days, or if the organisation was registered in the current academic year.
  - `dormant` if the last activity was more than 180 days ago and there is no current registration.
  - `archived` if the organisation is marked defunct.
  - Otherwise `unknown`.
- **missingFields**, **searchText**, **termWeekLabel**.
- **staleAfter** for people, which defaults to the next 30 June.

## 7. Public projections

- **orgPublic** removes `orgInternal`, the broker data and any `meta.sourceUrl` pointing to an internal source (`mailing_list_email`), and keeps the rest. Contacts are shown only if `emailType !== "personal_crsid"`.
- **eventPublic** is `visibility === "public"` only. `cam_only` needs a verified `@cam.ac.uk` session, and `members_only` is never shown.
