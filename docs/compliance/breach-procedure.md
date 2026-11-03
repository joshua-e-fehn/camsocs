# Personal data breach procedure (UK GDPR Arts 33 and 34)

Controller: Joshua Fehn. Written 2026-11-03 (ENG-34, after the launch audit of 2026-11-02 found none). Review each July with the rest of `docs/compliance/`, and after every breach. This is a working procedure, not legal advice.

A personal data breach is a breach of security that leads to personal data being destroyed, lost, changed, disclosed or accessed without authority, by accident or on purpose (Art 4(12)). It is about **security**, not only about leaks: a deletion we did not mean to make, or a key someone else could use, can be one.

## Security contact

- **camsocs@joshua-fehn.de** (`SECURITY_CONTACT_EMAIL`, `webapp/lib/site.ts`; the same alias as the privacy contact). Published on `/about#security`, in `/privacy` ("Who is responsible") and in `/.well-known/security.txt` (RFC 9116: the static `webapp/public/.well-known/security.txt`, held equal to `webapp/lib/security-txt.ts` by its test).
- ⚠ `security.txt` carries `Expires` (`SECURITY_TXT_EXPIRES`, now 2027-09-01). Renew it in the July review, before it lapses.
- A report that arrives through the request form, a GitHub issue or a Slack message counts the same: the clock below starts when Joshua knows.

## What counts here

The camsocs-specific cases, most likely first. The data at risk is listed in `record-of-processing.md` (P1–P12).

| Case | Personal data at risk | Where to look |
|---|---|---|
| A key leaks: `CONVEX_DEPLOY_KEY`, `PIPELINE_API_KEY`, the cliproxy key, the deploy key, a PostHog personal key, `BETTER_AUTH_SECRET`, Google or Resend secrets (in a commit, a log, a screenshot, a chat with a model) | Whatever the key reaches: broker tables (named officers, P4), list mail (P3), requests (P6), accounts (P7) | GitHub secret scanning, `git log -p`, the place it was pasted |
| Broker rows, list mail, requests or `fieldClaims.valueRaw` reach a public query, a page or PostHog | P3, P4, P6, unredacted originals (D1) | `convex/lib/projections.ts`, PostHog events, the public site |
| A private individual's name or CRSid is published (D1 redaction missed one) | The person's name or address | The listing, its `fieldClaims` |
| A `cam_only` event shown to anyone without a verified `@cam.ac.uk` session | List mail content (P3) | `convex/events.ts` |
| A batch of the Art 14 / outreach email (J7) goes to the wrong addresses, or with addresses visible to each other (To/Cc instead of Bcc or one by one) | Recipients' addresses, the organisations they act for | The sent folder |
| The VPS host (Hostinger, `srv1608974`) is compromised, or Mya's agent reaches the harvest's files | `var/cache`, `var/staging` (pages with names, list mail for 30 days), `pipeline/.env.prod` | `docs/ops-vps.md` §6, the journal, `last` |
| The laptop is lost or stolen | `var/`, `pipeline/.env`, `webapp/.env.local`, browser sessions | — |
| An account is taken over: GitHub, Vercel, Convex, Google, PostHog, 1Password, the joshua-fehn.de mailbox | Everything that account reaches | The provider's security log |
| Data is deleted or changed without meaning to (a wrong migration, a wrong `clean-events --apply`, an unintended purge) | Listings, requests, suppressions (a lost suppression can re-publish something someone asked to remove) | Convex dashboard, logs |
| A processor tells us of a breach on its side (Convex, Vercel, Hostinger, Resend, PostHog, Google), or OpenAI on its side | Whatever it holds for us | Its notice |

Not a breach: a correction request about an inaccurate fact (that is Art 16, handled as a request), a fetch blocked by robots.txt, an outage that loses nothing.

## 1. Detect and record (at once)

1. Write down the time Joshua became **aware** (reasonably certain that a security incident has compromised personal data). The 72 hours run from here, including weekends.
2. Open a log entry (template below) before doing anything else. Keep the log **outside Git**: the repository is public. Keep it also out of reach of the agents: not in the 1Password Mya vault, which the `mya-op` service account reads unattended, nor anywhere on the VPS or in a folder an agent works in, because the log holds the details of breaches and some of the cases above are an agent or a model reaching the data. **Joshua to choose** where it lives (for example a secure note "camsocs breach log" in his personal vault) and record the choice here. Entries name people only where it is needed, and then by key (org key, person key), not by name.

## 2. Contain (within the first hours)

Stop it getting worse first, then find out how bad it is.

