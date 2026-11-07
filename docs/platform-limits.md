# Platform limits and spend caps (ENG-37)

What each paid or quota-bound service camsocs runs on allows, what is set today, and what Joshua should set. Read live on **2026-11-04** (sources named per row); re-read before relying on a number, and at the annual review each July. Prices are in the provider's currency, excluding VAT.

## Summary

| Service | Plan (live) | Cap set today | This period so far | Should be |
|---|---|---|---|---|
| Vercel (team `joshuas-projects-dc895e08`) | **Pro** since 2026-11-02 23:16 UTC; period 2 Nov – 2 Dec | **No spend budget** (`vercel billing budgets`: "No budgets found") | $3.04 of the $20 monthly usage credit (plus the $20 Pro licence) | a budget with notifications, §1 |
| Convex (team `joshua-fehn`, id 305069) | **Convex Professional**, $25 a member a month; next period from 2026-11-29 | Spending limits: warn at **$10**, disable at **$20** of usage beyond the plan; state `Running` | usage state `Default` (inside the plan) | keep, but read §2 on what "disable" hits; **turn on backups** |
| PostHog (EU Cloud, project 330133) | free plan (docs/deploy.md "PostHog (monitoring)") | none needed on the free plan | not readable here (needs the personal key) | stay on free; §3 |
| Hostinger VPS `srv1608974` | KVM, 8 vCPU / 32 GB / ~387 GB, shared with Mya | fixed price | — | auto-renew on, weekly backups, §4 |
| IONOS (camsocs.uk) | .uk registration, registered 2026-10-31, **expires 2027-10-31** | — | — | auto-renew decided by docs/continuity.md; Nominet validation (ENG-43) |
| cliproxy (ChatGPT Codex Pro subscription) | Joshua's subscription | weekly model quota; no throttling by decision | — | nothing to set |
| GitHub (`joshua-e-fehn/camsocs`, public) | free; Actions free for public repositories | — | — | security features on (ENG-43) |

## 1. Vercel

Read with `vercel api /v2/teams/team_BPZRUyOixqP7I7QyKQ5LoKG5` (`billing.plan: pro`, `status: active`, `period` 2026-11-02 → 2026-12-02), `vercel billing usage` and `vercel billing budgets` (CLI 65.11.0; the installed 50.44.0 lacks `billing`, run `bunx vercel@latest …`), and the project config.

