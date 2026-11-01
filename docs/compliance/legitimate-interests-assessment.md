# Legitimate interests assessment (UK GDPR Art 6(1)(f))

Controller: Joshua Fehn (individual). Assessed 2026-10-07 (C, the talks pillar, and D, server-side monitoring, 2026-11-01); review each July and before any change of source, purpose or recipient. This is a working assessment, not legal advice (landscape brief §5.6 is the research behind it).

The ICO three-part test — purpose, necessity, balance — is applied to four processing activities separately, because their risk differs: **A** the public directory and calendar, **B** the private broker CRM, **C** the talks pillar, and **D** server-side error tracking and aggregate counts. Activity numbers (P1…) refer to `record-of-processing.md`.

Browser analytics (P11) rests on consent (Art 6(1)(a)), not on this assessment: PECR reg 6 requires consent for the analytics SDK, and where consent is required legitimate interests must not be used in its place ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-the-pecr-rules-relate-to-the-uk-gdpr/); record-of-processing, "Storage and access"). The harvester's telemetry and LLM usage metrics (ENG-8, ENG-9) hold no personal data, so they need no basis.

## A. Public directory and events calendar (P1, P2, P3, P5, P8)

### Purpose

- Students cannot find societies today: about 98% of college-level groups are missing from the SU directory, and no source holds one current, verified record per group (PLAN.md §1; brief §4.5).
- Societies want to be found; most already publish the same facts on their own pages and on registers.
- Joshua has a personal and portfolio interest in building it. The interest is lawful, specific and real.

### Necessity

- The directory is about organisations. The only personal data it needs is the **role contact address** an organisation publishes, so that a student can reach the society. Role addresses are the least intrusive contact route; a personal CRSid address is never shown publicly (removed by the public projection, `convex/lib/projections.ts`), and named officers are never shown.
- Speaker names on events appear only as the organiser published them.
- Other names in public text (committee members, performers, students) are replaced by their roles before publishing (decision D1); the original wording stays internal.
- Mailing-list mail (P3) is the only route for events that societies do not post anywhere public. It is needed only for the events; the messages are never published, events from them are shown only to verified `@cam.ac.uk` users (the audience the list itself reaches), and messages are deleted after 90 days, their bodies 30 days after they were read for events (`retention.md` R4). Before the model sees a message, quoted replies, forwarded headers, signatures, list footers, addresses and phone numbers are cut out.
- LLM extraction (P5) is needed to read free text at the scale of ~1,500 groups. It is limited to the text of the page or message, never talks.cam (robots.txt), and every LLM value without a verified verbatim quote is labelled `inferred`.
- Less intrusive alternatives considered: asking every society first (the phase-2 outreach does this, but cannot be the only route for 1,500 groups in the time available); publishing names (rejected); scraping Instagram (rejected: platform terms, brief §5.4).

### Balance

| Factor | Assessment |
|---|---|
| Nature of the data | Role addresses and organisation facts. No special category data: a faith or political society is listed, its members are not (Art 9 risk avoided by not naming people) |
| Reasonable expectations | Societies published the data to be found; registers publish it for the same reason. A student society expects to be listed in student directories |
| Source | Publicly accessible pages only; nothing behind a login; crawl delays always honoured; robots.txt honoured except on the pages and feeds societies publish about themselves (decision D3: they publish them to be found), never overridden for talks.cam or non-society sites; obfuscated addresses never decoded |
| Impact | Low: more contact from prospective members. The PECR risk of marketing to a role address is not part of this activity |
| Safeguards | Per-fact source, date and status on every page; claim / correct / remove / object form on every listing and in the footer; Art 14 notice to each society's role address by about 13 Nov 2026 (PLAN.md J7); removal honoured permanently (suppression list, `retention.md` R8); unofficial disclaimer; no University branding |
| Children | Society officers are students, almost all adults; nothing is aimed at children |

**Conclusion:** legitimate interests applies, provided the safeguards above stay in place. The decisive ones are: role addresses only; no personal CRSids or names in public fields; the right to object honoured without argument for a society's own listing.

## B. Private broker CRM (P4, and P5 where it reads the same pages)

### Purpose

Connecting societies with each other and with partners (sponsors, speakers, venues) needs to know who to contact and what each society needs or offers. This is Joshua's interest and the societies'.

### Necessity

- Only names and roles that the society itself published, the organisation, the academic year, and Joshua's own notes of contacts.
- Needs and offers are recorded per **organisation**, not per person.
- Names expire at handover: `staleAfter` = the next 30 June, flagged automatically, deleted 30 days later (`retention.md` R5).
- Introductions relay messages; contact details are never handed to a partner.

### Balance

| Factor | Assessment |
|---|---|
| Nature | Names and roles of student officers; this is profiling-adjacent (aggregating public sources about people), so the bar is higher than for A |
| Expectations | An officer whose name is on the society's site may expect to be contacted about the society, not to be catalogued. Hence: private, time-boxed, no inference about the person |
| Impact | Unwanted contact. Mitigated by contacting role addresses first, recording PECR status per address (default individual subscriber), no marketing without consent, a permanent suppression list, and Art 21(4) objection wording at first contact |
| Data matching | Names are matched to organisations only, never across sources into a profile of a person |

**Conclusion:** legitimate interests applies to B only with every safeguard above, and only while the data stays private. Publishing any of it, selling it, or sending marketing without consent would fail the balance test.

