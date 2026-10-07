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
- Profiles: `/organisation/{id or slug}/`.
- Platform: MSL.

**Fields**
- From the directory:
  - name;
  - logo;
  - one of 7 categories;
  - a stable `data-msl-grouping-id`.
- From the profile:
  - email;
  - Instagram, Facebook and X icons;
  - short and long description;
  - website;
  - resources (sometimes a termcard).

**robots.txt**
- Blocks `/search/ /asset/ /photos/ /login/ /account/`.
- Allows `/organisation/` and `/opportunities/`.

**Terms and decision**
- Societies consented to publication by the SU. No reuse licence was found.
- **Decision 2026-10-07:** scrape the full profiles (Joshua's choice).

**Traps**
- 390 of the 590 logos are named "Society Handover Form 2026-27".
- 50 entries still use legacy `@cusu` emails.
- Some content is stale and dates from 2020.
- 37% of entries have no short description and 17% have no long description.

## §2 Proctors' register

**Location and size**
- `https://www.proctors.cam.ac.uk/clubsandsocs/registered-societies`
- 303 entries, as static Drupal HTML.

**Fields**
- Name plus at most one link.
- No email, category or description.

**Registration window and terms**
- Registration runs 1 Jul to 31 Dec, and the list size swings during that window.
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

**Events harvester (T6, re-verified 2026-10-07)** — `pipeline/src/camsocs_pipeline/events/camdram.py`, stage `camdram_events`.
- robots.txt: `User-agent: *` with nothing disallowed.
- The API page (`/api/`) asks for an API key; unauthenticated calls get "very low rate limits and long response delays". `CAMDRAM_API_KEY` (optional, an OAuth access token) is sent as a Bearer header; without it requests are 2 s apart and show JSON is reused from the cache for 20 h.
- `diary.json?end=YYYY-MM-DD`: the diary starts at the current week's Sunday (default 8 weeks; `end` from `DiaryController`). On 2026-10-07 it held 79 performance runs of 63 shows plus 1 society event (`_type: event`, with `societies[]` and `dates[]`).
- A diary performance is a run: `start_at` (an instant) daily until `repeat_until` (a date) at the same London wall time. One event per night, external id `show:<show id>/performance:<run id>/<date>`; runs over 21 days (a film listed May–December) are one all-day event.
- Show JSON (`/shows/<slug>.json`): `societies[]` (+ `societies_display_list` order), `description` (markdown), `online_booking_url`, `image.filename` → `/media/cache/preview/<filename>` (the page's `og:image`). Some shows have no societies and `other_venue: "N/A"`.
- `/venues.json` returns all 29 venues with address and coordinates in one request.

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

**Events harvester (T6, re-verified 2026-10-07)** — `events/talks_cam.py`, stage `talks_cam`.
- robots.txt (read with our User-Agent): `Disallow: /` for GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, anthropic-ai, CCBot, Google-Extended and others; for `*`: `Crawl-delay: 10` and disallows only `/show/archive/`, edit/login paths, `/include/`, `/subscriptions/`, `/custom_views/`. `/show/xml/` is allowed for us.
- The XML's shape was checked by element names only (no text was read): `list/{id,name,details,url}` and `talk/{id,title,abstract,speaker,speaker_url,venue,special_message,organiser,url,start_time,end_time,series,created_at,updated_at}`; times are RFC 2822 with an offset. `organiser` is a person's name and is never used.
- Lists come from `orgInternal.talksListIds` plus a verified seed (`events/seeds.py`): CUAS → `201664`, linked from https://cuastronomy.co.uk/talks/ ("Cambridge Talks page"; an older `16901` is commented out in that page's source).
- A talk whose `series` is another list is left out (society lists include department series).

## §7 CUCBC

**Endpoints**
- `https://www.cucbc.org/clubs` lists 31 college clubs plus CUBC, CUCBC, Addenbrooke's, ARU, Theological Colleges and Vet School.
- iCal: `/calendar/ical/{YYYY-MM}`.
- RSS: `/rss.xml`.

**robots.txt:** `Crawl-delay: 10`.

**Events harvester (T6, re-verified 2026-10-07)** — `events/cucbc.py`, stage `cucbc_events`.
- robots.txt: `Crawl-delay: 10`; disallows Drupal internals only (`/admin/`, `/user/…`, `/search/`, `/node/add/`, …).
- `/calendar/ical/YYYY-MM` answers a valid but **empty** VCALENDAR for every month checked (2025-11, 2026-03, 2026-10, 2026-11), Bumps months included. Still read, month by month.
- `/bumps` states the dates in one sentence: "The Lent Bumps 2026 will take place from Tuesday 3rd March to Saturday 7th March 2026. The May Bumps 2026 … from Wednesday 17th June to Saturday 20th June 2026." (both past on 2026-10-07; 2026-27 dates not yet posted).
- `/college_events/timetable` is the fixed calendar (CUCBC, 2000) in Full Term weeks: e.g. Emmanuel Sprint Regatta "7th Sunday", Fairbairn Cup Novices/Seniors "(Jesus)" "9th Thursday"/"9th Friday", Lent Bumps "6th/7th Tuesday – 7th/8th Saturday". Weeks run Thursday–Wednesday (Week 1 = first Thursday of Full Term; "0th Monday" = the Monday before): checked against Lent Bumps 2026 (6th Tuesday = 3 Mar) and May Bumps 2026 (7th Wednesday = 17 Jun). Dates computed from it are stored as `tbc` with `inferred` times; specs with alternatives ("6th/7th") are skipped.

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

**Events harvester (T6, re-verified 2026-10-07)** — `events/playwaze.py`, stage `playwaze`.
- robots.txt: `cambridgeuniversityleagues.playwaze.com` → `user-agent: *` / `allow: /`; **`public-cambridgeuniversityleagues.playwaze.com` → `user-agent: *` / `disallow: /`** (never fetched; its league paths are read on the main host).
- `/Home` (and `/…/Community-Network`) redirect to `/confirminvitation?Token=…`, a sign-in page: not fetched, not usable for discovery.
- Discovery: Sport Cambridge's https://www.sport.cam.ac.uk/college-sport/college-leagues-z links each league; on 2026-10-07 all still pointed to **2025-26** communities (`…-netball-25-26`, `…-rugby-football-union-25-`), so the stage skips them (season roll-over) and stages nothing until 2026-27 links appear.
- The league page (GET) gives the league name, divisions (`data-value2="LeagueDivisions/…"`) and `pageConfig.FixtureListRequest.BaseCommunityId`. The fixture list is loaded by a form POST to `/<community>/<id>/fixture-fixturelist` with `page`, `pageSize`, `request[BaseCommunityId]`, `request[CompetitionIds]`, `isDashboard` (without `BaseCommunityId` it answers "Invalid request"); the answer groups fixtures under a date header with team names, venue and kick-off time. The `league-fixtures` GET is a results grid without dates; the CSV export redirects to sign-in.

## §10 University Events API

**Endpoint:** `https://webservices.admin.cam.ac.uk/events/api/programmes/11/calendar/events.json` (also `.rss` and `.ics`). It returned 745 events.

**Use:** context for internal partners. It is not specific to societies.

**robots.txt (re-verified 2026-10-07): `User-agent: *` / `Disallow: /` on `webservices.admin.cam.ac.uk`.** Every endpoint (`events.json`, `.rss`, `.ics`, `show.xml`, uploaded images) is on that host, including the feeds the public What's On page (https://www.admin.cam.ac.uk/whatson/) links for subscription. The stage `uni_events` (`events/uni_events.py`) therefore fetches nothing while the block stands and says so in its run notes. Its parser reads the iCalendar export (a standard format; the JSON schema was not checked, since that would breach robots.txt) and keeps only events naming exactly one known student group.

## §11 Calendar feeds that societies publish

**Feed patterns**
- Google Calendar: `…/calendar/ical/{id}/public/basic.ics`.
- Luma: `https://api.lu.ma/ics/get?entity=calendar&id=…`.
- Luma event pages also carry schema.org Event JSON-LD.

**Discovery:** feeds are found on society websites, Linktree pages and SU profiles.

**Trap:** timezones are often wrong. One feed was set to Asia/Dhaka. Normalise to Europe/London.

**Events harvester (T6, re-verified 2026-10-07)** — `events/calendar_feeds.py` + `events/ics.py`, stage `calendar_feeds`.
- `api.lu.ma` robots.txt: `User-agent: *` / `Disallow: /insights/` — the ICS endpoint is allowed. Luma ICS: UTC times, `STATUS:TENTATIVE` on every event (ignored), `ORGANIZER;CN=` often a person (never used), a generated description ("Get up-to-date information at: <event page> / Address: … / Hosted by <names>") from which only the page is kept. Seed: Cambridge AI Safety Hub `cal-4TNl4yi3sVEcAO5` (from https://luma.com/es51jfvb).
- **`calendar.google.com` robots.txt: `User-agent: *` / `Allow: /$` / `Disallow: /`** — Google Calendar ICS feeds (`/calendar/ical/<id>/public/basic.ics`) are disallowed for crawlers, so they are listed but not fetched (e.g. CUPS links one from camphysoc.co.uk).
- Time zones (`events/ics.py` docstring): floating → London; a zone whose offset differs from London's at that moment (event `TZID`, or `X-WR-TIMEZONE` for UTC times) is re-read as London wall-clock time when the location is empty, online or in Cambridge; such times are `inferred`. Recurrences are expanded in wall-clock time inside the window; events are de-duplicated by UID.

## §12 SU What's On

**Endpoints**
- `https://www.cambridgesu.co.uk/whatson/`, with the markup classes `msl_event_name` and `msl_event_organisation`.
- RSS: `/ents/rss/0/subtree/`.

**Coverage is low:** only about 6 of 61 events came from student groups.

**Events harvester (T6, re-verified 2026-10-07)** — `events/su_whatson.py`, stage `su_whatson`.
- robots.txt for `*` disallows `/photos/ /advertclick/ /login/ /pagestylesheet/ /stylesheet/ /skins/ /resourcehandler/ /edit/ /search/ /asset/ /account/ /Shibboleth.sso /sso/`. Event images are under `/asset/`, so they are not fetched.
- `/whatson/` listed 60 entries: Sabbatical Officers 34, Cambridge SU 19, Clubs and Societies 1, University of Cambridge 1, student groups 5 (Sikh Society, Jugglers' Association, The Interfaith Society, Indonesia Association, Hong Kong Postgraduate Scholars Association). Each `div.event_item` has `data-msl-organisation-id`; the listing date ("8th October") has no year or time.
- Event pages (`/events/<org id>/<event id>/`, `/ents/event/<id>/`) give the title (`h1`), "Friday 09 October 2026", "6pm - 8:45pm", location and organisation (`.event-details` with Font Awesome icons) and the description (`.e-details-txt`). SU-run events (SU, sabbatical officers, the clubs office, the University) are left out; so are entries linking elsewhere (elections page, external sites).

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
