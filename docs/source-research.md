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
- `https://www.sport.cam.ac.uk/student-sport/university-sports-clubs`, which redirects to `/university-sports-clubs-0`.
- **Re-verified 2026-10-07:** 77 club links under "Sports Clubs A-Z" (77 distinct clubs); 74 of the 77 club pages link an Instagram account.
- Most links go to `/university-sports-clubs-0/<slug>`; a few use legacy paths (`/student-sport/university-sports-clubs/<slug>`).

**robots.txt** (www.sport.cam.ac.uk, checked 2026-10-07): `User-agent: *` with the Drupal defaults only (`Disallow: /core/`, `/profiles/`, `/admin/`, `/search/`, `/user/login` …). Club pages and `/sites/default/files/` are allowed. No `Crawl-delay`.

**Fields**
- The A–Z is the Sports Service's register of recognised University sports clubs: `registrations.sportsService` (primary; the page states no year), `orgType` sports_club, `level` university, `categories` sport (data-model §5 rule).
- Club page: the full name as the bold lead ("**Cambridge University Athletic Club (CUAC)** is …" → name + `shortName`) or, without bold, in the lead sentence; the description; one Instagram link.
- The page's "Contact" is the Sports Service's generic `support@sport.cam.ac.uk`. It is **never** claimed as the club's address.

**Traps**
- Some pages carry the typo `support@sport.ac.uk` (in the `mailto:` only).
- Four A–Z links (Kabaddi, Ski and Snowboard, Small Bore, and the page itself) point at `live-cambridge-sports-cwp.pantheonsite.io`, the hosting platform's own domain for the same site. Its robots.txt is `User-agent: * / Disallow: /` (checked 2026-10-07), so that host is never fetched; the same path on the canonical `www.sport.cam.ac.uk` (allowed) is fetched instead.

**Harvester:** stage `sport_clubs`, `pipeline/src/camsocs_pipeline/sources/sport.py`.

## §4 Sports Club Guide 2026-27 (PDF)

**Location:** linked from the §3 A–Z as `https://live-cambridge-sports-cwp.pantheonsite.io/sites/default/files/UoC%20Sports%20Club%20Guide%2026-27_web.pdf`. That host's robots.txt disallows everything (§3), so the harvester fetches the same file from the canonical host, `https://www.sport.cam.ac.uk/sites/default/files/UoC%20Sports%20Club%20Guide%2026-27_web.pdf` (allowed; re-verified 2026-10-07: 36 pages, 8,987,891 bytes, created 16 Sep 2026, InDesign).

**Fields per club**
- Description.
- Website.
- Instagram and Facebook links (printed as `instagram.com/…`, `Instagram: @handle`).
- Contact email: there are 74 contact lines. 23 are `@sport.cam.ac.uk` aliases, 19 are Gmail, and one is misspelt `gmail.comm` (not stored).
- The "At a glance" table:
  - open to;
  - caters for (Beginner / Intermediate / Elite);
  - Blue / Half Blue;
  - college competition.
- Venues.

**Layout (re-verified 2026-10-07)**
- 78 club sections on PDF pages 8–31. Each starts with a heading in Helvetica Neue Heavy 10 pt; the description is in the Light face at 7.4–8 pt; links and "contact:" lines follow. Pages 11, 16 and 22 are images. A rotated side tab ("Aikido • American Football • Archery") marks the A–Z pages; page 27 has none.
- "Sports Clubs at a Glance" on PDF pages 6–7: 79 rows.

**Trap, and how it is solved:** the ticks in the "At a glance" table cannot be read from the PDF's *text*: it shows only "a a a". But every tick is drawn by its own `Tj` in the Webdings font, at an exact x. The seven columns sit 34.02 pt apart (from x = 176.13 on page 6 and x = 170.5 on page 7, the facing page). The same font also draws spaces, which are told apart by glyph code. The harvester reads tick positions from the content stream, checks the column headings first, and cross-checks every row's tick count against the text layer (79 of 79 rows agreed on 2026-10-07). If the columns are not seven evenly spaced ones, the table is skipped and the run says so. The readings are verifiable, so they are parser claims (`found`). The LLM-vision route this § first proposed is not needed: it could only ever have been `inferred`, and the environment has no PDF renderer.

**Mapping**
- Students → audiences undergraduates + postgraduates.
- Staff → audiences staff.
- Beginner → audiences beginners and `beginnerFriendly`; an empty cell is a published "no".
- No Blue/Half Blue tick → `sport.blueStatus` none (primary). A tick says *some* Blue status without saying which, so the level is not claimed. The Hawks' Club list (LB §6.2) is undated, secondary and internally inconsistent: ice hockey and rugby league appear in two categories. It is not used.
- College Competition → `sport.collegeCompetition`.
- Intermediate and Elite have no field.