- **Plan.** Pro, one licence ($20 a month) with a **$20 monthly usage credit**. Usage 2–4 Nov: $3.04, mostly Build CPU minutes ($2.30 for 1,040 minutes: every merge to `main` builds and deploys Convex; preview builds of PRs count too), then ISR writes ($0.28), Observability events, Fluid CPU, function storage. Requests and data transfer are cents (8.1k CDN requests, 0.19 GB). At this pace a month costs roughly the credit; a burst of merges or a crawler storm is what pushes past it.
- **On-demand spend has no cap.** No Spend Management budget is set, so anything beyond the $20 credit is billed without limit. The bot policy (docs/deploy.md "Bot policy") is the only brake: firewall denies are free, but the rate-limit rule bills every request it lets through ($0.50–0.80 per million) and functions bill by CPU.
- **Other limits that matter:** one concurrent build (`resourceConfig.concurrentBuilds: 1`; a second merge queues), elastic standard build machine; functions in `iad1` with Fluid compute; skew protection 12 hours (`skewProtectionMaxAge: 43200`); preview deployments behind Vercel Authentication (`ssoProtection: all_except_custom_domains`); Web Analytics spend limit $500 (`billing.controls`; camsocs does not use Vercel Web Analytics, so it never applies here).
- **Joshua should set** a budget: `bunx vercel@latest --scope joshuas-projects-dc895e08 billing budgets set --amount 50 --pause`, or Vercel → Team Settings → Billing → **Spend Management** → on, amount **$50** (on-demand beyond the credit, per billing cycle), notification e-mails at 50/75/100 %, and "Pause production deployments" **on**. Recommendation: pause on. At 100 % every project of the team stops serving (camsocs.uk shows Vercel's paused page) until he raises the amount or the cycle ends: for a portfolio site an outage is cheaper than an open bill, and $50 is about five times the expected usage, so only a runaway gets there. Without pause he gets the e-mails and the bill. Check: `bunx vercel@latest billing budgets --scope joshuas-projects-dc895e08` lists the budget.

## 2. Convex

Read with the dashboard API under Joshua's CLI login (`/api/dashboard/teams/305069/get_orb_subscription`, `get_entitlements`, `get_spending_limits`, `usage/team_usage_state`; `/v1/projects/3168210/list_deployments`).

- **Plan.** Convex Professional, active, $25 per member per month, one member; invoices once usage passes $10 (`invoicingThreshold`). Included per **team** per month (shared with the other projects on the team, `relio` and `thirtysecond`): 25 M function calls, 50 GB database storage, 50 GB database bandwidth, 100 GB file storage, 50 GB file bandwidth, 250 action compute (GB-hours), 1 GB vector storage, 50 k search queries; periodic backups and up to 50 cloud backups; log streaming and streaming export; 300 deployments; audit log 90 days.
- **Deployments.** Production `cheerful-bandicoot-511` and dev `hushed-rhinoceros-215`, both `aws-us-east-1`, class `s256`.
- **Spending limits (set):** warning at $10 and **disable at $20** of usage beyond the plan, state `Running`. "Disable" is **team-wide**: if any project on the team (camsocs, relio, thirtysecond) runs the bill past $20 of overage, every deployment stops answering, camsocs.uk's data included, until Joshua raises the limit (Team settings → Billing → Spending limits). Today's usage is well inside the plan (`usageState: Default`). Keep the limit; if relio or thirtysecond ever grows, move it to its own team so camsocs cannot be switched off by another project's bill.
- **Backups: none.** Production's periodic backup is not configured (`get_periodic_backup_config` → `null`) and it holds **no** cloud backup (`list_cloud_backups` → `[]`). The broker CRM, listing requests, suppressions and accounts exist only there (docs/rollback.md §4). Joshua should turn on **daily** backups (§6) and test one restore into dev (ENG-44).

## 3. PostHog

One project, `camsocs` (id 330133), on **EU Cloud**, on the free plan (one project allowed; data kept up to a year, docs/compliance/retention.md R12). The plan's allowances are on posthog.com/pricing (the page did not render for a text read on 2026-11-04, so no figures are copied here). PostHog's billing docs (posthog.com/docs/billing/limits-alerts, read 2026-11-04): the organisation owner gets e-mails at **80 % and 100 %** of the free allotment; on a paid plan a per-product **billing limit** stops ingestion at the limit and the data over it is lost.

- What can grow: `$pageview`/`$pageleave` (consented visitors only), `$exception` (capped at 10 per error per function instance, then one per 10 s; docs/deploy.md "Error tracking"), `ics_feed_fetched` (edge-cached, so at most one per feed URL an hour), `page_visit` (one per browser page load of a public page; bots that announce themselves or send no Fetch Metadata are not counted), the harvester's run events and one `$ai_generation` per model call. All small.
- **Stay on the free plan.** A paid plan raises retention to 7 years, which retention.md R12 and `/privacy` would then have to say (the ⚠ in R12). If an upgrade is ever needed: set every product's billing limit at the same time (Organisation → Billing → each product → Set billing limit), smallest first ($0 for products not used: session replay, feature flags, surveys, data warehouse).
- Check now and then: Organisation settings → Billing shows the month's usage per product against the free allowance.

## 4. Hostinger VPS

`srv1608974` (Ubuntu 24.04): a Hostinger KVM VPS with 8 vCPU, 32 GB RAM and about 387 GB disk, shared with Mya's containers and cliproxy (infrastructure notes of 2026-10-06; Claude does not log in to the host, docs/ops-vps.md §2). camsocs uses it for the harvest (daily up to 2 h, weekly up to 6 h), the hourly monitor, and `/opt/camsocs/var` (page cache and staging, pruned at 90 days, R7). A fixed-price plan: no usage billing, so no spend cap applies; the risks are **non-renewal** and **loss of the host**.

- Joshua should check in hPanel (https://hpanel.hostinger.com → VPS → `srv1608974` → **Plan details / Billing**): the plan's expiry date and that **auto-renewal** is on with a valid card.
- Backups: hPanel → VPS → **Backups & Monitoring** → weekly backups (or snapshots). camsocs keeps nothing on the host that cannot be rebuilt (the checkout is Git, the cache re-fetches, the secrets are in 1Password and the env files can be written again), so for camsocs a lost host costs a reinstall (docs/ops-vps.md §2) and a slower first run without the cache, not data. Mya's data is the reason to back the host up.

## 5. Domain and the rest

- **camsocs.uk** at IONOS (registrar tag `1AND1`), name servers `ui-dns`, registered 31 Oct 2026, **expires 31 Oct 2027**. Nominet WHOIS on 2026-11-04: "Registrant contact details waiting to be checked" — a .uk domain whose registrant cannot be validated can be suspended, so finish the validation IONOS or Nominet asks for (ENG-43). Whether to auto-renew in 2027 is a docs/continuity.md decision; until then leave IONOS's auto-renew on so the name is never lost by accident (a lapsed name can be registered by anyone and made to look like camsocs).
- **Contact mail** is CAMsocs' own Google Workspace on camsocs.uk (D11, Business Starter, one licence: joshua@camsocs.uk with the aliases hello@, privacy@, security@, requests@, dmarc@), independent of Cambridge and of joshua-fehn.de. Gmail sending limit: 2,000 a day for the user; Apps Script mail merges 1,500 recipients a day. DNS stays at IONOS: MX `smtp.google.com`, SPF Google only, DKIM selector `google`, DMARC `p=none` with reports to dmarc@.
- **cliproxy** runs on Joshua's ChatGPT subscription: no per-call cost, a weekly quota (exhausting it is acceptable by decision); when it runs out the model stages fail and alert, the parser stages and talks are unaffected.
- **GitHub**: public repository, Actions free; nothing to cap.

## 6. Joshua's settings (all need his sign-in)

1. **Vercel spend budget** — §1 (Team Settings → Billing → Spend Management; $50, notifications, pause on).
2. **Convex daily backups** — Convex dashboard → project `camsocs` → **Production** → **Backup & Restore** → *Backup now* once, then **Periodic backups** → Daily, at 03:00 (Europe/London; before the 04:15 UTC retention cron and the 04:30 harvest) → save. Check: the page lists the backup and the schedule. Then restore that backup into **dev** (Backup & Restore on the dev deployment → Restore from another deployment's backup, if offered; otherwise download it and `bunx convex import --replace-all <zip>` on dev only) and open `/dashboard` on a local dev server to see the CRM rows (ENG-44).
3. **Hostinger** — §4 (auto-renewal, backups).
4. **Mark `CONVEX_DEPLOY_KEY` sensitive in Vercel** — docs/key-rotation.md "Convex deploy key" (rotate it and re-add it as Sensitive in the same pass).
5. **Give the "Mya token" an expiry** — docs/key-rotation.md "Vercel access tokens".
