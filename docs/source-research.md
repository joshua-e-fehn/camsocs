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
- Resources (where termcards live) are served under `/asset/` and `/resourcehandler/`, both disallowed for every crawler, and the resource page itself errors for anonymous requests (checked 2026-10-07). Record a resource termcard's URL, but never fetch the file (§21).

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
- Optional `INBOUND_EMAIL_RECIPIENTS` (comma-separated) drops mail not addressed to one of those addresses: use an unguessable local part, so strangers who learn the receiving domain cannot post events. A redirected list mail keeps the list's address in `To:`, so the check also reads `Delivered-To`, `X-Original-To`, `Resent-To` and the `for <…>` of `Received` headers, after fetching them.
- Limits: 15 MB per request, 100 000 characters of text, HTML ≤ 2 MB (to storage), at most 10 attachments of ≤ 5 MB each. Only images, PDF and calendar files are kept, never SVG; skipped files are named in `extractionNote`.
- `receivedAt` is the mail's `Date` header when it lies between a week before and a day after receipt, clamped to now (the claims API refuses future retrieval times); else when Resend received it.
- Nothing in `inboundEmails` is returned by a public function. Files reach the pipeline only through `POST /api/pipeline/inbound/file`, which serves a file only for the mail it belongs to.

**Extraction** (stage `inbox`)
- Mail without a list signal (no `List-Id`, no lists.cam.ac.uk sender, no inline-forwarded list header) and not from a known organisation is `skipped` before any LLM call.
- The sender is identified deterministically, strongest first: `List-Id` → Sympa list on record (and its society component, `soc-cugs-news` → `soc-cugs`); exact sender address; the sender's own domain (never webmail, cam.ac.uk or other shared domains); display or list name against known names. A society name the model reads from the sign-off counts only when its quote is verified.
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

**Fetch:** through the polite client (§ Global rules), at most weekly per card. A page is followed to the first file it links or embeds whose name, label or alt text says termcard / programme / poster, one level deep, robots-checked.

**Read:** strong-model vision (`image_events_v1`). PDFs are rendered page by page (at most four pages, pypdfium2) and their **text layer** goes along: quotes are checked against it, so PDF values can be `found`. An image-only card has no text to check against, so its values stay `inferred`. Replies are cached by the file's content hash.

**Dates:** "Week 3 Wednesday" needs the term. The card's own words ("Michaelmas 2026", "MT26") win, then the URL or file name. A card that says neither keeps only its calendar-dated events, because it may be last term's.

**Visibility:** `public` (the society published the card), or `members_only` where the card says so. Events another staged source already has are dropped.
