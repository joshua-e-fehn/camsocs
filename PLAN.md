# camsocs: plan

## 1. Context

camsocs is a verified, current database of every student society and sports club in Cambridge. On top of it sit two things:

- a public website for discovery: browse, filter, search, and an events calendar;
- a private brokering layer, for connecting societies with each other and with external and internal Cambridge parties.

It is a personal / portfolio project by Joshua Fehn (MPhil ACS 2026-27). It is unofficial and not affiliated with the University of Cambridge or Cambridge SU.

**Why now** (research: `docs/research/2026-10-07-landscape-brief.md` §4.5):
- No one holds a single verified record per group across the SU, Proctors, Sport, Camdram, colleges, JCR/MCR and department lists.
- About 98% of the roughly 1,050 college-level groups are missing from the SU directory.
- The SU directory shows no committees.
- SocTrackr has been dormant since Feb 2026.
- No one offers sponsor-ready or brokering data.

**Deadline:** Fri 16 Oct 2026, with Sat 17 to Sun 18 Oct as buffer.

## 2. Product spec

### 2.1 Data
The full field set is in `docs/data-model.md`.

**Core rule:** every field carries a source, a date, a method, a status (found / inferred / missing / conflicting / not applicable) and a confidence. This gives an automatic list of missing fields per organisation.

### 2.2 Scope v1
- **Included:**
  - every University-level society (SU directory and Proctors register);
  - every University sports club (Sport Cambridge);
  - theatre companies (Camdram);
  - the 31 colleges with their JCR/MCR bodies;
  - the 37 CUCBC boat clubs.
- **Phase 2:** the remaining college-level clubs. The schema already supports them through `level`, `collegeKeys`, `collegeBody` and the many-to-many links.
- **Excluded for now:** ARU, city clubs and May Balls. The schema can take them later.

### 2.3 Public website (camsocs.vercel.app)
- [ ] Browse, search and filter organisations by:
  - category (our 16, multi-select);
  - level;
  - college;
  - activity type;
  - audience;
  - active status;
  - sport attributes (Blue status, beginner-friendly, gender category).
- [ ] Organisation page:
  - description, practical information and membership;
  - role contacts and socials;
  - events, teams and regular sessions;
  - a `SourceLine` under every fact (status chip, source host, date);
  - "missing" shown honestly.
- [ ] Events calendar (list, week and month views) with filters. Public events are open to all; `cam_only` events need a verified `@cam.ac.uk` session.
- [ ] Claim, correct, remove or object form on every listing.
- [ ] About page with the non-affiliation disclaimer, privacy notice and a "how we collect data" page.
- [ ] No crest, no logo, and no "University of Cambridge" / "Cambridge University" in the product name.

### 2.4 Private brokering area (Joshua only, via `BROKER_EMAILS`)
- [ ] Organisation graph:
  - relationships (sponsors, co-hosts, sister societies, affiliations);
  - filters by need or offer.
- [ ] People: named committee members from public sources, marked stale after handover.
- [ ] Needs and offers per organisation, each inferred or confirmed.
- [ ] Interaction log and follow-ups.
- [ ] Introductions (party A ↔ party B, reason, status, outcome).
- [ ] Missing-data report, plus a phase-2 outreach export (role address and the list of missing fields). The outreach doubles as the Art 14 notice and must be sent by about **13 Nov 2026**.
- [ ] Inbox of listing requests.

### 2.5 Auth
- Google sign-in for the admin, through Better Auth inside Convex.
- An emailed sign-in link limited to `@cam.ac.uk`, through Resend, for the Cambridge-only tier. Until Resend is configured it is a no-op behind a feature flag.

## 3. Source strategy

Per-source detail lives in `docs/source-research.md`. Each harvester gets its own § there before code is written.

