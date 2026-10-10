# Record of processing activities (UK GDPR Art 30)

Controller: **Joshua Fehn**, as an individual (personal / portfolio project; PLAN.md §1). No joint controllers, no representative, no DPO (not required: no large-scale special-category processing, no public authority).
Contact: the public request form (`/request`) and `CONTACT_EMAIL` in `webapp/lib/site.ts`: camsocs@joshua-fehn.de (decision D4, 2026-10-08). ICO / Information Commission fee: **Tier 1, to be paid** (PLAN.md J6); record the number in `ICO_REGISTRATION_NUMBER`.

Why a record is kept: the directory is maintained continuously, so the processing is not "occasional" (landscape brief §5.2). This file is the record; `docs/data-model.md` is the authority on fields, and the public notice is `webapp/app/(site)/privacy/page.tsx`.

Last reviewed: 2026-10-07. Review: each academic year (July), and before any new source, recipient or purpose.

## Activities

| # | Activity | Purpose | Lawful basis | Data subjects | Personal data | Source | Where held | Recipients / processors | Retention (see retention.md) |
|---|---|---|---|---|---|---|---|---|---|
| P1 | Public directory | Help students find societies; one sourced record per group | Art 6(1)(f), LIA §A | Holders of society roles (indirectly) | Role addresses published by the organisation (e.g. `president@…`); organisation names; social links. **No** personal CRSid addresses in public fields (removed by `convex/lib/projections.ts`); no named people: names in descriptions are replaced by roles before publishing (D1), the original kept only in the internal `fieldClaims.valueRaw` | SU directory, Proctors' register, Sport Cambridge, Camdram, CUCBC, college / JCR / MCR sites, society sites, Linktree (source-research §1–§14) | Convex (`organisations`, `orgCards`, `fieldClaims`, `sources`) | Convex, Vercel; the public | R1, R2 |
| P2 | Events calendar | Show what societies publish | Art 6(1)(f), LIA §A | Speakers named in published listings | Event titles, speaker names and affiliations *as published*, organiser organisations | Calendar feeds, Camdram, talks.cam (parser only), Playwaze, SU What's On, University events listing, mailing lists (P3) | Convex `events` | Convex, Vercel; the public, or verified `@cam.ac.uk` users for `cam_only` | R3 |
| P3 | Mailing-list inbox | Extract events from society list mail Joshua receives | Art 6(1)(f), LIA §A | List senders; people named in messages | Sender name and address, message text, attachments | Forwarding rule on Joshua's `@cam.ac.uk` mailbox (source-research §16) | Convex `inboundEmails` (internal; never in a public projection) | Resend (inbound), Convex, the LLM provider (P5) | R4 |
| P4 | Private broker CRM | Contact societies, broker introductions to partners | Art 6(1)(f), LIA §B | Committee members named on public society pages; contacts Joshua interacts with | Name, role, organisation, academic year, public profile links, interaction notes, introductions | Public society pages; Joshua's own notes | Convex `people`, `orgBrokerProfiles`, `interactions`, `introductions` behind `requireBrokerUser` (BROKER_EMAILS) | Convex. Never exported to partners: introductions relay messages | R5, R6 |
| P5 | LLM extraction | Turn free text into structured, quote-checked fields; replace names of private individuals in public text with roles (D1) | Art 6(1)(f) (part of P1–P4) | Anyone named in the text processed | Page text from society sites; list-mail text (P3); termcard images | The pipeline's `var/cache/` and `inboundEmails` | Sent per request; not stored by us beyond the extracted claims | cliproxy relay (Joshua's server) → OpenAI (Codex models `gpt-6-luna`, `gpt-6.1-sol`). talks.cam content is never sent (source-research §6) | Provider's own terms; R7 for our copies |
| P6 | Listing requests | Claims, corrections, removals, objections, additions; rights requests and complaints | Art 6(1)(c) (responding to rights requests), Art 6(1)(f) | Submitters | Email, optional role, message, proposed field values | The submitter | Convex `listingRequests` (internal) | Convex | R8 |
| P7 | Sign-in | Admin access (Google) and the Cambridge-only tier (`@cam.ac.uk` email link) | Art 6(1)(f) | Signed-in users | Email, name, Google profile image (admin), session token, session IP address and user agent (Better Auth defaults) | The user, Google | Convex Better Auth component (`user`, `session`, `account`, `verification`) | Convex, Resend (email links), Google (OAuth) | R9 |
| P8 | Raw page cache | Re-parse without re-fetching; evidence for claims | Art 6(1)(f) (part of P1) | As in P1 | Whatever the public page contains | Polite fetcher (`sources/base.py`) | `var/cache/` on the machines running the pipeline: the VPS host for the scheduled runs (`/opt/camsocs/var/`, user `camsocs`, D5, `docs/ops-vps.md`) and Joshua's laptop for runs by hand. Never in Git | — | R7 |
| P9 | Instagram Business Discovery (when a token exists) | Event posts of professional accounts | Art 6(1)(f) | Account holders (organisations) | Captions, timestamps, media we store | Meta Graph API (source-research §17) | Convex `storedFiles`, `events` | Meta (source), Convex | R3 |

Not processed: special category data (no inference of religion, politics, ethnicity, health or sexuality — a faith society's *existence* is listed, its members are not); member lists; personal phone numbers; data from behind Raven or members-only pages; Instagram / Facebook / LinkedIn scraping.

## International transfers

| Recipient | Location | Safeguard | Status |
|---|---|---|---|
| Convex | Deployment region not yet recorded here | Provider's DPA and UK transfer terms | **Joshua to verify** the region of the dev and prod deployments, and accept the DPA |
| Vercel | Global edge; US company | Provider DPA with UK addendum | **Joshua to verify** |
| Resend | US | Provider DPA | **Joshua to verify** before J3 goes live |
| OpenAI (via cliproxy, ChatGPT Codex Pro login) | US | Consumer-plan terms, not an API DPA | **Open risk** — see DPIA-lite R-4 |
| Google (OAuth, admin only) | Global | Google terms | Admin account only |

## Security measures (Art 32, summary)

- Broker and internal tables reachable only through functions that call `requireBrokerUser`; public queries return validated projections only (`convex/lib/projections.ts`, `returns` validators).
- Pipeline writes only through `/api/pipeline/*` with a Bearer key; secrets live in `pipeline/.env` and the Convex env, never in Git.
- On the VPS host (D5) the pipeline runs as its own unprivileged user under sandboxed systemd units (`ProtectSystem=strict`, `NoNewPrivileges`, no capabilities, Mya's agent data and Docker unreachable, private address ranges denied), with its env files `0600`, a read-only deploy key and its own cliproxy key; it is not run inside the LLM agent's container, and its fetcher never connects to a non-public address (`docs/ops-vps.md`). A failed run's Slack alert carries structured facts only (group, exit code, phase, commit, run key, failed stages' names, the log's path): no personal data goes to Slack, so Slack is no recipient here.
- `cam_only` events need a verified `@cam.ac.uk` session; `members_only` events are never shown.
- TLS everywhere; no analytics or third-party trackers on the site.
