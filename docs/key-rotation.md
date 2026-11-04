# Rotating keys outside the VPS (ENG-37)

How to replace each credential production uses that does not live on the VPS, what breaks while it is half done, and how to check it worked. The VPS's own keys (production `PIPELINE_API_KEY`, the cliproxy key, the deploy key, Slack, Meta, Camdram, the PostHog values in `/opt/camsocs/pipeline/.env.prod`) are in docs/ops-vps.md §7; this page links there where a key lives in both places.

**When.** Rotate at once after a suspected leak (then follow docs/compliance/breach-procedure.md as well); otherwise when a person or device with access goes away, and at the annual review in July for anything older than a year. Do it outside the harvest windows (not 04:30–06:30 daily, not 02:00–08:00 on Sundays) when a key is shared with the VPS.

**Never** paste a value into a chat, a commit, a log or a shell history. `bunx convex env set --prod NAME` without a value prompts for it; `vercel env add NAME production` prompts too. In zsh, `setopt HIST_IGNORE_SPACE` and a leading space keep a line out of the history. Every Convex command here runs in `webapp/` after `unset CONVEX_DEPLOY_KEY` (AGENTS.md). Keep the 1Password Mya vault item in step with each change.

Where each key lives (read 2026-11-04, names only: `bunx convex env list --prod --names-only`, `vercel api /v10/projects/prj_capNnDOwrpJa4jvuxUo69cdtSBF2/env?teamId=team_BPZRUyOixqP7I7QyKQ5LoKG5`):

| Key | Convex production | Vercel Production | Elsewhere |
|---|---|---|---|
| Convex deploy key | — | `CONVEX_DEPLOY_KEY` (type `encrypted`) | — |
| Better Auth secret | `BETTER_AUTH_SECRET` | — | — |
| Google OAuth client | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google Cloud project `camsocs` (admin@joshua-fehn.de) |
| PostHog project token (`phc_`) | `POSTHOG_KEY` | `NEXT_PUBLIC_POSTHOG_KEY` | VPS `.env.prod` `POSTHOG_KEY`; 1Password `PostHog` |
| PostHog personal API key (`phx_`) | — | `POSTHOG_PERSONAL_API_KEY` (type `sensitive`) | VPS `.env.prod`; the dashboards script; 1Password `PostHog` |
| IndexNow key | — | — | `webapp/public/<key>.txt` and `INDEXNOW_KEY` in `pipeline/.../indexnow.py` (public by design) |
| Vercel access tokens | — | — | Vercel account → Tokens; the CLI's own login; the "Mya token" |
| Resend (`RESEND_*`, `INBOUND_*`) | not set on production | — | when J3 is done: docs/setup/inbox-instagram.md |

Search Console and Bing verification values (`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`, `NEXT_PUBLIC_BING_SITE_VERIFICATION`) are public meta tags, not secrets.

## Convex deploy key (`CONVEX_DEPLOY_KEY`)

What it does: lets the Vercel production build push functions and schema to `cheerful-bandicoot-511`. Whoever holds it can replace production's code (and so read every table), so it is the most sensitive key here.

1. Convex dashboard → project `camsocs` → **Production** → Settings → **Deploy Keys** → Generate (name it `vercel-production-<date>`). The dashboard route never puts the key in a terminal.
2. Vercel → `camsocs` → Settings → Environment Variables → `CONVEX_DEPLOY_KEY` → remove it, then **Add** it again with the new value, environment **Production only**, and **Sensitive** on (the current one is only `encrypted`, so it can be read back in the dashboard; `sensitive` cannot). Never tick Preview or Development: a preview with the key would push a branch's code to production.
3. Redeploy `main`: a trivial merge, or Deployments → the current production deployment → Redeploy (if the Ignored Build Step cancels it, push a docs-only commit). The build log must show `▸ CONVEX_DEPLOY_KEY found — deploying Convex…` and finish.
4. Back in Convex → Deploy Keys, **delete the old key**.

Breaks while half done: nothing serves differently; a production build with a wrong or deleted key fails at `convex deploy`, and the previous deployment stays live. Check: the build in step 3 succeeded; Convex → Production → History shows a deploy at that time.

## `BETTER_AUTH_SECRET`

What it does: signs Better Auth's session cookies and encrypts the private half of the JWT signing key in the `betterAuth` component's `jwks` table (`better-auth` jwt plugin, private-key encryption on by default). Convex validates sign-ins with that JWT.

Rotating it **ends every session** (everyone signs in again; today only the broker) and makes the stored signing key unreadable, so new Convex tokens fail until a new key exists. Steps:

