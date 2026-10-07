# Source research

Code cites the sections here as `§N`. All facts below were checked on **2026-10-07** unless stated otherwise. The full evidence, with URLs, is in `research/2026-10-07-landscape-brief.md` (abbreviated LB below).

**Rule:** before a harvester for a source is written or changed, its section here is re-verified live. Record the robots.txt verdict (quoted, with date), the terms, the rate limit, the fields it yields and the traps.

## Global rules

- **User-Agent:** `camsocs-bot/0.1 (+https://camsocs.vercel.app/about)`. It contains no personal email.
- **robots.txt:** checked per host, with our User-Agent, before the first fetch of each run. `Crawl-delay` is honoured.
- **Requests:** one at a time per host, at least 1 s apart.
- **Never decoded:** obfuscated emails (Cloudflare email protection, script-hidden addresses).
- **Never fetched:** Raven-gated, members-only or 403 pages.
- **Instagram, Facebook, LinkedIn:** store the link only. They are fetched only through the official Meta Business Discovery API (§17).
- **talks.cam and tbc.xyz:** their robots.txt blocks AI agents by name. talks.cam's content is therefore parsed deterministically and **never passed to the LLM**. tbc.xyz is not used.
- **Raw caches** go under `var/cache/` and are never committed.

## §1 Cambridge SU "Find a Society"

**Location and size**
- Directory: `https://www.cambridgesu.co.uk/opportunities/societies/`. It is one server-rendered page listing 590 entries.
- Profiles: `/organisation/{id or slug}/` (144 of the 590 directory links use a slug).
- Platform: MSL.

**Fields**
- From the directory (`li[data-msl-grouping-id]`, each preceded by its `li.msl-gl-logo`):
  - name;
  - logo;
  - one of 7 categories (`dd.msl-gl-attribute`; one entry reads "Not categorised");
  - a stable `data-msl-grouping-id`, the society's id. (`data-msl-organisation-id` is the SU's own id, 6021, on every entry.)
- From the profile:
  - email (`a.socemail`, a `mailto:`);
  - Instagram, Facebook and X icons (`a.msl-icon` with `socinstagram`, `socfacebook`, `soctwitter`);
  - short description (`.grp-shrt-desc`, at most 200 characters) and long description (`.grp-lng-desc`, HTML);
  - website (`a.msl_web`);
  - resources (`.msl-resourcelist`, links to `/file/<org>/<name>/`), sometimes a termcard.

**robots.txt** (fetched 2026-10-07 with our User-Agent; no `Crawl-delay`)
- The `User-agent: *` group disallows `/photos/ /advertclick/ /login/ /pagestylesheet/ /stylesheet/ /skins/ /resourcehandler/ /edit/ /search/ /asset/ /account/ /Shibboleth.sso /sso/`.
- `/organisation/`, `/opportunities/` and `/file/` are allowed.
- **Every logo lives under `/asset/Organisation/<id>/…`.** Logos are therefore never downloaded, and never hotlinked: `logo` is recorded as `missing` / `access_restricted`.

