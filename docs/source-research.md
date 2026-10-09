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
- Resources (where termcards live) are served under `/asset/` and `/resourcehandler/`, both disallowed for every crawler, and the resource page itself errors for anonymous requests (checked 2026-10-07). Record a resource termcard's URL, but never fetch the file (§21).

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
- A link into another register's directory (a CUCBC club page `cucbc.org/node/N`, a Camdram society page) is that directory's entry, not the society's website: no claim (`classify_link` → `directory`); cucbc.org identifies no club in the resolver.

**robots.txt** (fetched 2026-10-07): standard Drupal rules only (`Disallow: /core/ /profiles/ /admin/ /search/ /user/…`). The register page is allowed. There is no `Crawl-delay`.

**Registration window and terms**
- Registration runs 1 Jul to 31 Dec, and the list size swings during that window.
- The register states no year. `registrations.proctors` is therefore claimed without one, and its retrieval date places it in the academic year.
- The register is primary evidence for the registration itself. For names and links it is a third party (`secondary`), so a society's own SU profile outranks it.
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
- A social link whose text names a different account than its target (fencing-club, 2026-10-08: text `@c_u_f_c`, link `instagram.com/cudct/`, the Dance Competition Team's) is dropped: neither a social nor an identity hint.

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
- No Blue/Half Blue tick → `sport.blueStatus` none (primary). A tick says *some* Blue status without saying which, so the level is claimed as missing / `not_published` (which also retracts an earlier "none" from the table). The Hawks' Club list (LB §6.2) is undated, secondary and internally inconsistent: ice hockey and rugby league appear in two categories. It is not used.
- College Competition → `sport.collegeCompetition`.
- Intermediate and Elite have no field.

**Not clubs on the A–Z:** "Rowing (College)" (college rowing, see §7) and "Disability Multisport" (CADMuS, a community club). The guide never claims `name` (its headings are sports, not club names), so these create no organisation; a guide row the A–Z does not link (no Sport slug) never joins a club by its name either (the resolver's name tier skips it), so "Rowing (College)" cannot merge into CUBC on the word "rowing" — it is held.

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

**Harvester:** stage `cucbc_clubs`, `sources/cucbc.py`. Details pages are reused from the cache for a week. What only a details page states (the full name, the hidden address) is that page's own observation, attributed to its URL; the club's college, when its own site names it, is claimed from that site (primary).

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

**Events harvester (T6, re-verified 2026-10-07)** — `events/playwaze.py`, stage `playwaze`.
- robots.txt: `cambridgeuniversityleagues.playwaze.com` → `user-agent: *` / `allow: /`; **`public-cambridgeuniversityleagues.playwaze.com` → `user-agent: *` / `disallow: /`** (never fetched; its league paths are read on the main host).
- `/Home` (and `/…/Community-Network`) redirect to `/confirminvitation?Token=…`, a sign-in page: not fetched, not usable for discovery.
- Discovery: Sport Cambridge's https://www.sport.cam.ac.uk/college-sport/college-leagues-z links each league; on 2026-10-07 all still pointed to **2025-26** communities (`…-netball-25-26`, `…-rugby-football-union-25-`), so the stage skips them (season roll-over) and stages nothing until 2026-27 links appear.
- The league page (GET) gives the league name, divisions (`data-value2="LeagueDivisions/…"`) and `pageConfig.FixtureListRequest.BaseCommunityId`. The fixture list is loaded by a form POST to `/<community>/<id>/fixture-fixturelist` with `page`, `pageSize`, `request[BaseCommunityId]`, `request[CompetitionIds]`, `isDashboard` (without `BaseCommunityId` it answers "Invalid request"); the answer groups fixtures under a date header with team names, venue and kick-off time. The `league-fixtures` GET is a results grid without dates; the CSV export redirects to sign-in.
- **Every league of a community (re-verified 2026-10-09).** The leagues app's `/Home` (and `/`) redirect to `/confirminvitation?Token=univ5509`, a page titled "Sign in"; the network's `Community-Network` page redirects to `/`. Neither is read. A community's public tiles page on the main host, `/<slug>/<id>/PublicTiles` (robots allows it, no sign-in; the Sport A–Z links one for rugby), links every league of that community (`league-display/Leagues/<id>`). So for each community of the current season the A–Z links — by a league or as a whole (`PublicTiles`, `community-details`) — the stage reads its tiles page and takes every league it lists. On 2026-10-09 the A–Z still linked only 2025-26 communities (hockey, mixed lacrosse, netball ×2, rugby union, squash, table tennis, tennis, ultimate) and one 2024-25 (volleyball): nothing is read, and the run notes say so.

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
- **Feed references as sites write them (re-verified 2026-10-09).**
  - Google embed links carry the calendar id base64-encoded (`?cid=Y2FtYnJpZGdlY2Fsc29jQGdtYWlsLmNvbQ` is `cambridgecalsoc@gmail.com`); the first harvest staged 6 such values next to the plain ids. They are decoded before the feed URL is built, and an ICS URL on calendar.google.com counts as a Google feed, so a calendar linked both ways is read once, as one event source.
  - The three Luma "calendar ids" of the first harvest (`EACam`, `caish`, `ccs`) are page slugs (`lu.ma/<slug>`), for which the ICS endpoint answers 404. `luma.com`'s robots.txt has rules for Googlebot only. The calendar page (`https://luma.com/<slug>`) carries its own calendar in `__NEXT_DATA__` → `props.pageProps.initialData.data.calendar` (`api_id`, `slug`, `name`): EACam → `cal-JiGNGa42nTFJvpF` (EA Cambridge), caish → `cal-4TNl4yi3sVEcAO5` (Cambridge AI Safety Hub, the seed's calendar), ccs → `cal-EYdjN7G0ZOvxQyv` (Cambridge Climate Society). The stage reads the page (at most weekly), takes the `api_id` only when that calendar's slug is the one linked, and drops a slug whose page is gone or shows no such calendar, with a note. The CAISH seed now names the society's website domain (`cambridgeaisafety.org`), so it resolves to the organisation enrichment keyed.
- **Live trial 2026-10-09** (10 societies with Google or Luma feeds, no Convex writes): 11 of 11 feeds read, 9 of them under the D3 override; 115 events in the window (100 Google, 15 Luma) for 7 societies — Islamic Society 42, Cyber Security 24, Sikh Society 24, EA Cambridge 14, Materials 7, Orthodox Christian 3, Climate Society 1. (The first full harvest read 2 of 28 feeds.)

## §12 SU What's On

**Endpoints**
- `https://www.cambridgesu.co.uk/whatson/`, with the markup classes `msl_event_name` and `msl_event_organisation`.
- RSS: `/ents/rss/0/subtree/`.

**Coverage is low:** only about 6 of 61 events came from student groups.

**Events harvester (T6, re-verified 2026-10-07)** — `events/su_whatson.py`, stage `su_whatson`.
- robots.txt for `*` disallows `/photos/ /advertclick/ /login/ /pagestylesheet/ /stylesheet/ /skins/ /resourcehandler/ /edit/ /search/ /asset/ /account/ /Shibboleth.sso /sso/`. Event images are under `/asset/`, so they are not fetched.
- `/whatson/` listed 60 entries: Sabbatical Officers 34, Cambridge SU 19, Clubs and Societies 1, University of Cambridge 1, student groups 5 (Sikh Society, Jugglers' Association, The Interfaith Society, Indonesia Association, Hong Kong Postgraduate Scholars Association). Each `div.event_item` has `data-msl-organisation-id`; the listing date ("8th October") has no year or time.
- Event pages (`/events/<org id>/<event id>/`, `/ents/event/<id>/`) give the title (`h1`), "Friday 09 October 2026", "6pm - 8:45pm", location and organisation (`.event-details` with Font Awesome icons) and the description (`.e-details-txt`). SU-run events (SU, sabbatical officers, the clubs office, the University) are left out; so are entries linking elsewhere (elections page, external sites).
- **Society profiles' own lists (re-checked 2026-10-09).** 5 of the 590 cached profiles embed `.soc-event-list`; each item links the same `/events/<org>/<id>/` page, with a poster (`.msl_event_image img`, `/asset/Event/<org>/…?thumbnail_width=250…`), a yearless date ("15th October"), the location and types. The stage re-reads the profiles the `su_directory` stage cached (no request of its own) and treats their items as listing entries with the same external id, so an event on both is one event. The event page gives the full date; only when it cannot be had is the list's own date used, its year inferred: the one year that puts it between a week before the profile was read and nine months after, inside an academic year with verified Full Term dates (§19), else the item is rejected as ambiguous; such an event is all day, its date `inferred`. On 2026-10-08 all 5 items were also on What's On, and the inferred dates matched their pages.
- **Posters:** D3 covers SU `/asset/` files linked from a society's profile, so the poster a society's own list links is fetched with the society purpose and stored as our copy. An event only What's On lists keeps no image.

## §13 Linktree

`linktr.ee/<handle>` is server-rendered, and its links sit in `__NEXT_DATA__` JSON. Respect its robots.txt.

**robots.txt (re-verified 2026-10-08, T5):** `User-agent: *` → `Disallow: /`. Only named search crawlers (Applebot, baiduspider, …, each with `Content-Signal: ai-train=no, search=yes`) may fetch profiles. Our User-Agent falls under `*`, so **Linktree profile pages are never fetched**. Besides, the edge answers the pipeline's HTTP client (httpx) with 403 even for robots.txt, which the polite client also treats as "disallow everything"; we do not work around either.

**Use:** a Linktree URL another source states is kept as a `socials` entry (`platform: linktree`). The enrichment stage (`sources/websites/linktree.py`, deterministic, never the LLM) would read its links if the robots.txt ever allowed us; until then each run records the page as `robots_verdict: disallowed`.

## §14 Society websites

- Fetch politely.
- Extract JSON-LD and microdata first, then hand the cleaned text to the LLM.
- About 15 of the 53 sites probed run WordPress. None exposes the Tribe events API, and at least 9 are on Wix.

**How the enrichment stage reads them (T5, `stages/enrich.py`, `sources/websites/`; checked live 2026-10-08):**

- **Which site:** the website a register states (SU profile first, then Proctors, Sport, …), never a social network, the SU or Sport directory, Camdram, talks.cam, a form, a ticket shop or a chat invite; a short link that lands on one of those is dropped. A site claimed by two organisations is read as neither's. A "website" that is a page of a bigger site (a club's page on its parent club's or the RAF's site) is read for its own content only: its header, navigation and footer belong to the host site.
- **Pages:** the home page plus at most one page per kind (about, join, committee, contact, events, sponsors), inside the site and under the starting path. Never: files, login / account / members-only paths, a redirect into a login service (Raven `raven.cam.ac.uk`, SRCF's WLS `nevar.srcf.net`, Microsoft or Google sign-in) — recorded `access_restricted`. Cached pages younger than 3 days are not fetched again; one retry for a site that is down.
- **robots:** robots.txt per host as for every source. A page with `<meta name="robots" content="noindex">` is not read; `nofollow` stops the discovery of further pages.
- **No LLM when a site keeps AI out:** if the host's robots.txt disallows any AI crawler by name (GPTBot, ChatGPT-User, ClaudeBot, CCBot, Google-Extended, PerplexityBot, …) or says `Content-Signal: ai-input=no`, or the page says `noai`, its text never reaches the LLM — the talks.cam rule (§6) applied to every site. Checked **per page**: a sub-page whose URL an AI crawler is disallowed from, or that says `noai`, is left out of the prompt even when the home page may go in. Such sites are read deterministically (links, emails, feeds) only.
- **Free text the model writes is `inferred`.** A description, summary or "one neutral sentence" is `found` only when its words are themselves on the page; a verbatim quote supports the gist, not a paraphrase. Each reading restates every LLM field on every page read (a value, `not_found`, or `not_published` where a value was withheld for naming someone or carrying an address), so a page's older reading never lingers. A membership period is claimed only where the text states it.
- **Dead and hidden.** A stated website whose home page answers 404/410, a login wall or nothing gets a primary `website` negative claim from that URL (`not_found` / `access_restricted` / `unreachable`), which sets the register's link aside until the site answers again (data-model §1). Addresses a site hides (Cloudflare email protection) make `email` / `roleEmails` `access_restricted`, not `not_found`; with the contact page unreadable no address claim is made.
- **Never stored:** personal addresses (CRSids, `jane.smith@…`, anything that names someone), obfuscated addresses (Cloudflare email protection, "name [at] domain"), LinkedIn `/in/` profiles, chat invite links. Committee members' names go to the private broker `people` table only, and a public text that names one is dropped.
- **Parked domains:** a site whose page does not mention the organisation, or says the domain is for sale, yields only its health.

**Trial 2026-10-08** (the first 15 resolved organisations with a stated website, from the SU + Proctors harvest): 9 sites answered (WordPress 3, Wix 2, Squarespace 1, GitHub Pages 1, unknown 2) and 27 pages were read; 3 domains no longer resolve, 1 page is a 404, 1 site redirects to SRCF's Raven-style login (`nevar.srcf.net`), 1 stated website is a short link to a Discord invite, 1 Linktree is disallowed. 1 site's robots.txt blocks AI crawlers (read without the LLM); on 1 the LLM found the pages are not the society's. 8 LLM calls (average 16 s, 8 in parallel): 76 values, 62 quotes exact and 5 normalised; of the 9 unverified, 7 are tags (never quoted, always `inferred`).

**Events pages (stage `website_events`, `sources/websites/events.py`, prompt `website_events_v1`; 2026-10-09).**

- **Which pages:** for every organisation whose home page enrichment read, the home page when it lists upcoming events ("upcoming events", "what's on", "term card" …) and at most two pages inside the site whose link says events / calendar / what's on / term card / programme / fixtures / upcoming / diary (enrichment's "events" page first) — never a past-events archive, never a path dated by an earlier year. Read with the society-website purpose (D3), from enrichment's cache when younger than 3 days; `noindex` pages are not read and `nofollow` stops the discovery.
- **Structured data first:** JSON-LD / microdata `Event` items (any `…Event` type, inside `@graph` too) are read by a parser: name, start and end (a date without a time is all day; `endDate` is inclusive), location (place name and locality, or "Online"), URL, image (stored as our copy), description, cancellation / postponement. On 2026-10-09 only 3 cached pages had any, all past.
- **Then the bulk model** over the cleaned page text (contacts redacted, ≤ 12,000 characters). Every event must carry a `when_quote` that is on the page and holds its date — the day number with a month, a numeric or ISO date, or a term week with a weekday; relative days are dropped (a page has no date of its own). Pages keep last year's programme online without its year, so a calendar date's year must be the one its quote states, or the weekday its quote states must fall on that date that year; a date with neither is kept only within eight weeks of the day the page was read. Term weeks need the term the page names (or its URL / title). A time-less event is all day, its start `inferred`. The reference date the model is given is the Thursday that starts the week, so re-reading a page within the week hits the reply cache.
- **Which events:** between today and nine months ahead; `public`, or `members_only` where the page says so; organised by the site's organisation; external id `<org key>:<date>:<title slug>` for both paths. A reading another source also lists is merged into that source's event at load (data-model §2, "One event, several sources").
- **Estimate (2026-10-09, offline: enrichment's cached pages, real model):** 358 sites read by enrichment; 192 had a cached events page or a home page listing events; 140 upcoming events from 32 sites. Left out: 406 past, 113 without a dated quote, 42 whose stated weekday does not fall on the date (last year's programme), 30 beyond nine months, 12 yearless dates months ahead. Live trial on 5 sites whose events pages were not cached: 4 events (1 site). At load, 5 of them merge into Camdram shows (the ADC's own listing) and 1 into another page of the same site.

## §15 Ticketing

- Fixr returns 403 to scripts and has no public API, so we store links only.
- The Luma public API needs Luma Plus.
- The Eventbrite search API is dead.
- Dice offers a partner-only API.
- Store organiser URLs as feeds only.

## §16 Mailing-list inbox

**Flow**
- Joshua's @cam.ac.uk Outlook rule **redirects** mail that carries a `List-Id` header to an address on a Resend receiving subdomain (setup: `docs/setup/inbox-instagram.md`, J3/J4).
- Resend posts an `email.received` webhook to the Convex HTTP route `POST /api/inbound/email` (`webapp/convex/http.ts`). The webhook carries metadata only; the route verifies its Svix signature, then fetches the body, headers and attachments from Resend's Receiving API and stores the mail in the internal `inboundEmails` table as `pending`.
- The pipeline stage `inbox` extracts events and marks each mail `done` / `skipped` / `failed`.

**Resend, checked 2026-10-07** (https://resend.com/docs/llms.txt and the pages it lists)
- Event `email.received`: `{type, created_at, data: {email_id, created_at, from, to[], cc[], bcc[], received_for[], message_id, subject, attachments[{id, filename, content_type, content_disposition, content_id}]}}`. "Webhooks do not include the email body, headers, or attachments, only their metadata."
- Body and headers: `GET https://api.resend.com/emails/receiving/{email_id}` → `{html, text, headers, …}`; `?html_format=cid` keeps inline images as `cid:` references instead of base64 data URIs.
- Attachments: `GET https://api.resend.com/emails/receiving/{email_id}/attachments` → `data[{filename, size, content_type, download_url, expires_at}]`; each `download_url` is valid for an hour.
- Signature: Svix headers `svix-id`, `svix-timestamp`, `svix-signature`; HMAC-SHA256 with the base64 part of the endpoint's `whsec_…` secret over `id.timestamp.body`; `svix-signature` may hold several space-separated `v1,<base64>` entries. Verified with Svix's published example (https://docs.svix.com/receiving/verifying-payloads/how-manual).
- Retries: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. Our route answers 502/503 when the Receiving API failed or is not configured, so a mail is fetched again later; `messageId` dedupe makes retries safe.
- Receiving needs an MX record on a (sub)domain verified in Resend; a forward straight to Resend's SMTP host is dropped.

**The route** (`POST /api/inbound/email`)
- Two senders: Resend (Svix-signed, `RESEND_WEBHOOK_SECRET`; content fetched with `RESEND_INBOUND_API_KEY` or `RESEND_API_KEY`, which needs full access) and a provider-agnostic JSON body behind `Authorization: Bearer $INBOUND_EMAIL_SECRET` (`webapp/lib/inbound-email.ts` documents the shape). Either secret unset → 401 for that sender.
- `INBOUND_EMAIL_RECIPIENTS` (comma-separated, required: unset accepts no mail) drops mail not addressed to one of those addresses: use an unguessable local part, so strangers who learn the receiving domain (public in its MX record) cannot post events. A redirected list mail keeps the list's address in `To:`, so the check also reads Resend's `received_for`, `Delivered-To`, `X-Original-To`, `Resent-To` and the `for <…>` of `Received` headers, after fetching them.
- **Sender verification.** Headers and body are written by whoever sends a mail. The route records `senderVerified`: a trusted receiver (`INBOUND_TRUSTED_AUTHSERV_IDS`, default `mx.microsoft.com`) reported DMARC pass, or an aligned DKIM pass, for the `From` domain — in the highest-instance `ARC-Authentication-Results` (on the Outlook redirect, Exchange's own seal, which a sender cannot place above), else the first trusted `Authentication-Results`. Verdicts without an authserv-id prove nothing. This reads verdicts; it does not verify signatures — the recipient allowlist is the first gate.
- Limits: 15 MB per request, 100 000 characters of text, HTML ≤ 2 MB (to storage), at most 10 attachments of ≤ 5 MB each. Only images, PDF and calendar files are kept, never SVG; skipped files are named in `extractionNote`.
- `receivedAt` is the mail's `Date` header when it lies between a week before and a day after receipt, clamped to now (the claims API refuses future retrieval times); else when Resend received it.
- Nothing in `inboundEmails` is returned by a public function. Files reach the pipeline only through `POST /api/pipeline/inbound/file`, which serves a file only for the mail it belongs to.

**Extraction** (stage `inbox`)
- Mail without a list signal (no `List-Id`, no lists.cam.ac.uk sender, no inline-forwarded list header) and not from a known organisation is `skipped` before any LLM call.
- The sender is identified deterministically, and only for a verified sender (above), strongest first: `List-Id` → Sympa list on record (and its society component, `soc-cugs-news` → `soc-cugs`); exact sender address; the sender's own domain (never webmail, cam.ac.uk or other shared domains). Never from a display name, a list's name phrase or an inline-forwarded header block. A society name the model reads from the sign-off of a verified list mail counts only when its quote is verified. An unverified mail is never attributed: its events have no organiser, and it claims no organisation's activity (`lastActiveAt`).
- E-mail addresses and phone numbers are redacted before the text goes to the LLM (bulk model, prompt `email_events_v1`). Quotes are checked against that redacted text.
- Dates such as "Wednesday of Week 3" are resolved in code from the verified Full Term dates (§19) and the mail's date, never by the model.
- Attached images and PDFs (posters, termcards) are read with the strong model's vision when the text found no events, says to see the attachment, or the file is named like a termcard. Values read only from an image cannot be checked and stay `inferred`.
- External ids are scoped to the organisation (`<orgKey>:<date>:<title slug>`), so a weekly mail repeating an event updates it. Events another staged source already has (same organiser, start minute, similar title) are dropped.

**Visibility:** `cam_only`, or `members_only` when the mail says so. Never public. The mail's `sourceUrl` is `inbound:<message-id>`, never shown publicly.

**Fact:** external forwarding is possible from Cambridge Exchange Online (Engineering IT help: https://help.eng.cam.ac.uk/email/forwarding-your-email/).

## §17 Meta Instagram Business Discovery

**Access**
- It needs Joshua's own Instagram professional account, linked to a Facebook Page, a developer app and a Facebook User access token with `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement` (setup: `docs/setup/inbox-instagram.md`, J5).
- It covers professional (business or creator) target accounts only; age-gated accounts return nothing.
- The pipeline reads `META_IG_USER_ID` and `META_ACCESS_TOKEN` from `pipeline/.env`. Without both, the `instagram` stage notes "skipped: not configured" and succeeds.

**API, checked 2026-10-07** (https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery.md and the IG Media reference)
- `GET https://graph.facebook.com/v25.0/<META_IG_USER_ID>?fields=business_discovery.username(<handle>){id,username,media.limit(12){id,caption,timestamp,media_type,media_url,permalink,thumbnail_url,children{media_type,media_url}}}`. v25.0 was the latest version that day.
- `media_url` is omitted for media containing copyrighted material (often Reels audio). `caption` excludes the `@` symbol unless the app user administers the page.
- The token travels in `Authorization: Bearer`, never in the URL (so it cannot reach a log).

**Rate limits**
- Business Discovery is under Platform rate limits, not the Instagram business-use-case limits. The `X-App-Usage` header reports `call_count` as a percentage; throttling answers error codes 4, 17, 32 or 613.
- We send one request at a time, at least 2 s apart, at most 100 handles a run. A run stops at the first throttle or once `call_count` reaches 80 %.
- Rotation: never-checked handles first, then the longest unchecked; a handle is due again after 20 h, or after 14 days if it is not a professional account (error 110 / subcode 2207013). An invalid token (codes 10, 102, 190, 200) fails the stage with a message to renew it.

**Data:** captions, timestamps, permalinks and media URLs of posts from the last 60 days. Captions are read by the bulk model (`caption_events_v1`); when a caption points at the image ("see poster", "swipe for our termcard"), the strong model reads up to four images (`image_events_v1`). Image-only values stay `inferred`.
- Events are `public` (the society published them), or `members_only` when the post says so. Their `sourceUrl` is the post's permalink, a link we never fetch.
- Images are downloaded from the `media_url` the API returned (Meta CDN hosts only: `*.cdninstagram.com`, `*.fbcdn.net`) and stored as our own copy, never hotlinked, because SocTrackr's hotlinked CDN URLs expired within days.
- `orgInternal` learns the handle, whether it is a professional account and its Instagram id; the newest post's time is a `lastActiveAt` claim.

**Also:** the Basic Display API has been dead since 4 Dec 2024. instagram.com itself is never fetched.

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

## §20 Sympa public list search

**Location:** `https://lists.cam.ac.uk/sympa/search_list/soc-`, one server-rendered page. Checked **2026-10-07**: 1,077 results, of which 1,030 list names start with `soc-`, from 627 societies (the brief counted 1,078 and about 629).

**robots.txt:** `https://lists.cam.ac.uk/robots.txt` answered 404 on 2026-10-07 (no rules, so allowed). The page sets a session cookie; our client never stores one.

**Naming:** University society lists are `soc-<society>[-<group>]` (UIS: https://help.uis.cam.ac.uk/node/1449).

**Fields:** list name (from the `/sympa/info/<list>` link) and description (the item's text). Nothing else.

**Traps**
- Each list's **address is written by a `document.write` script**, i.e. obfuscated. It is never decoded or reconstructed; subscribing needs only the list *name*.
- `/sympa/info/<list>` pages name the **owners and moderators**: personal data. They are never fetched.
- Lists outlive their societies (`soc-ciccu-events2017`), so a list proves nothing about activity.
- The search also matches non-society names (`caius-engsoc-2024`); only `soc-` names are kept.
- Committee, cohort and year lists (`-committee`, `-exec`, `-alumni`, `-2017`) are not for joining; the worklist prefers announcement-style lists (`soc-x`, `-announce`, `-news`, `-events`, `-interested`, `-info`, then `-members`).

**Subscribing** (UIS: https://help.uis.cam.ac.uk/node/1444): send `subscribe <list-name>` as the subject or first line to `sympa@lists.cam.ac.uk`; most lists ask the owners to approve.

**Use:** `camsocs worklist` only (once a day at most; `sources/sympa.py`). It writes `var/reports/sympa-soc-lists.csv` and ranks organisations for Joshua's manual sign-up (`var/reports/mailing-list-worklist.csv`).

## §21 Termcards

**Inputs:** `termcardUrl` values claimed by other harvesters (SU profiles, society websites).

**Cambridge SU resources** (`/resources/<id>/<name>/`, e.g. https://www.cambridgesu.co.uk/resources/8721/CUHCS-Michaelmas-Term-Card/): checked **2026-10-07**, the resource page answered "Sorry, there was a problem" to an anonymous request, and MSL serves resource files under `/asset/` and `/resourcehandler/`, which the SU's robots.txt disallows for every crawler (`User-agent: *`). **SU-hosted termcards are therefore never fetched**; the stage records them as skipped.

**Fetch:** through the polite client (§ Global rules), at most weekly per card. A page is followed to the first file it links or embeds whose name, label or alt text says termcard / programme / poster, one level deep, robots-checked. Never fetched, recorded as skipped before any request: SU-hosted cards (any `cambridgesu.co.uk` URL — `/file/<id>/Termcard/` is robots-allowed but redirects to the login page, seen 2026-10-08), talks.cam (§6), and Instagram, Facebook, LinkedIn and the other networks. A card reaches the model only when every host it came through lets AI read it (§14: no AI crawler disallowed by name, no `ai-input=no`, no `noai` on the page that embeds it); otherwise it is skipped ("host keeps AI out").

**Read:** strong-model vision (`image_events_v1`). PDFs are rendered page by page (pypdfium2), four pages a model call and at most twelve pages, each call with its pages' **text layer**: quotes are checked against it, so PDF values can be `found`. An image-only card has no text to check against, so its values stay `inferred`. Replies are cached by the request — the card's pages and the reference date, the Thursday that starts the week — so an unchanged card is not read again that week. A termcard URL that is an HTML page linking no card file (a "Term card" page listing the events as text) is read like a society's events page (§14 "Events pages": bulk model, dated quotes). Image files are recognised by their name, by Wix media paths (`…~mv2.png/v1/fill/…`) and lazy `data-src`; a page linking several cards follows the newest-named first.

**Old cards** are not sent to the vision model: a URL or file name naming a term of an earlier academic year ("lent-2024-term-card", "Easter 2026 Termcard.pdf" in 2026-27), or a WordPress-style upload path dated before 1 March of the academic year's first calendar year (`/uploads/2021/04/termcard.png`). On 2026-10-09 this left out 9 of the 26 non-SU cards.

**Dates:** "Week 3 Wednesday" needs the term. The card's own words ("Michaelmas 2026", "MT26") win, then the URL or file name, then the card's own calendar-dated rows when they all fall in one verified term (Week 0 to a week after Full Term ends): its week rows are then dated in that term and claimed `inferred` (the card states the week, not the term). A card that gives none of these keeps only its calendar-dated events, because it may be last term's.

**Estimate 2026-10-09** (offline, cached cards and pages, real model): of 53 known cards, 25 are SU `/file/` links (login wall: `access_restricted` under D3 too), 9 old, 1 unreachable; 18 were read (3 image cards, 15 HTML pages): 23 upcoming events from 4 societies. Most HTML "term card" pages render their programme with scripts or list past events.

**Visibility:** `public` (the society published the card), or `members_only` where the card says so. Events another staged source already has are dropped.
