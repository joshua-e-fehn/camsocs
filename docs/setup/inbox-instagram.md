# Setup: list-mail inbox, Instagram and the sign-up worklist (J3, J4, J5)

These are Joshua's steps for PLAN.md J3, J4 and J5. The code is done and waits for them. Until they are done:

- the `inbox` stage finds no mail;
- the `instagram` stage logs "skipped: not configured";
- `camsocs worklist` still works, since it needs only Convex.

Background and the rules each source follows: `docs/source-research.md` §16 (inbox), §17 (Instagram) and §20 (Sympa). Facts below were checked against the providers' docs on 2026-10-07; if a screen looks different, the provider's current docs win.

**Secrets:** never paste a value into a chat, a commit or a log. Each one goes in exactly one place: Convex env or `pipeline/.env`.

## J3: Resend (sending domain and an inbound subdomain)

Resend sends the `@cam.ac.uk` sign-in links (T10) and receives the redirected list mail (T7).

**1. Pick two subdomains** of your domain at IONOS (shown below as `<domain>`).
- One for sending, e.g. `mail.<domain>`.
- One for receiving, e.g. `inbound.<domain>`.

Use subdomains, not the root domain. A receiving domain sends *all* its mail to Resend, and Resend recommends subdomains for sending reputation too. If you already have MX records on `<domain>`, a subdomain is the only safe choice.

**2. Add the domains in Resend.** In the Resend dashboard, go to Domains → Add Domain, then:
- enter `mail.<domain>` and choose region Ireland (`eu-west-1`), closest to Cambridge;
- add `inbound.<domain>` the same way, then switch **Receiving** on in its domain page.

**3. Add the DNS records at IONOS.** Go to my.ionos.com → Domains → `<domain>` → DNS → Add record. Copy every *value* from Resend's Records tab, and type only the part before `<domain>` as the name.

| For | Type | Name (IONOS) | Value | Priority |
|---|---|---|---|---|
| sending (SPF) | MX | `send.mail` | the MX value Resend shows (`feedback-smtp.<region>.amazonses.com`) | 10 |
| sending (SPF) | TXT | `send.mail` | the TXT value Resend shows (`"v=spf1 include:amazonses.com ~all"`) | — |
| sending (DKIM) | TXT | `resend._domainkey.mail` | the DKIM value Resend shows | — |
| receiving | MX | `inbound` | the receiving MX value Resend shows (`inbound-smtp.<region>.amazonaws.com`) | 10 |
| (recommended) DMARC | TXT | `_dmarc.mail` | e.g. `v=DMARC1; p=none;` | — |

Then press **Verify DNS Records** in Resend. Verification usually completes within minutes and can take up to 72 hours. Resend receives mail only if its MX record has the lowest priority value on `inbound.<domain>`. Do not reuse a priority that another record already has.

**4. Create the webhook.** In Resend, go to Webhooks → Add Webhook.
- URL: `https://hushed-rhinoceros-215.convex.site/api/inbound/email` for dev. For production, use the production deployment's `.convex.site` host.
- Event type: `email.received` only.

Open the webhook's page and copy its **signing secret** (`whsec_…`).

**5. Create an API key** with **Full access**. The Receiving API refuses a sending-only key.
- If you want least privilege, keep a separate sending-only key for T10 as `RESEND_API_KEY`.
- Put the full-access key in `RESEND_INBOUND_API_KEY`. The webhook prefers it and falls back to `RESEND_API_KEY`.

**6. Choose the inbound address.** Any address at `inbound.<domain>` reaches the webhook. Pick an unguessable local part, e.g. `lists-<random>@inbound.<domain>`, and allow only that one (step 7). Then a stranger who learns the domain cannot post events.

**7. Set the Convex env** (dev shown; add `--prod` for production):

```bash
cd webapp && unset CONVEX_DEPLOY_KEY
bunx convex env set RESEND_WEBHOOK_SECRET 'whsec_…'          # step 4
bunx convex env set RESEND_INBOUND_API_KEY 're_…'            # step 5 (full access)
bunx convex env set INBOUND_EMAIL_RECIPIENTS 'lists-<random>@inbound.<domain>'
# Only if you also post mail from another provider (generic JSON, Bearer auth):
# bunx convex env set INBOUND_EMAIL_SECRET "$(openssl rand -hex 32)"
```

The route is deployed with the T7 code. `bunx convex dev --once` pushes it to dev; the integrator runs it.

**8. Test.** Send a mail with a subject from any mailbox to the inbound address.
- Resend → Emails → Receiving shows it.
- The webhook log shows a `200 {"stored":true}`. `{"ignored":"recipient"}` means step 6 and step 7 disagree.
- `pixi run pipeline -- sync --stages inbox` then marks it `skipped` ("not list mail"), which is correct for a test mail.

## J4: the Outlook rule on your @cam.ac.uk mailbox, then the worklist