**Terms and decision**
- Societies consented to publication by the SU. No reuse licence was found.
- **Decision 2026-10-07:** scrape the full profiles (Joshua's choice).

**Harvester** (`sources/su.py`, stage `su_directory`; re-verified live on 2026-10-07)
- One request per profile, at least 1 s apart. A profile fetched within the last 20 hours is served from the cache.
- Measured on the full crawl of 590 profiles:

  | Channel | Profiles |
  |---|---|
  | Email | 424 (71.9%) |
  | Instagram | 514 (87.1%) |
  | Facebook | 338 (57.3%) |
  | X | 96 (16.3%) |
  | Website | 350 (59.3%). Linktree, LinkedIn and Facebook URLs typed into the website slot count as socials. |
  | Short description | 372 (63.1%) |
  | Long description | 494 (83.7%) |

- Email kinds: `@cambridgesu.co.uk` 137, webmail 118, own domain 82, legacy `@cusu` 50, SRCF 16, personal CRSid 11 (withheld), college domain 6, `lists.cam.ac.uk` 4.
- Logo file names record the form the logo was uploaded with, and when. Example: "Society Handover Form 2026-27__Logo__<n>_2026-08-14-16-09__…".
  - Counts: 390 for 2026-27, 63 for 2025-26, 1 for 2024-25.
  - New registrations read "New Society_ Register Here (2025-2026)".
  - `registrations.su.year` is claimed only when that year is the current academic year. An older form's logo was simply never replaced, and the listing itself shows current registration.
  - The upload stamp is claimed as an `inferred` `lastActiveAt`.

**Traps**
- 390 of the 590 logos are named "Society Handover Form 2026-27".
- 50 entries still use legacy `@cusu` emails.
- Some content is stale and dates from 2020, termcards especially ("Michaelmas 2020 Term Card"). A termcard titled for an earlier academic year is ignored; an undated one is claimed as `inferred`.
- 37% of entries have no short description and 17% have no long description.
- **The Join widget is login-gated on every profile** ("Please log in to join this organisation."). No join information is public, and the login page is never fetched: `joinUrl` is `missing` / `access_restricted`.
- **An MSL mailing-list widget** (`mailinglist_chkLists`, 4 profiles) lists internal SU voter groups, with the name of the person who created each one. It is never read.
- Descriptions contain:
  - personal CRSid addresses (withheld, replaced by a marker);
  - chat invite links (withheld);
  - sometimes officers' first names, which no rule can detect.
- A few profiles embed the SU's own event list (`.soc-event-list`, dates without a year). Those events belong to the SU What's On harvester (§12), not here.
- Some description links are wrapped in Outlook SafeLinks. They are unwrapped from their own query string, never followed.
- A test entry ("Test Soc") is listed like any society.

## §2 Proctors' register

**Location and size**
- `https://www.proctors.cam.ac.uk/clubsandsocs/registered-societies`
- 303 entries, as static Drupal HTML (`li[data-list-item-id]` inside the page's prose block).

**Fields**
- Name plus at most one link.
- No email, category or description.
- Names are written in sorted form: "African Caribbean Society (CU)", "Building Bridges … Society (The)", "AI in Law Society (CU, CUAILS)". The harvester (`sources/proctors.py`, stage `proctors_register`):
  - moves the qualifiers to the front ("Cambridge University African Caribbean Society");
  - keeps the name as published as `value_raw` and `proctors_name`;
  - passes acronyms to the resolver as aliases.
- Links on 2026-10-07:

  | Kind | Entries |
  |---|---|
  | Own website | 106 |
  | Social (Facebook, Instagram, LinkedIn, Linktree, WeChat) | 105 |
  | SU profile | 44 |
  | SRCF | 40 |
  | cam.ac.uk page | 5 |
  | None | 3 |

- Two entries carry a second, stray anchor. Only the first is the entry's link.

**robots.txt** (fetched 2026-10-07): standard Drupal rules only (`Disallow: /core/ /profiles/ /admin/ /search/ /user/…`). The register page is allowed. There is no `Crawl-delay`.

**Registration window and terms**
- Registration runs 1 Jul to 31 Dec, and the list size swings during that window.
- The register states no year. `registrations.proctors` is therefore claimed without one, and its retrieval date places it in the academic year.
- The register is primary evidence for the registration itself. For names and links it is a third party (`secondary`), so a society's own SU profile outranks it.
- The cam.ac.uk site terms forbid commercial use without a licence. This project is non-commercial.

## §3 Sport Cambridge A–Z and club pages

**Location and size**
- `https://www.sport.cam.ac.uk/student-sport/university-sports-clubs`
- It has 77 links, about 72–75 clubs.
- Each link redirects to `/university-sports-clubs-0/<slug>`.

**Fields**
- Free-text description.
- One Instagram link (on 71 of 74 pages).
- The generic `support@sport.cam.ac.uk` address.

**Traps**
- Some pages carry the typo `support@sport.ac.uk`.
- Some links go to a `pantheonsite.io` host.

## §4 Sports Club Guide 2026-27 (PDF)

**Location:** `https://live-cambridge-sports-cwp.pantheonsite.io/sites/default/files/UoC%20Sports%20Club%20Guide%2026-27_web.pdf`. It has 36 pages and was created 16 Sep 2026.

**Fields per club**
- Description.
- Website.
- Instagram and Facebook links.
- Contact email: there are 74 contact lines. 23 are `@sport.cam.ac.uk` aliases, 19 are Gmail, and one is misspelt `gmail.comm`.
- The "At a glance" table:
  - open to;
  - caters for (Beginner / Intermediate / Elite);
  - Blue / Half Blue;
  - college competition.
- Venues.

**Trap:** the ticks in the "At a glance" table cannot be read reliably from the PDF's text layer. Render the page to an image and use LLM vision on it, with an evidence check.

## §5 Camdram

**Endpoints**
- API: `https://www.camdram.net/api`.
- `societies.json` (97 entries).
- `diary.json` and `diary.ics`.
- `/societies/{slug}/diary.ics`.
- `/venues/{slug}/diary.json`.
- `events.json` and `vacancies.json`.
- Show JSON includes `societies[]` (shows are often co-funded) and `performances[]`.

**robots.txt and terms**
- robots.txt allows everything.
- The privacy policy says the data is public for reuse.
- An API key is recommended. Without one, the rate limits are "very low".

**Trap:** society descriptions often contain committee role emails. Extract them as role emails, never as named people.

## §6 talks.cam

**Endpoints**
- `https://talks.cam.ac.uk/show/{xml,rss,ics}/{LISTID}`, with the parameters `limit`, `seconds_before_today`, `seconds_after_today`, `start_time`, `end_time` and `term=current`.
- A single talk is at `/talk/vcal/{ID}/`.

**robots.txt:** `Disallow: /` for ClaudeBot, GPTBot, CCBot and others, and `Crawl-delay: 10` for everyone else.

**Rules for us**
- Parse deterministically only. The LLM is never used on this content.
- Wait 10 s between requests.

**Traps**
- List IDs change.
- Of 18 society lists checked, only 5 had talks in the last 12 months.

## §7 CUCBC

**Endpoints**
- `https://www.cucbc.org/clubs` lists 31 college clubs plus CUBC, CUCBC, Addenbrooke's, ARU, Theological Colleges and Vet School.
- iCal: `/calendar/ical/{YYYY-MM}`.
- RSS: `/rss.xml`.

**robots.txt:** `Crawl-delay: 10`.

## §8 Colleges and JCR/MCR

**Seed**
- The 31 colleges come from `https://www.cam.ac.uk/colleges-and-departments/college-a-z`.
- The college-tier lists, one per college, are in LB §1.6.
- v1 harvests only the JCR/MCR bodies themselves (name, website, role contacts, socials). Their society lists are harvested in phase 2.

**Platforms:** about 15 different site templates. See LB §2.1.

**Blocked or members-only:**
- The Caius JCR site blocks all crawlers in robots.txt.
- The Homerton list and the Lucy Cavendish list are members-only.
- Peterhouse returned 403.
- The Wolfson live site resets the connection. The archive copy is dated 2025-08-13.

**Do not decode:** Queens' JCR emails (Cloudflare email protection) and Wolfson WCSA emails (hidden by a script).

## §9 Playwaze (college leagues and BUCS)

**Endpoints**
- `https://cambridgeuniversityleagues.playwaze.com/Home`.
- Public embeds: `public-cambridgeuniversityleagues.playwaze.com/{community}/{id}/league-display/Leagues/{leagueId}?embed=true`.

**Format:** HTML parsing only. There is no documented API.

**Trap:** the IDs roll over each season. On 2026-10-07 the 2026-27 IDs were not yet live.

## §10 University Events API

**Endpoint:** `https://webservices.admin.cam.ac.uk/events/api/programmes/11/calendar/events.json` (also `.rss` and `.ics`). It returned 745 events.

**Use:** context for internal partners. It is not specific to societies.

## §11 Calendar feeds that societies publish

**Feed patterns**
- Google Calendar: `…/calendar/ical/{id}/public/basic.ics`.
- Luma: `https://api.lu.ma/ics/get?entity=calendar&id=…`.
- Luma event pages also carry schema.org Event JSON-LD.

**Discovery:** feeds are found on society websites, Linktree pages and SU profiles.

**Trap:** timezones are often wrong. One feed was set to Asia/Dhaka. Normalise to Europe/London.

## §12 SU What's On

**Endpoints**
- `https://www.cambridgesu.co.uk/whatson/`, with the markup classes `msl_event_name` and `msl_event_organisation`.
- RSS: `/ents/rss/0/subtree/`.

**Coverage is low:** only about 6 of 61 events came from student groups.

## §13 Linktree

`linktr.ee/<handle>` is server-rendered, and its links sit in `__NEXT_DATA__` JSON. Respect its robots.txt.

## §14 Society websites

- Fetch politely.
- Extract JSON-LD and microdata first, then hand the cleaned text to the LLM.
- About 15 of the 53 sites probed run WordPress. None exposes the Tribe events API, and at least 9 are on Wix.

## §15 Ticketing

- Fixr returns 403 to scripts and has no public API, so we store links only.
- The Luma public API needs Luma Plus.
- The Eventbrite search API is dead.
- Dice offers a partner-only API.
- Store organiser URLs as feeds only.

## §16 Mailing-list inbox

**Flow:** Joshua's @cam.ac.uk Outlook rule forwards mail that carries a `List-Id` header to an inbound webhook, which posts to the Convex HTTP route `/api/inbound/email` (shared secret). Mail lands in `inboundEmails`, and the pipeline extracts events from it.

**Visibility:** events from mail default to `cam_only`.

**Fact:** external forwarding is possible from Cambridge Exchange Online (Engineering IT help: https://help.eng.cam.ac.uk/email/forwarding-your-email/).

## §17 Meta Instagram Business Discovery

**Access**
- It needs Joshua's own Instagram professional account, linked to a Facebook Page, a developer app and a long-lived token.
- It covers professional (business or creator) target accounts only.

**Data:** media captions, timestamps and media URLs. Images are downloaded and stored, never hotlinked, because SocTrackr's hotlinked CDN URLs expired within days.

**Also:** the Basic Display API has been dead since 4 Dec 2024.

## §18 SocTrackr (reference only)

- `https://www.soctrackr.com/api/get-all-sources` lists 155 Instagram handles.
- The repo has no licence, so we do **not** reuse its data without the author's permission. We may use it as a sanity check of coverage.

## §19 University Full Term dates

**Source:** `https://www.cam.ac.uk/about-the-university/term-dates-and-calendars` (the University's official term-dates page). Checked **2026-10-07**; the page states each date verbatim, e.g. "Full Term starts: Tuesday 6 October 2026". Cross-checked the same day against the University-domain search index (`cam.ac.uk` results quoting the same dates).

| Academic year | Term | Full Term starts | Full Term ends |
|---|---|---|---|
| 2026-27 | Michaelmas | Tue 6 Oct 2026 | Fri 4 Dec 2026 |
| 2026-27 | Lent | Tue 19 Jan 2027 | Fri 19 Mar 2027 |
| 2026-27 | Easter | Tue 27 Apr 2027 | Fri 18 Jun 2027 |
| 2027-28 | Michaelmas | Tue 5 Oct 2027 | Fri 3 Dec 2027 |
| 2027-28 | Lent | Tue 18 Jan 2028 | Fri 17 Mar 2028 |
| 2027-28 | Easter | Tue 25 Apr 2028 | Fri 16 Jun 2028 |

**Use:** seeded by the pipeline stage `term_dates` (`pipeline/src/camsocs_pipeline/seeds/term_dates.py`) into `termDates`, and used for events' `termWeekLabel`.

**Week convention (for labels):** Full Term starts on a Tuesday; a student "week" runs Thursday to Wednesday, so Week 1 begins on the first Thursday of Full Term and Week 0 is the week before (as Camdram and CUCBC label weeks, LB §3). Labels run from Week 0 to the week holding the last day of Full Term (Michaelmas 2026: Week 9 = Thu 3 – Fri 4 Dec).

**Rule:** add a year only after reading it on the official page; never extrapolate.