**Not clubs on the A–Z:** "Rowing (College)" (college rowing, see §7) and "Disability Multisport" (CADMuS, a community club). The guide never claims `name` (its headings are sports, not club names), so these create no organisation.

**Harvester:** stage `sport_guide_pdf`, `sources/sport_guide.py`.

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

**Re-verified 2026-10-07**
- robots.txt is `User-agent: *` with no rules (everything allowed).
- `societies.json` has 97 societies:
  - 38 have a `college`: 37 Cambridge colleges plus one "Anglia Ruskin";
  - 61 have an `image`, which the society page renders as `https://www.camdram.net/media/cache/thumbnail/{filename}`;
  - 36 have a `facebook_id` (a page id or a page URL; one is a `bit.ly` link, which is dropped);
  - `twitter_id` is sometimes a corrupted float (`7.62E+17`), so it is not used.
- 24 descriptions contain addresses: role addresses, general ones, and **personal CRSids**. Several list committees by name, or give a CRSid in brackets ("Name (ab123)").
- **Rule:** role addresses become `roleEmails`. The public `description` keeps only the leading prose, up to the first line that starts a committee or contact block, mentions a committee, founders or a CRSid, reads "Post: First Last", or carries an address or a Camdram person link.

**Harvester:** stage `camdram_societies`, `sources/camdram.py`. One request; the image is the logo's source, and our own copy is made by a later image step.

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

**Re-verified 2026-10-07**
- robots.txt is `User-agent: *` with `Crawl-delay: 10` and the Drupal 7 defaults. `/clubs` and `/node/N` are allowed.
- `/clubs` has 37 rows:
  - the 31 college clubs;
  - CUBC, CUCBC itself, Addenbrooke's, Anglia Ruskin, the Theological Colleges and the Vet School.
- The "Club Website" column:
  - is empty for 3 clubs (Addenbrooke's, Theological Colleges, Vet School);
  - is a Facebook group for Homerton (stored as a social link, not a website).
- Details page (`/node/N`):
  - full name, short name and boat code;
  - "CUCBC Email" written `name[at]cucbc.org`. This is obfuscated and **not decoded**: `email` is missing / `access_restricted`;
  - an officers table of named people, which is **never read**.
- "Lady Margaret Boat Club" names no college. https://www.ladymargaretboatclub.org/ states "The Lady Margaret Boat Club is the rowing club of St John's College, Cambridge". The harvester re-checks that page on each run before claiming the college.

**Harvester:** stage `cucbc_clubs`, `sources/cucbc.py`. Details pages are reused from the cache for a week.

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

**Re-verified 2026-10-07/08**
- **College A–Z:** 31 colleges, each with "Visit the … website". robots.txt (www.cam.ac.uk) has the Drupal defaults only. Colleges are staged as counterparts (`isCounterpart` true, `level` college).
- **JCR/MCR bodies:** a table of **54 bodies** (`BODIES` in `sources/colleges.py`). It was built by following each college's own links: homepage, sitemap and student pages. Each entry records the body's own site (`home`) and/or a page that names it (`evidence`).
  - The name is claimed only from a page that shows it:
    - `found` for the full name;
    - `inferred` for the short form ("JCR").
  - The website is claimed only from a home page that answers and names the body.
  - On a college's own site, only links and addresses that carry the body's mark ("instagram.com/girtonmcr", "gsb.president@…") are the body's, never the college's footer.
- **Not found:** no page naming them was found for the Emmanuel MCR, the Caius MCR or the Queens' MCR.
- **Traps seen**
  - jcr.cai.cam.ac.uk: robots.txt disallows all → `website` missing / `access_restricted`.
  - www.ecsu.org.uk: robots.txt answers HTTP 500, treated as disallow → `unreachable`.
  - wcsa.wolfson.cam.ac.uk: resets the connection → `unreachable`. The college's own WCSA page (https://www.wolfson.cam.ac.uk/student-association-wcsa) is used instead of the archive copy.
  - The Selwyn MCR site the college links (http://www-mcr.sel.cam.ac.uk/) answers **410** → `not_found`.
  - kcgs.org.uk, linked by KCSU as "King's Graduate Society", now serves an unrelated site about King's College, so no website is claimed.
  - Cloudflare email protection on Churchill's JCR/MCR page and on Queens' JCR → `email` and `roleEmails` missing / `access_restricted`, never decoded.
- **Named officers:** none are read. The bodies' committee pages are left for a later broker-only extraction.

**Harvester:** stage `colleges`, `sources/colleges.py`.

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
