# Setup: list-mail inbox, Instagram and the sign-up worklist (J3, J4, J5)

These are Joshua's steps for PLAN.md J3, J4 and J5. The code is done and waits for them. Until they are done:

- the `inbox` stage finds no mail;
- the `instagram` stage logs "skipped: not configured";
- `camsocs worklist` still works, since it needs only Convex.

Background and the rules each source follows: `docs/source-research.md` §16 (inbox), §17 (Instagram) and §20 (Sympa). Facts below were checked against the providers' docs on 2026-10-07; if a screen looks different, the provider's current docs win.

**Secrets:** never paste a value into a chat, a commit or a log. Each one goes in exactly one place: Convex env or `pipeline/.env`.

## J3: Resend sends, Gmail receives (D12)

**Done 2026-11-08** (D12). Resend's free plan counts received mail against the same 100-a-day quota as sent mail, so the list mail arrives on CAMsocs' own Google Workspace (D11) and Resend only sends the `@cam.ac.uk` sign-in links (T10). The Resend receiving code (Svix webhook, Receiving API) stays in place, unused.

**Sending (Resend).**
- Domain `mail.camsocs.uk`, region Ireland (`eu-west-1`). DNS at IONOS: DKIM TXT `resend._domainkey.mail`, SPF MX and TXT on `send.mail`, CNAME `rsend.mail`. The root domain's Google MX is untouched; DMARC comes from `_dmarc.camsocs.uk` (relaxed alignment covers the subdomain).
- Convex production: `RESEND_API_KEY` is a **sending-only key limited to `mail.camsocs.uk`** (Resend key "camsocs-convex-prod"), `RESEND_FROM` is `CAMsocs <sign-in@mail.camsocs.uk>`. The full-access account key stays in 1Password (Mya vault, "Resend API").
- Free plan: 100 mails a day, 3,000 a month; the sign-in throttle (`convex/authEmail.ts`, 60 an hour overall) keeps a flood well inside it.

**Receiving (Gmail, the camsocs.uk Workspace).**
- An unguessable alias of joshua@camsocs.uk, `lists-<random>@camsocs.uk` (the value is in 1Password, Mya vault, "CAMsocs list-mail relay", and in `INBOUND_EMAIL_RECIPIENTS`; keep it out of the repository).
- A Gmail filter, `deliveredto:<alias>`: label **Lists**, skip the inbox. The agents' mail tool hides that label (mya-workstation `camsocs_mail`): list mail is never shown to an agent.
- The relay, `camsocs-lists-relay.timer` on the VPS (every 5 minutes, mya-workstation `camsocs_mail/lists.py`), posts each new Lists message to `POST <prod>.convex.site/api/inbound/email` in the provider-agnostic shape with `Authorization: Bearer $INBOUND_EMAIL_SECRET`, then labels it **Lists/relayed** (4xx: **Lists/rejected**; 5xx or no network: tried again next run; the route dedupes on `Message-ID`). Settings: `/docker/hermes-agent-vspa/data/secrets/mya-camsocs-mail/lists-relay.env` (0600 root).
- Convex production: `INBOUND_EMAIL_SECRET`, `INBOUND_EMAIL_RECIPIENTS` (the alias), `INBOUND_TRUSTED_AUTHSERV_IDS=mx.microsoft.com,mx.google.com` (Gmail seals the last ARC set on a redirected mail; see J4 step 1).

**By hand on the VPS:** `/var/lib/mya/camsocs-mail/run relay-lists --dry-run` (counts only), `journalctl -u camsocs-lists-relay --since -1h`. **Off:** `systemctl disable --now camsocs-lists-relay.timer`.

## J4: the Outlook rule on your @cam.ac.uk mailbox, then the worklist

**1. Create the rule** in Outlook on the web (outlook.office.com). Go to Settings → Mail → Rules → **Add new rule**.
- Name: `camsocs list mail`.
- Condition: **Message header includes** → `List-Id`. Sympa, Mailchimp and Google Groups all set this header.
- Action: **Redirect to** → the list alias from J3 (`lists-<random>@camsocs.uk`). Use *Redirect*, not *Forward*: a redirected message keeps its original sender and headers, `List-Id` included, which is how the pipeline knows which society sent it. A forwarded message arrives from you with the list's headers lost. The pipeline can read an inline-forwarded header block as a fallback, but it is weaker.
- Keep "Stop processing more rules" off, so the mail still lands in your inbox.

If you ever forward by hand, forward *as attachment* or redirect, for the same reason.

**Check the first redirected list mail.** In Gmail (joshua@camsocs.uk) it should carry **Lists** and, within five minutes, **Lists/relayed**. **Lists/rejected** means the route refused it: `journalctl -u camsocs-lists-relay` on the VPS has the status; `{"ignored":"recipient"}` from the route means `INBOUND_EMAIL_RECIPIENTS` and the alias disagree (the relay always names the alias in `to`). Never unset `INBOUND_EMAIL_RECIPIENTS`: unset, the route accepts no mail at all.

**Check that the sender was verified.** The route records, per mail, whether a trusted receiver verified the sender (`senderVerified` on the `inboundEmails` row in the Convex dashboard). On the Outlook redirect to Gmail the highest ARC set is Gmail's own (`mx.google.com`), sealed over Exchange's (`mx.microsoft.com`): it should show `dmarc=pass` or a `dkim=pass` for the list's domain. Both ids are trusted on production. Only verified mail is attributed to a society (and counts as its activity); unverified mail still yields unattributed Cambridge-only events. If the highest ARC set names another receiver, set `INBOUND_TRUSTED_AUTHSERV_IDS` to those ids (comma-separated; it replaces the default).

**2. External forwarding.** Cambridge Exchange Online allows external forwarding (Engineering IT help: https://help.eng.cam.ac.uk/email/forwarding-your-email/). If redirected mail never reaches Gmail, check whether Microsoft has blocked automatic forwarding for the tenant. In that case, ask UIS (or Engineering IT) about the outbound spam policy for your mailbox.

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