**1. Create the rule** in Outlook on the web (outlook.office.com). Go to Settings → Mail → Rules → **Add new rule**.
- Name: `camsocs list mail`.
- Condition: **Message header includes** → `List-Id`. Sympa, Mailchimp and Google Groups all set this header.
- Action: **Redirect to** → the inbound address from J3 step 6. Use *Redirect*, not *Forward*: a redirected message keeps its original sender and headers, `List-Id` included, which is how the pipeline knows which society sent it. A forwarded message arrives from you with the list's headers lost. The pipeline can read an inline-forwarded header block as a fallback, but it is weaker.
- Keep "Stop processing more rules" off, so the mail still lands in your inbox.

If you ever forward by hand, forward *as attachment* or redirect, for the same reason.

**Check the first redirected list mail** in Resend's webhook log. It should answer `{"stored":true}`. If it answers `{"ignored":"recipient"}`, the redirect did not name the inbound address in any delivery header. In that case, unset `INBOUND_EMAIL_RECIPIENTS` (`bunx convex env remove INBOUND_EMAIL_RECIPIENTS`): the Svix signature still proves each mail came through your Resend inbox, and the unguessable address keeps strangers out.

**2. External forwarding.** Cambridge Exchange Online allows external forwarding (Engineering IT help: https://help.eng.cam.ac.uk/email/forwarding-your-email/). If redirected mail never reaches Resend, check whether Microsoft has blocked automatic forwarding for the tenant. In that case, ask UIS (or Engineering IT) about the outbound spam policy for your mailbox.

**3. Work through the sign-up list.** Run:

```bash
pixi run pipeline -- worklist             # needs CONVEX_HTTP_URL + PIPELINE_API_KEY
```

It writes `var/reports/mailing-list-worklist.csv`, best first.
- **sign_up** is a URL to open, or a Sympa command: `send 'subscribe soc-xyz' to sympa@lists.cam.ac.uk`. Put the command in the subject or the first line, from your @cam.ac.uk address. Most lists need the owners' approval (UIS help, https://help.uis.cam.ac.uk/node/1444).
- **why** says why the organisation is ranked there: active, no other event feed, the list on record (or "matched by name (check it)").
- `var/reports/sympa-soc-lists.csv` holds every public `soc-` list name and description, with the organisation it was matched to.

Organisations already mailing the inbox drop off the list after the next `inbox` run. Re-run the worklist after each harvest.

## J5: Meta, for Instagram Business Discovery

Business Discovery reads public posts of other *professional* Instagram accounts. It asks through your own professional account, so you need four things: that account, a Facebook Page, a developer app and a token. No App Review is needed while the app stays in Development mode, because the only user is you, the app's admin.

**1. Make your Instagram account professional.**
- In the Instagram app, go to Settings → Account type and tools → Switch to professional account.
- Choose Creator or Business. Either works.

**2. Link a Facebook Page.**
- Create a Page (any name, e.g. "camsocs") at facebook.com/pages/create.
- In the Page's settings, open Linked accounts → Instagram, and connect the professional account.

**3. Create the developer app.**
- At developers.facebook.com, open My Apps → Create App and choose the business-type app.
- Under Settings → Basic, fill the required fields. If Meta asks for a privacy policy URL, use the site's privacy page (T9/T13).
- Add the product **Facebook Login for Business**. Leave its settings at their defaults.

**4. Get a token.**
- Open the Graph API Explorer (developers.facebook.com/tools/explorer) and select your app.
- Under "User or Page", choose **Get User Access Token** and tick these permissions: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`, `pages_show_list`.
- Grant them for the Page from step 2.

**5. Find your Instagram user id.** In the Explorer, run:
- `GET me/accounts`. Note the Page `id`.
- `GET <page-id>?fields=instagram_business_account`. The result's `instagram_business_account.id` is `META_IG_USER_ID`.

**6. Exchange for a long-lived token.** A long-lived user token lasts about 60 days. Run this locally, with the app id and secret from Settings → Basic; the result's `access_token` is `META_ACCESS_TOKEN`:

```bash
curl -G "https://graph.facebook.com/v25.0/oauth/access_token" \
  --data-urlencode "grant_type=fb_exchange_token" \
  --data-urlencode "client_id=<app-id>" \
  --data-urlencode "client_secret=<app-secret>" \
  --data-urlencode "fb_exchange_token=<token from step 4>"
```

**7. Configure the pipeline** in `pipeline/.env`:

```bash
META_IG_USER_ID=1784…            # step 5
META_ACCESS_TOKEN=EAA…           # step 6 — secret
# META_GRAPH_VERSION=v25.0       # optional; the default
```

`pixi run pipeline -- status` should now show `Meta IG user: 1784…` and `Meta token: set`.

**8. Run it.** Use `pixi run pipeline -- sync --stages instagram --limit 5`.
- The stage checks at most 100 handles a run (fewer with `--limit`), stops at Meta's rate limit, and resumes next run.
- Handles of accounts that are not professional are retried after 14 days.

**Renewal.** About every 60 days the token expires. The stage then fails with `TokenInvalid: …`; repeat steps 4 and 6 and replace `META_ACCESS_TOKEN`.
