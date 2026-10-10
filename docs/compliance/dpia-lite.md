# DPIA-lite (screening and risk register)

Controller: Joshua Fehn. Prepared 2026-10-07; updated 2026-10-09 for decisions D1 (names in public text redacted to roles) and D3 (society pages read where robots.txt disallows). Review each July, and before: a new source, a new recipient, publishing anything about named people, or moving the pipeline to the VPS (PLAN.md J8).

## 1. Screening: is a DPIA required?

The ICO lists "invisible processing" (data aggregation, re-use of public data) and "data matching" as likely high risk, needing a DPIA when combined with another criterion (landscape brief §5.2).

| Criterion | Public directory (A) | Broker CRM (B) |
|---|---|---|
| Invisible processing (aggregating public sources without telling people) | Yes, until the Art 14 notice goes out (J7, ~13 Nov 2026) | Yes |
| Data matching across sources | Organisations only, not people | Names matched to organisations |
| Large scale | ~1,500 organisations; few personal data items each | Hundreds of named officers at most |
| Special category data | No (faith / political / LGBTQ+ societies listed, members not) | Risk: naming the officers of such societies can reveal affiliation |
| Innovative technology | LLM extraction via a third-party provider | Same |
| Vulnerable people | No (adult students) | No |

**Outcome:** A — a full DPIA is not strictly required but this lite assessment is kept because of aggregation and the LLM. B — required; this document is its first version and must be extended before any outreach from the CRM.

## 2. Data flows

```
public pages / feeds ──(polite fetcher, robots.txt; D3 society override)──▶ var/cache (pipeline host, 90 d)
        │                                                  │
        │                                     free text ───┴──▶ cliproxy relay ──▶ OpenAI (LLM)
        ▼                                                                │
  parser claims ──(D1 redaction: names → roles, original → valueRaw)──▶ /api/pipeline/* ──▶ Convex ◀── quote-checked LLM claims
                                                    │
Joshua's @cam.ac.uk list mail ──▶ Resend inbound ──▶│ inboundEmails (internal, 90 d) ──▶ LLM (events only)
                                                    │
                       public projection only ──────┴──▶ Next.js on Vercel ──▶ visitors
                       broker tables (requireBrokerUser) ──▶ /dashboard (Joshua only)
request form ──▶ listingRequests (internal) ──▶ review by Joshua
```

## 3. Risks and measures

Likelihood (L) and severity (S): low / medium / high. "Residual" is after the measures.

| # | Risk | L | S | Measures (in place unless marked **todo**) | Residual |
|---|---|---|---|---|---|
| R-1 | A personal CRSid address or a named officer appears on the public site | M | M | Public projection removes `personal_crsid` emails and personal role emails (`convex/lib/projections.ts`, tested in `convex/public.test.ts`); `people` is broker-only; pipeline never writes names into public fields (AGENTS.md data honesty rules). **D1 redaction:** names of private individuals in descriptions, notes, event and session titles, venues and price notes are replaced by roles before any claim is posted (`extract/redact.py`: LLM pass with deterministic checks; a rule fallback that withholds a text it cannot make safe; a title it cannot make safe keeps its event out; known committee names always removed, and never published as speakers; profile links and URLs spelling a name cut). Room-booking calendar entries are not events, and feed text keeps only the organisation's own addresses (2026-10-10, after 21 Newnham MCR bookings with bookers' names, webmail addresses and CRSids were found published on dev) | Low |
| R-2 | Inaccurate data presented as fact (stale contacts, wrong officers) | H | L | Per-fact status / source / date; LLM values without a verified quote shown as `inferred`; conflicts shown with both readings; annual refresh; correction form | Low |
| R-3 | Societies do not know they are listed (invisible processing) | H | M | Art 14 notice to every listed role address by ~13 Nov 2026 (J7) with claim / correct / remove links and the right to object; public privacy notice; About page | Low once J7 is done |
| R-4 | LLM provider processes personal data in list mail and pages (US transfer; consumer-plan terms, possible use for training) | M | M | Only page text and list-mail text needed for extraction are sent; talks.cam never sent; list mail is cleaned deterministically before extraction — quoted replies, forwarded headers, signatures and list footers cut out, addresses and phone numbers redacted (`pipeline/.../extract/mail_text.py`, tested on fixtures); **todo:** turn off model-training on the ChatGPT account used by cliproxy; record the transfer basis (record-of-processing, transfers) | Medium until the todos are done |
| R-5 | Mailing-list content leaks to the public | L | M | Events from mail default to `cam_only`; `cam_only` needs a verified `@cam.ac.uk` session; a mailing-list event has no public `sourceUrl`; raw mail never in a public query; bodies deleted 30 days after processing, rows after 90 (automated, `retention.md` R4) | Low |
| R-6 | Broker CRM used for unsolicited marketing (PECR reg 22) | M | M | PECR subscriber type per address, default individual; no marketing without consent; suppression list; identify sender and give an opt-out; introductions relay, no export (LIA §B) | Low |
| R-7 | Officers of faith / political / identity societies revealed (Art 9) | L | H | No names in public fields; no inference about people; broker rows private and time-boxed | Low |
| R-8 | A removed listing is re-created by the next harvest | M | M | Suppression list (`suppressions`; listing, field, address hash or person): enforced when a removal is accepted, filtered by the pipeline before every load, refused by every ingestion route, stripped from the public projection (`convex/lib/suppressions.ts`, `pipeline/.../suppressions.py`, tested on both sides) | Low |
| R-9 | Unauthorised access to broker data | L | H | `requireBrokerUser` on every broker function, `BROKER_EMAILS` allowlist, verified email only; secrets out of Git; Convex and Vercel access protected by Joshua's accounts (2FA **todo:** confirm on all four providers) | Low |
| R-10 | Scraping beyond what sites allow (terms, robots, Computer Misuse Act for gated pages) | M | M | **Decision D3 (2026-10-08):** society websites, Linktree pages, Google Calendar ICS feeds societies link, SU `/asset/` files linked from a profile and college / JCR / MCR society lists are read even where robots.txt or an AI opt-out disallows; the operator's reasoning is that societies publish these pages to be found. Limits: one policy (`sources/policy.py`) with the URL classes fixed and tested; never talks.cam or tbc.xyz; never non-society pages (their robots.txt holds); the University Events API never fetched; each override recorded on the `sources` row. Unchanged: Crawl-delay and the minimum interval, one request per host, honest User-Agent, no Raven / members-only / 403 pages, no decoding of obfuscated emails, no Meta / LinkedIn scraping. A site owner who objects can use the request form; **todo:** a per-host opt-out list the policy checks | Low–medium |
| R-11 | Over-retention | M | L | `retention.md` schedule, automated for R3–R8 and R10 (daily `retention-daily` cron; `prune-cache` on the pipeline host); R1 and R9 by hand | Low |
| R-12 | Unredacted originals (with names) kept in the internal claim log | M | L | `fieldClaims.valueRaw` is internal: no query returns it, public or broker; kept with the entity (`retention.md` R2), and cleared from a free-text claim as soon as a newer reading supersedes it (2026-10-10); claims set aside by a removal keep no value, original or quote | Low |

## 4. Sign-off

- Measures marked **todo** are tracked in `retention.md` (open items) and the task list; the remaining R-4 todos (training opt-out, transfer basis) must be closed before the phase-2 outreach. R-8 is closed (suppression list, 2026-10-09).
- Re-assess B before any CRM data is used to contact people outside role addresses.
- Owner: Joshua Fehn. Next review: July 2027, or earlier on any change listed at the top.