## C. Talks pillar (P10, decision D7)

### Purpose

- Public academic talks are spread over talks.cam and about 111 department and institute sites, each with its own format; a student or researcher cannot see in one place what is on across the University this week.
- Organisers publish talks so that people come to them; the speaker is the point of a talk listing.

### Necessity

- The talk's own facts (title, time, place, series, abstract) and its speakers' names and affiliations exactly as the organiser published them. Speakers are not replaced by roles (D1 does not apply): a talk without its speaker is not useful, and the listing is public for that purpose.
- Nothing is inferred or added about a speaker, and speakers are not matched across talks or sources into a profile: there is no speaker page, index or search by person beyond the talk text itself.
- Parser code only: no LLM reads talks.cam or a department's pages, which also keeps their robots.txt AI opt-outs intact; camsocs's own robots.txt asks AI crawlers to keep off `/talks` and its feeds.
- Short retention: a talk and its details are deleted 30 days after it ended (`retention.md` R11). A talk its source no longer lists is marked `missing` and is not shown.
- Less intrusive alternatives considered: linking out without the speaker (rejected: the speaker is what a reader chooses a talk by); copying only talks.cam (rejected: many departments do not use it).

### Balance

| Factor | Assessment |
|---|---|
| Nature of the data | Professional names and affiliations of speakers at public academic events; abstracts are the organisers' own words. No special category data sought or inferred |
| Reasonable expectations | A speaker announced on a public University listing expects the talk to be advertised, including in calendars and aggregators; talks.cam itself publishes an API and calendar feeds for that purpose |
| Source | Public listings only; talks.cam at most one request every 10 s; department sites only where their robots.txt allows (the society override, D3, never applies); nothing behind Raven |
| Impact | Low: wider notice of a talk the speaker agreed to give in public. Republication is limited to what the organiser published, for at most 30 days after the talk |
| Safeguards | Each talk links to its source and says when it was read; parser-only reading; 30-day deletion; removal or correction through the request form, honoured by a name or contact suppression that the talks ingestion and the stored talks both apply (`retention.md` R8, R11); AI crawlers disallowed on `/talks` |

**Conclusion:** legitimate interests applies to C, provided speakers stay as published, nothing is inferred or aggregated about them, and the 30-day deletion and suppression stay automated.

## D. Server-side error tracking and aggregate counts (P12)

### Purpose

- Keep the site working: see at once when a page, a calendar feed or the request form fails on the server, with enough detail (route, error type, stack) to fix it.
- Know whether calendar feeds and the request form are used, and how much, to decide what to maintain. Feed counts are lower bounds: cached responses never reach the server.
- These are the operator's interests, and visitors' in a site that works. Real, specific, lawful.

### Necessity

- No personal data is wanted, and the events are built so none goes in: a fixed distinct id `camsocs-server`, `$process_person_profile: false`; errors carry the route path without query string, method, route type, error type, message and stack, and `environment`; counts carry a feed kind and a talk or event key, or a request kind. No IP address, user agent, referrer, other header, cookie, body, form field, or hash of any of them.
- Nothing is stored on or read from the visitor's device, so no consent mechanism is involved and PECR reg 6 is not engaged ([ICO: what are storage and access technologies](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/), on server-side processing).
- Alternatives considered: the hosts' own logs (Vercel, Convex) are short-lived, per-request and include IP addresses, so they are not less intrusive; counting in Convex tables would hold the same data with more code. One PostHog project keeps all monitoring under one processor agreement.

### Balance

| Factor | Assessment |
|---|---|
| Nature of the data | Technical events about the site, not about people. The residual risk is an exception message or stack quoting a value from a request; request data is never attached, and the stack names our code |
| Reasonable expectations | A site operator watching for errors and counting calendar downloads is expected; it is stated in `/privacy` |
| Source | The server's own handling of requests it already serves. Nothing from request headers is stored, which keeps clear of the open question whether headers are information "automatically emitted" by the device (PECR reg 6(2)(b); **unverified**, no ICO text on it) |
| Impact | None on individuals: an event cannot be tied to a visitor |
| Safeguards | EU Cloud (Frankfurt), PostHog as processor (its DPA and transfers per record-of-processing; signature an open item there); IP discarded at project level; up to 1 year in PostHog (`retention.md` R12); PostHog AI off at organisation level (confirmed 2026-11-01, DPIA-lite R-16); the senders are no-ops without a key, and only production has one |

**Conclusion:** legitimate interests applies to D, provided the events keep to the fields above. Adding any request data (headers, query strings, bodies, user ids) needs this assessment redone first.

## Objection handling

An objection from a society to its listing (A) is honoured by removing the listing; one from a speaker to a talk (C) by suppressing their name, which removes it from every stored and future talk; one from a person to a role address that identifies them is honoured by removing that address. An objection to B is honoured by deleting the person's rows and suppressing re-collection. Direct-marketing objections are absolute (Art 21(3)). An objection to D is answered by explaining that no server event can be tied to a person. Browser analytics (P11) is not objected to but withdrawn: "Cookie settings", then "Reject", which stops it at once and deletes the `ph_*` identifier. Events already sent stay pseudonymous under that identifier until R12 removes them; once it is deleted the controller cannot identify whose they are, so under UK GDPR Art 11(1)–(2) access, erasure and portability requests about them can be met only if the visitor supplies the identifier, which `/privacy` explains.