- **A leaked key:** rotate it at once (`docs/ops-vps.md` §7 for the pipeline, cliproxy and PostHog keys; Convex and Vercel in their dashboards; `bunx convex env set --prod` for Convex env values; never export `CONVEX_DEPLOY_KEY` in a shell). Then check what was done with it: Convex logs and function calls, Vercel deployments, GitHub's audit log.
- **The VPS:** stop the timers and any run in progress (`docs/ops-vps.md` §4 "Stop": `systemctl disable --now camsocs-harvest-events.timer camsocs-harvest-full.timer camsocs-monitor.timer`), revoke the deploy key in GitHub and the camsocs key in cliproxy, rotate `PIPELINE_API_KEY`; keep the logs for the assessment before anything is wiped.
- **Data on a public page or in PostHog:** take it down (a field or listing suppression, `convex/lib/suppressions.ts`; a hotfix of the projection), then delete the copies (PostHog: delete the events or the person's data; Vercel and Convex caches clear on redeploy).
- **A mis-sent email:** ask the recipients to delete it, and stop the remaining batches.
- **An account:** change the password, sign out all sessions, check 2FA (DPIA-lite R-9), revoke OAuth grants and tokens.
- **The laptop:** wipe it remotely if possible; rotate every key in `pipeline/.env`, `pipeline/.env.prod` and `webapp/.env.local`; sign out of every provider.

## 3. Assess the risk (within 24 hours)

Answer, in the log:

- What personal data, about whom (which activity, P1–P12), and roughly how many people?
- Was it only exposed, or actually seen, copied, changed or lost? Can we tell?
- Is it already public anyway (a role address a society publishes) or private (a name in the CRM, a list message, a request with someone's email)?
- Could it hurt anyone? Special care for: officers of faith, political, LGBTQ+, ethnic, national, health or disability societies (their names can reveal those things, `dpia-lite.md` §5), list mail, request messages (complaints may say more than they should), sign-in emails.
- Is it contained? Could it recur?

Rate the risk to people's rights and freedoms: **none / unlikely**, **risk**, or **high risk**. Use the regulator's breach self-assessment if unsure (ico.org.uk, "report a breach").

## 4. Tell the Information Commission within 72 hours (Art 33): the test

- **Notify** the Information Commission (the Information Commissioner's Office, ICO, until 30 September 2026) unless the breach is **unlikely** to result in a risk to anyone's rights and freedoms. When in doubt, notify.
- **Deadline:** within 72 hours of becoming aware (step 1). If the facts are not all known, report what is known and add the rest later (Art 33(4)). If it is late, say why.
- **How:** its online breach report form on ico.org.uk, or its helpline (0303 123 1113), as the controller, with the registration number (`ICO_REGISTRATION_NUMBER`, once J6 is paid).
- **What to give** (Art 33(3)): what happened and when; the categories and rough numbers of people and records; the contact (camsocs@joshua-fehn.de); the likely consequences; what was done and will be done to contain it and limit harm.
- Unlikely-to-risk examples, which need only the log: a key leaked and rotated within minutes with logs showing no use; a role address published by its own society shown once more.

## 5. Tell the people affected (Art 34)

- If the breach is likely to result in a **high risk** to them, tell them **without undue delay**, in plain words: what happened, the likely consequences, what we did, what they can do (for example, watch for phishing that uses the leaked list), and who to contact.
- Write to each person where we have an address; where we do not, or it would take disproportionate effort, publish a notice on the site instead (Art 34(3)(c)).
- Not needed if the data was made unintelligible (encrypted, and the key did not leak), or the risk has since been removed (Art 34(3)(a)–(b)). Record why in the log.
- A processor's breach: it must tell us without undue delay (Art 33(2)); the decisions above stay ours.

## 6. Close and learn

- Fix the cause, add a test or a guard where code allowed it, and note the change in the log and, if a decision changes, in `PLAN.md`.
- Update `dpia-lite.md` (the risk's likelihood, a new measure) and this file if a step did not work.
- Keep every log entry, notified or not (Art 33(5)), for **three years** after the entry is closed, then delete it.

## Log template

Copy for each incident, including those not reported to the Information Commission.

```text
Ref:                 BR-YYYY-NN
Aware at:            YYYY-MM-DD HH:MM (Europe/London) — how we found out
Happened (if known): YYYY-MM-DD HH:MM to YYYY-MM-DD HH:MM
What happened:       one or two sentences; no names
Data and people:     activity (P1–P12), categories of data, rough number of people and records; keys, not names
Contained at:        YYYY-MM-DD HH:MM — what was done (keys rotated, data taken down, …)
Risk:                none/unlikely | risk | high risk — why
Regulator notified:  yes, YYYY-MM-DD HH:MM, reference … | no — why not
People told:         yes, YYYY-MM-DD, how | no — why not (Art 34(3))
Cause and fix:       root cause; the change that stops it recurring (commit, setting)
Closed:              YYYY-MM-DD — by Joshua Fehn
```