| Layer | Sources | Method |
|---|---|---|
| Who exists | SU Find a Society (590, **full profiles scraped**: Joshua's decision), Proctors register (303), Sport Cambridge A–Z (about 75) plus club pages plus the Sports Club Guide 2026-27 PDF, Camdram societies (97), CUCBC clubs (37), the 31 colleges and their JCR/MCR sites | Parser first. LLM only for free text. |
| Enrichment | Each organisation's own website, Linktree, JSON-LD | Polite fetch, then the LLM extracts into pydantic models with evidence quotes and a verbatim check |
| Events | Camdram API; talks.cam XML/ICS (**parser only, never the LLM**, `Crawl-delay: 10`, robots blocks AI agents); discovered ICS / Luma / Google feeds; University Events API; Playwaze college leagues; CUCBC; SU What's On | Parser |
| Events (no feed) | Forwarded mailing-list mail (Outlook rule on Joshua's @cam address → inbound webhook → Convex `inboundEmails`); Meta Business Discovery API (professional accounts, token from Joshua); termcard images (gpt-6.1-sol vision) | LLM extraction; mailing-list events default to `cam_only` |

**Hard rules**
- No Instagram, Facebook or LinkedIn scraping.
- Respect robots.txt, including the full-site block on the Caius JCR site and the AI-agent blocks on talks.cam and tbc.xyz.
- Do not decode obfuscated emails (Queens' JCR via Cloudflare, Wolfson via script).
- Do not fetch Raven-gated or members-only pages (Homerton list, Lucy Cavendish, Peterhouse 403).
- Do not bulk-store personal CRSids from college lists in public fields.
- Use an honest User-Agent: `camsocs-bot/0.1 (+https://camsocs.vercel.app/about)`.

**LLM**
- cliproxy (`https://cliproxy.mymya.cloud/v1`, OpenAI-compatible), Codex models only:
  - `gpt-6-luna` for bulk work;
  - `gpt-6.1-sol` for images and hard or conflicting cases.
- The client has a hard guard that refuses any `claude*` model.
- No proactive throttling. Joshua is fine with exhausting the weekly Pro quota.
- On HTTP 429 or 5xx, back off and resume.

## 4. Phases and tasks

The build runs as parallel agent workflows. Each task produces a commit (or a branch, then a merge) and passes the gates before merging.

| Task | Phase | What | Status |
|---|---|---|---|
| T1 | A Foundation | Scaffold the webapp (template, upgraded) and the pipeline skeleton (polite client, LLM client, loader, runner). Gates and CI. | in progress |
| T2 | A Foundation | Domain schema from `docs/data-model.md`. Ingestion mutations and the field resolution / derivation engine. Vocab parity test. | done |
| T3 | B Harvest | Seed harvesters: SU directory + profiles, Proctors, Sport A–Z + pages + guide PDF, Camdram societies, CUCBC, colleges, JCR/MCR bodies | todo |
| T4 | B Harvest | Identity resolution and de-duplication across sources (SU id, Instagram handle, normalised name + level + college), with a quarantine | todo |
| T5 | B Harvest | Website / Linktree enrichment plus LLM field extraction (practical information, contacts, socials, categories, needs and offers, feeds) | todo |
| T6 | B Harvest | Event feeds (Camdram, talks.cam, ICS / Luma / Google, University Events API, Playwaze, CUCBC, SU What's On) plus `termDates` | done (branch `feat/events-feeds`) |
| T7 | B Harvest | Inbound email route (provider-agnostic webhook plus a Resend adapter) and pipeline extraction of events from mail; mailing-list sign-up worklist | done |
| T8 | B Harvest | Instagram Business Discovery client (no-op until a token exists) and termcard OCR | done |
| T9 | C Webapp | Public site: browse, filter, organisation page, events calendar, about, privacy | todo |
| T10 | C Webapp | Auth tiers (Google admin + `BROKER_EMAILS`; `@cam.ac.uk` sign-in link) and `cam_only` gating | todo |
| T11 | C Webapp | Broker area: graph, people, needs and offers, interactions, introductions, missing-data report, outreach export | todo |
| T12 | C Webapp | Claim / correct / remove form plus the `listingRequests` admin | todo |
| T13 | D Ship | Compliance documents: privacy notice, legitimate interests assessment, DPIA-lite, record of processing, retention | todo |
| T14 | D Ship | Deploy: Vercel project + prod Convex + env, full harvest, coverage report | todo |
| T15 | D Ship | QA: adversarial review, browser checks (desktop and mobile), data-quality audit sample | todo |

### Joshua's tasks (front-loaded)

| ID | Task | Unblocks |
|---|---|---|
| J1 | `vercel login`, or import `joshua-e-fehn/camsocs` in the Vercel dashboard (root dir `webapp`) | T14 |
| J2 | Create a Google OAuth client. Callbacks: `http://localhost:3000/api/auth/callback/google` and `https://camsocs.vercel.app/api/auth/callback/google`. Then `bunx convex env set GOOGLE_CLIENT_ID/SECRET`. Set `BROKER_EMAILS` to your Google login. | T10, T11 |
| J3 | Resend account. DNS records at IONOS for sending (sign-in links) and an inbound subdomain (for forwarded list mail). Webhook to `/api/inbound/email`; its signing secret and a full-access API key in the Convex env. Steps: `docs/setup/inbox-instagram.md` | T7, T10 |
| J4 | Outlook rule on your @cam.ac.uk mailbox that **redirects** list mail (has a `List-Id` header) to the inbound address. Then work through the mailing-list sign-up list (`pixi run pipeline -- worklist` → `var/reports/mailing-list-worklist.csv`). Steps: `docs/setup/inbox-instagram.md` | T7 |
| J5 | Meta: switch an Instagram account to professional, link a Facebook Page, create a developer app, get a long-lived token (renew about every 60 days); set `META_IG_USER_ID` and `META_ACCESS_TOKEN` in `pipeline/.env`. Steps: `docs/setup/inbox-instagram.md` | T8 |
| J6 | Pay the ICO data protection fee (£52) | T13 |
| J7 | Send the phase-2 outreach / Art 14 notice by about 13 Nov 2026 (from the export in T11) | compliance |
| J8 | Later, and only on request: approve the VPS move (pipeline into Mya's workspace as Hermes script-only cron jobs, plus its own cliproxy key) | runs off the laptop |

## 5. Repo structure

See `AGENTS.md` and `docs/research/2026-10-07-repo-conventions.md` §2. The layout follows Bundestracker:

- `pixi.toml` at the root holds the tasks.
- `pipeline/` holds the Python harvesters and the LLM extraction, and loads into Convex through `/api/pipeline/*`.
- `webapp/` holds Next 16, Convex, Better Auth and shadcn.

## 6. Decisions log

| Date | Decision |
|---|---|
| 2026-10-07 | Core = brokering. The public site is the flywheel. |
| 2026-10-07 | Operator = personal / portfolio project (UK GDPR still applies to the public site). |
| 2026-10-07 | Scope v1 = University-level societies and clubs, plus JCR/MCRs and college boat clubs. Other college clubs come later. Schema: `level` + `institution`-ready. |
| 2026-10-07 | One organisation graph. External organisations are harvested only when linked to a society. |
| 2026-10-07 | People: the public site shows role contacts only. Named committee members are private, from public sources, and expire at handover. |
| 2026-10-07 | Acquisition is fully automated first, with per-field tracking of missing data. Societies are asked later. |
| 2026-10-07 | Taxonomy = our own categories (multi), plus facets and tags. The SU category is mapped, not adopted. |
| 2026-10-07 | Events = a full live calendar in v1. Sources with no feed: a mailing-list inbox plus the Meta Business Discovery API. No Instagram scraping. |
| 2026-10-07 | Brokering layer = needs and offers, an interaction log and introductions. |
| 2026-10-07 | No audience or size metrics. Only an active / dormant status. |
| 2026-10-07 | Stack: private GitHub repo, Convex (Joshua's subscription), Next.js + Tailwind + shadcn per his template. |
| 2026-10-07 | Visibility: public site; `cam_only` tier for mailing-list events; broker area for Joshua only. |
| 2026-10-07 | Inbox = Joshua's @cam.ac.uk address plus an Outlook forwarding rule (Engineering IT confirms external forwarding is possible). |
| 2026-10-07 | Deadline: Fri 16 Oct 2026, full scope. |
| 2026-10-07 | Name: camsocs. Domain: camsocs.vercel.app for now. |
| 2026-10-07 | Harvester: Python pipeline (Bundestracker pattern) → Convex HTTP ingestion. Target host: Mya's workspace on the VPS as Hermes cron jobs. **No VPS changes yet; it runs from the laptop.** |
| 2026-10-07 | LLM: cliproxy, Codex models only, no throttling. Never Claude subscription credentials (Anthropic's policy prohibits proxy use). |
| 2026-10-07 | Seeding: **scrape SU profiles fully**, descriptions included (Joshua's choice over the seed-only option; database-right risk noted). |
| 2026-10-07 | Compliance: the minimum compliant setup (privacy notice, disclaimer, claim/remove form, LIA, DPIA-lite, record of processing, ICO fee, Art 14 notice via the phase-2 email). |
| 2026-10-07 | Field set confirmed as in `docs/data-model.md`. |
| 2026-10-07 | Inbound list mail: Resend receiving subdomain → Svix-verified webhook `/api/inbound/email` (content fetched from Resend's Receiving API); a provider-agnostic JSON route behind a shared secret as the fallback. Outlook rule *redirects* (keeps `List-Id`). |
| 2026-10-07 | Dates like "Wednesday of Week 3" are resolved in code from the verified term dates; the LLM only reports what the text says. LLM-extracted events from images without a text layer stay `inferred`. |
| 2026-10-07 | SU resource termcards are not fetched: their files sit under robots-disallowed `/asset/` and `/resourcehandler/` (source-research §1, §21). |
