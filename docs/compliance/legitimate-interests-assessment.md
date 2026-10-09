# Legitimate interests assessment (UK GDPR Art 6(1)(f))

Controller: Joshua Fehn (individual). Assessed 2026-10-07; review each July and before any change of source, purpose or recipient. This is a working assessment, not legal advice (landscape brief §5.6 is the research behind it).

The ICO three-part test — purpose, necessity, balance — is applied to two processing activities separately, because their risk differs: **A** the public directory and calendar, and **B** the private broker CRM. Activity numbers (P1…) refer to `record-of-processing.md`.

## A. Public directory and events calendar (P1, P2, P3, P5, P8)

### Purpose

- Students cannot find societies today: about 98% of college-level groups are missing from the SU directory, and no source holds one current, verified record per group (PLAN.md §1; brief §4.5).
- Societies want to be found; most already publish the same facts on their own pages and on registers.
- Joshua has a personal and portfolio interest in building it. The interest is lawful, specific and real.

### Necessity

- The directory is about organisations. The only personal data it needs is the **role contact address** an organisation publishes, so that a student can reach the society. Role addresses are the least intrusive contact route; a personal CRSid address is never shown publicly (removed by the public projection, `convex/lib/projections.ts`), and named officers are never shown.
- Speaker names on events appear only as the organiser published them.
- Mailing-list mail (P3) is the only route for events that societies do not post anywhere public. It is needed only for the events; the messages are never published, events from them are shown only to verified `@cam.ac.uk` users (the audience the list itself reaches), and messages are deleted after 90 days, their bodies 30 days after they were read for events (`retention.md` R4). Before the model sees a message, quoted replies, forwarded headers, signatures, list footers, addresses and phone numbers are cut out.
- LLM extraction (P5) is needed to read free text at the scale of ~1,500 groups. It is limited to the text of the page or message, never talks.cam (robots.txt), and every LLM value without a verified verbatim quote is labelled `inferred`.
- Less intrusive alternatives considered: asking every society first (the phase-2 outreach does this, but cannot be the only route for 1,500 groups in the time available); publishing names (rejected); scraping Instagram (rejected: platform terms, brief §5.4).

### Balance

| Factor | Assessment |
|---|---|
| Nature of the data | Role addresses and organisation facts. No special category data: a faith or political society is listed, its members are not (Art 9 risk avoided by not naming people) |
| Reasonable expectations | Societies published the data to be found; registers publish it for the same reason. A student society expects to be listed in student directories |
| Source | Publicly accessible pages only; nothing behind a login; robots.txt and crawl delays honoured; obfuscated addresses never decoded |
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

## Objection handling

An objection from a society to its listing (A) is honoured by removing the listing; one from a person to a role address that identifies them is honoured by removing that address. An objection to B is honoured by deleting the person's rows and suppressing re-collection. Direct-marketing objections are absolute (Art 21(3)).