1. `openssl rand -base64 32`, then `bunx convex env set --prod BETTER_AUTH_SECRET` (paste at the prompt).
2. Convex dashboard → Production → Data → component **betterAuth** → table **`jwks`** → delete its row(s). The jwt plugin creates a fresh key, encrypted with the new secret, on the next token. (Try the whole sequence on dev first: same steps without `--prod`, dev's dashboard.)
3. Sign in at https://camsocs.uk/sign-in with Google → `/dashboard` opens. If it loops back to sign-in, check the Convex logs for a JWKS or decryption error and that step 2 left no old row.

Never reuse dev's value for production.

## Google OAuth client

What it does: admin sign-in (ENG-39). Google Cloud project `camsocs` under the admin@joshua-fehn.de Workspace, audience Internal, so only Workspace accounts can sign in.

1. https://console.cloud.google.com/apis/credentials?project=camsocs → OAuth 2.0 Client IDs → the camsocs web client → **Add secret** (a client can hold two secrets while you switch).
2. `bunx convex env set --prod GOOGLE_CLIENT_SECRET` with the new secret (the client ID stays).
3. Sign out and in again at https://camsocs.uk/sign-in → `/dashboard` opens.
4. Back in the console: **disable**, then delete, the old secret.

Breaks while half done: nothing, as long as the old secret stays enabled until step 3 passed. A new client (not just a secret) also needs its authorised redirect URI `https://camsocs.uk/api/auth/callback/google` (and `http://localhost:3000/api/auth/callback/google` for dev) and both Convex values.

## PostHog keys

**Project token (`phc_…`, ingest only, public by design).** It ships to every browser, so rotating it only matters if it is abused to send junk events. PostHog → Project settings → General → Project API key → **Reset**. Then set it in all three places in one sitting: Vercel `NEXT_PUBLIC_POSTHOG_KEY` (Production; inlined at build time, so **redeploy**), `bunx convex env set --prod POSTHOG_KEY`, the VPS `.env.prod` (docs/ops-vps.md §7), and 1Password. Breaks while half done: the senders still holding the old token are refused, silently (no visitor sees anything; Convex logs `PostHog refused listing_request_received`). Check: an accepted analytics consent on camsocs.uk produces a `$pageview` in PostHog's activity view within a minute (exclude internal filters off), and the hourly monitor's `stale_harvest` stays ok after the next run.

**Personal API key (`phx_…`).** Used by the Vercel production build to upload source maps, by the VPS monitor and by `ops/posthog/dashboards.py`. Create the new key first (PostHog → Settings → Personal API keys → Create; camsocs project only; scopes: error tracking write, insight and dashboard write, query read), then: Vercel `POSTHOG_PERSONAL_API_KEY` (Production, **Sensitive**) and redeploy — a wrong or under-scoped key **fails the production build** (Turbopack aborts on a failed upload; the previous deployment stays live); the VPS per docs/ops-vps.md §7 (check `journalctl -u camsocs-monitor -n 10` shows no `unknown`); 1Password. Delete the old key last.

## IndexNow key

Public by design (search engines fetch `https://camsocs.uk/<key>.txt` to verify a ping), so a leak only lets someone submit our own URLs. To rotate: a new 32-hex key (`openssl rand -hex 16`), in one commit rename `webapp/public/<old>.txt` to `<new>.txt` with the new key as its content and change `INDEXNOW_KEY` in `pipeline/src/camsocs_pipeline/indexnow.py` (the tests assert they match). Order as for any change the VPS pulls: the Vercel build has to serve the new file before the next 04:30 run pings with the new key, which is automatic when the commit lands on `main` (one build) well before 04:30. Check: `curl -s -o /dev/null -w '%{http_code}' https://camsocs.uk/<new>.txt` is 200, and the next run's load note says `IndexNow:` without an error. Delete `.camsocs-state.prod.indexnow.json` on the host only if the engines should be told every page again.

## Vercel access tokens

Live tokens (2026-11-04, `vercel api /v5/user/tokens`, names only): two "Login with GitHub" browser sessions and **"Mya token"** (manual, team-scoped, created 2026-10-05, **no expiry**, last used 2026-10-31). A team token can deploy, read every environment variable that is not sensitive and change the firewall.

- Rotate: Vercel → Account Settings → **Tokens** → Create (scope the team `joshuas-projects-dc895e08`, **set an expiry**, e.g. 90 days) → put it where Mya reads it (the Mya vault item that holds it) → check Mya's next Vercel call works → delete the old token on the same page.
- The CLI's own login on the laptop: `vercel logout` then `vercel login`.
- Revoke a lost device's session: Account Settings → Sessions (or Tokens) → delete it.

Nothing in camsocs's build reads a Vercel token: Git pushes deploy through the GitHub integration.

## After any rotation

- Update the 1Password Mya vault item.
- If a leak was the reason, note the date, the key's name (never its value) and what was done in the breach log (breach-procedure.md §1, kept outside Git where Joshua chose).
- Run the status loop in docs/rollback.md §1 and, for keys the harvester uses, `pixi run pipeline -- --env prod health` (or on the host).
