# Deploying camsocs (T14)

How the production site goes live: a **Convex production deployment** (separate from dev, `hushed-rhinoceros-215`, with its own data), the **Vercel project** that builds `webapp/` and deploys Convex as part of its build, and the **pipeline** pointed at production with its own env file. Nothing here has been run yet; these are Joshua's steps (PLAN.md J1, J2), checked against the installed CLIs on 2026-10-09 (Convex 1.46.0: `bunx convex deploy --help`, `deployment create --help`, `deployment token create --help`, `env --help`).

**Secrets.** Never paste a value into a chat, a commit or a log. Each one goes in exactly one place: Convex env, Vercel env or `pipeline/.env.prod`. `bunx convex env set NAME` without a value prompts for it, which keeps it out of the shell history.

**Never export `CONVEX_DEPLOY_KEY`** in a shell (AGENTS.md). It overrides `.env.local`, and has deployed one project's functions onto another project's production before. A key belongs in Vercel's production environment, or on the one command line that uses it.

```
browser ──► Vercel (camsocs.uk, root dir webapp/) ──► Convex prod  ◄── pipeline --env prod
                                                                                 (VPS timers, docs/ops-vps.md;
                                                                                  by hand from the laptop until then)
                 │ build: convex-deploy-if-key.sh → bunx convex deploy (prod functions + schema)
                 │        build-env-defaults.sh → next build
```

## 1. The Convex production deployment

Every command runs in `webapp/` after `unset CONVEX_DEPLOY_KEY`; `.env.local` names the dev deployment, and `--prod` / `convex deploy` then mean *this project's default production deployment*.

1. **Check whether it exists**: Convex dashboard → team `joshua-fehn` → project `camsocs`. A "Production" deployment is listed once one has been created.
2. **If it does not**, create it and make it the project's default production deployment:

   ```bash
   bunx convex deployment create production --type prod --default
   ```

   Do not pass `--select`: that would rewrite `.env.local` to point at production, and every later `bunx convex dev` would push to it.
3. **Set its environment** (section 3) *before* the first deploy, so Better Auth starts with its secret and site URL.
4. **A deploy key for Vercel**: dashboard → Production → Settings → Deploy keys → Generate, or

   ```bash
   bunx convex deployment token create vercel-production --prod
   ```

   (prints the key once; paste it straight into Vercel, section 2). The dashboard route never puts the key in a terminal.

### Deploying the functions

- **Vercel-side (normal path).** With `CONVEX_DEPLOY_KEY` in Vercel's *Production* environment, every production build first checks that both Convex URLs are set (`scripts/build-env-defaults.sh`; a deploying build without them stops here, before anything is pushed), then runs `scripts/convex-deploy-if-key.sh` → `bunx convex deploy` (typecheck, codegen, push of functions, indexes and schema), then `next build`. Preview builds have no key and deploy nothing.
- **Local, deliberately (first deploy, or Vercel not set up yet).** The build script refuses an exported key outside Vercel. Put the key on the one command line instead, so it never enters the shell's environment:

  ```bash
  cd webapp && unset CONVEX_DEPLOY_KEY
  NEXT_PUBLIC_CONVEX_URL=https://<prod>.convex.cloud \
  NEXT_PUBLIC_CONVEX_SITE_URL=https://<prod>.convex.site \
  CONVEX_DEPLOY_KEY='<production deploy key>' CAMSOCS_ALLOW_LOCAL_CONVEX_DEPLOY=1 bun run build
  ```

  The URL check runs first: without the production pair on the line (`.env.local` names the dev deployment and is read only by `next` later) the build stops before deploying anything. Then it deploys the functions to production and compiles the site against that pair (the local compile is a check, Vercel's build is what ships). In zsh, `setopt HIST_IGNORE_SPACE` and a leading space keep the line out of the history.
- `bunx convex deploy` alone (no key; `.env.local` names the dev deployment) also targets the project's default production deployment. It is the same push without the guard; prefer the two routes above.

## 2. The Vercel project

1. Import `joshua-e-fehn/camsocs` (J1). **Root Directory: `webapp`**. Framework preset: Next.js. `webapp/vercel.json` sets the rest: `bun install`, `bun run build`, output `.next`. Node.js 22.x.
2. Environment variables:

   | Variable | Production | Preview | Notes |
   |---|---|---|---|
   | `NEXT_PUBLIC_CONVEX_URL` | `https://<prod>.convex.cloud` | `https://hushed-rhinoceros-215.convex.cloud` | Required: a Vercel build without both Convex URLs fails on purpose (`scripts/build-env-defaults.sh`) |
   | `NEXT_PUBLIC_CONVEX_SITE_URL` | `https://<prod>.convex.site` | `https://hushed-rhinoceros-215.convex.site` | Same deployment as the line above (`lib/convex-url.ts` checks) |
   | `NEXT_PUBLIC_SITE_URL` | `https://camsocs.uk` | unset | Unset, `lib/site.ts` falls back to `https://camsocs.uk` (never localhost on Vercel) — previews keep canonical links on production |
   | `CONVEX_DEPLOY_KEY` | the production deploy key | **never** | Production only; a preview with it would deploy previews' code to production |
   | `NEXT_PUBLIC_POSTHOG_KEY` | the PostHog project token (`phc_…`) | unset | Public by design (it ships to the browser). Read by the browser analytics client (`webapp/lib/analytics-client.ts`), which never loads when it is unset, and at runtime by the server's error reports (`webapp/lib/posthog-server.ts`, ENG-6), which are a no-op when it is unset. Inlined into the browser build, so a change needs a redeploy. 1Password Mya vault, item `PostHog` |
   | `NEXT_PUBLIC_POSTHOG_HOST` | `https://eu.i.posthog.com` | unset | EU Cloud ingestion host for the server's error reports (`lib/posthog-server.ts`; unset means this same host). The browser does not read it: it sends to the site's own `/relay` path, which `app/relay/[...path]/route.ts` forwards to the EU hosts (fixed in `lib/relay.ts`) |
   | `NEXT_PUBLIC_POSTHOG_ENV` | `production` | unset | Tags each browser event's `environment`; unset means `development`, which the project's internal/test filter hides (configured) |
   | `POSTHOG_PROJECT_ID` | the PostHog project id | unset | For the source map upload at build time (ENG-6, `next.config.ts`) |
   | `POSTHOG_PERSONAL_API_KEY` | the personal API key (`phx_…`), **sensitive** | **never** | For the source map upload only (ENG-6); scoped to the camsocs project, with error tracking write access (checked by a real upload on 2026-11-01). The upload runs only when both PostHog variables are set **and** `VERCEL_ENV` is `production`; otherwise the build skips it. A wrong or under-scoped key fails the production build (Turbopack), so rotate it with care. (The same name, with a separate read-only key, configures the VPS monitor in `pipeline/.env.prod`, §4, and the dashboards script reads it from the shell, "Dashboards" below) |

   Previews read the dev deployment through public queries only; sign-in does not work there (dev's `SITE_URL` is localhost), which is fine for reviewing pages.
3. Deploy: push to `main` (or `vercel --prod` from `webapp/`). The build log shows `▸ CONVEX_DEPLOY_KEY found — deploying Convex…`, then `▸ Convex URLs set — building against the configured deployment`.

What the site serves for crawlers and sharing, already in the code: `app/robots.ts` (allow everything public; disallow `/dashboard`, `/api/`, `/sign-in`; sitemap link), `app/sitemap.ts` (rendered per request from `orgs.list`, so it never needs a build against real data), `metadataBase` = `SITE_URL` in `app/layout.tsx`, and `app/opengraph-image.tsx` (the camsocs wordmark and tagline as text, no University branding).

## 3. Convex production environment

`bunx convex env set --prod NAME` (prompts for the value), from `webapp/`:

| Variable | Needed for | Value |
|---|---|---|
| `BETTER_AUTH_SECRET` | any sign-in | `openssl rand -base64 32` — a new one, not dev's |
| `SITE_URL` | Better Auth's base URL and trusted origin | `https://camsocs.uk` |
| `EXTRA_TRUSTED_ORIGINS` | further trusted origins, comma-separated (the old host while it redirects) | `https://camsocs.vercel.app` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | admin sign-in (J2) | the OAuth client whose callbacks include `https://camsocs.uk/api/auth/callback/google` |
| `BROKER_EMAILS` | the private `/dashboard` | your Google address; unset = nobody |
| `PIPELINE_API_KEY` | `/api/pipeline/*` | `openssl rand -hex 32` — a new one; the same value goes into `pipeline/.env.prod` |
| `RESEND_API_KEY`, `RESEND_FROM` | the `@cam.ac.uk` sign-in link (J3) | optional; both unset = the option shows as off |
| `RESEND_WEBHOOK_SECRET`, `RESEND_INBOUND_API_KEY`, `INBOUND_EMAIL_RECIPIENTS`, `INBOUND_TRUSTED_AUTHSERV_IDS`, `INBOUND_EMAIL_SECRET` | forwarded list mail (J3, J4) | optional; see `docs/setup/inbox-instagram.md`. Point the Resend webhook at the **production** site URL (`https://<prod>.convex.site/api/inbound/email`) once production is the one that should receive mail |
| `POSTHOG_KEY`, `POSTHOG_HOST` | server-side PostHog events from Convex (listing requests, ENG-7) | the project token (`phc_…`) and `https://eu.i.posthog.com`; set on **production only**, so dev never sends untagged events. Both unset = no events once the sender exists |

`bunx convex env list --prod` prints values; use `bunx convex env list --prod --names-only` to check what is set.

### PostHog (monitoring)

The variables above are provisioned (2026-11-01). One PostHog project, `camsocs`, on **EU Cloud** (the free plan allows one project). Production and local development share it: browser events carry `environment` (`production` or `development`, from `NEXT_PUBLIC_POSTHOG_ENV`), and the project's "Filter out internal and test users" setting already excludes `environment = development`. Server-side senders (Convex, the VPS harvester) tag their own events and run with a key on production only. Unit tests (`bun test`) never send anything (posthog-js is mocked). e2e starts `next dev`, which reads `.env.local`: keep the PostHog key out of `.env.local` while running it (the client also refuses to load under `navigator.webdriver`, so Playwright never sends, but do not rely on that alone), and never point the e2e suite at `https://camsocs.uk` with analytics on. Project settings: client IP data discarded, session replay off, timezone Europe/London; PostHog AI (the assistant and other AI features PostHog runs over project data) must stay off at organisation level (talks.cam content must never reach a model, so talk events carry IDs only); this is separate from LLM analytics, which only ingests the harvester's `$ai_generation` events (§4) and runs no model. The project token, project id and the personal API key live in the 1Password Mya vault, item `PostHog`. The VPS harvester reads its PostHog values from `pipeline/.env.prod` (§4, ENG-8).

**The browser client (ENG-4).** `webapp/instrumentation-client.ts` starts `lib/analytics-client.ts` on every page. It reads the consent store (`lib/consent.ts`, ENG-2) and does nothing of PostHog's until the visitor clicks "Accept analytics": only then is posthog-js (pinned `1.444.0`) fetched as a lazy chunk and initialised, and only with `NEXT_PUBLIC_POSTHOG_KEY` set and outside automated browsers (`navigator.webdriver`). What it does once running:

- Sends to **`/relay`** on our own origin (`api_host: '/relay'`, `ui_host: 'https://eu.posthog.com'`). The route handler `app/relay/[...path]/route.ts` (`lib/relay.ts`) forwards `/relay/static/*` and `/relay/array/*` to `https://eu-assets.i.posthog.com` and every other `/relay/*` to `https://eu.i.posthog.com`, with the method, path, query string and body, and **only** the `content-type`, `content-encoding` and `accept` headers: no cookie (Better Auth's session token and `convex_jwt`, which carries the user's name and email, and PostHog's own `ph_*` cookie), no authorization, no user agent and no `x-forwarded-for`, so PostHog sees our server's address, never the visitor's (IP data is also discarded by the project setting). Only `content-type` and `cache-control` come back; PostHog sets no cookie on our origin. It is not PostHog's `next.config` rewrite recipe because a rewrite forwards every header and cannot filter them. The cost is a function invocation per analytics request, made only by consented visitors' browsers. `skipTrailingSlashRedirect: true` lets PostHog's slash-ended endpoints (`/e/`) through without a 308; a `redirects()` rule restores Next's own trailing-slash redirect for every other path, so `/about/` still 308s to `/about`. `robots.txt` disallows `/relay`.
- Captures `$pageview` (initial and on every client-side path change, `capture_pageview: 'history_change'`; not on a fragment change, `disable_capture_url_hashes`), `$pageleave` and browser errors (`$exception`, ENG-6, below), nothing else: autocapture, session replay, heatmaps, dead clicks, rageclicks, surveys, product tours, web vitals, feature flags and remote config (`advanced_disable_flags`) are off, external scripts are never loaded, `person_profiles: 'identified_only'` with no `identify()` call anywhere. Persistence is `localStorage+cookie` (`ph_<token>_posthog`, 180 days), first party. `save_referrer: false` and `save_campaign_params: false` keep the landing URL and referrer out of that cookie (the SDK would write them as `$initial_person_info` before `before_send` runs); the page a visitor came from still travels as `$session_entry_referrer`, cleaned. Scroll depth is off (`disable_scroll_properties`).
- `before_send` (`sanitizeEvent`) is the last check before anything leaves: it drops every event unless consent is granted at that moment, events on `/dashboard*` and `/sign-in*`, SDK events other than `$pageview` / `$pageleave` / `$exception`, and custom events without an allow-list entry (ENG-5); it scrubs `$exception` (below); it strips the query string and fragment from every URL and path property, removes `title`, `$title`, `$el_text`, `$elements`, `$elements_chain`, `$raw_user_agent` (and `$useragent` / `$user_agent`), the search-engine keyword and campaign parameters (`utm_*`, `gclid`, …), and SDK defaults the privacy notice does not list (`$viewport_width` / `$viewport_height`, `$device`, `$prev_pageview_duration`; `$device_type` and `$screen_*` are listed and stay), each also as its `$initial_…` / `$session_entry_…` copy (`$session_entry_ph_keyword`), cuts a previous page or referrer inside an untracked route, and sets `environment` and `$geoip_disable: true` (also registered as super properties) so no location is derived.
- Withdrawal ("Reject" later, a lapsed or cleared choice, or either in another tab) calls `reset()`, turns persistence off, `opt_out_capturing()`, and deletes every `ph_*` / `__ph_*` cookie and storage key; a page load without a grant deletes them too.

**Error tracking (ENG-6).** Two senders, one rule: an error report carries the error's type, message and stack and where it happened, never anything a visitor sent. `webapp/lib/error-scrub.ts` cuts every query string and fragment off in messages, types and stack frames, from the `?` or `#` to the next whitespace, so it fails closed on quotes and brackets a browser leaves unencoded and on relative paths (a `#` that starts a word or follows a `.`, such as `Foo.#bar`, stays); replaces every email address, `@` or `%40`, with `[email]`; keeps only the file path of each frame, drops source lines and local variables, and caps text at 2000 characters, scanning only the first 2000 plus a 256-character margin so a long path or message costs linear time.

- **Server** (`webapp/instrumentation.ts` `onRequestError` → `lib/posthog-server.ts`, posthog-node pinned `5.61.1`): every request error Next reports (page renders, route handlers, server actions), Node.js runtime only. No consent is involved because nothing touches the visitor's device (legitimate interests; record of processing P12). The event is `$exception` with the fixed distinct id `camsocs-server`, `$process_person_profile: false`, `$geoip_disable: true` and only `$pathname` (the request path without query string), `$http_method`, `nextjs_router_kind`, `nextjs_route_path` (the route pattern, `/talks/[key]`), `nextjs_route_type`, `nextjs_render_source`, `environment` (`production` only when `VERCEL_ENV` is `production`, else `development`) and the exception itself (`$exception_list`, `$exception_level`, `$release_id`), plus the SDK's `$lib`, `$lib_version` and `$is_server`; the client's `before_send` drops every other property. Request headers are never read, so no cookie, user agent, referrer or client address can reach PostHog. `/dashboard*` and `/sign-in*` report nothing, checked on both the request path and the matched route pattern (hard rule 3; a broker-area message can name a person). Each function instance sends at most 10 reports of one error (Next's `digest`, else the error type) on one route pattern, then one per 10 s (posthog-js's browser defaults; posthog-node's own limiter does not cover `captureExceptionImmediate`), so an outage that fails every render costs a handful of reports, not one per failing request. The client is created once per function instance (`flushAt: 1`, `flushInterval: 0`, one 3 s attempt, no retries) and sends each report at once with `captureExceptionImmediate`; `onRequestError` returns straight away and hands the send to `waitUntil` (`@vercel/functions`), so the error response never waits for PostHog and Fluid compute keeps the instance alive until it is sent. A failed send is swallowed. Without `NEXT_PUBLIC_POSTHOG_KEY` (previews, local, CI) nothing is created or sent. `captureServerEvent` in the same module is the allow-listed sender for ENG-7's counts (`SERVER_EVENTS`).
- **Browser** (consented visitors only, since the client exists only after "Accept analytics"): `capture_exceptions: true` reports uncaught errors and unhandled promise rejections (not `console.error`); `app/(site)/error.tsx` and `app/global-error.tsx` report what the error boundaries catch through `captureBrowserException`, a no-op unless the client runs, except errors with a `digest`: those came from the server, which already reported the real error, and the browser only holds React's placeholder. PostHog's exception-autocapture extension is bundled into the same lazy chunk as posthog-js rather than fetched as a script, so `disable_external_dependency_loading` stays on. `sanitizeEvent` lets `$exception` through scrubbed as above, removes `$exception_steps`, and still drops it without a grant in force or on an untracked route.
- **Source maps** (`next.config.ts`, `@posthog/nextjs-config` pinned `1.12.0`): only when `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are set and `VERCEL_ENV` is `production` (Vercel Production) is the config wrapped; everywhere else it is the same object, untouched. The wrapper turns on Turbopack's native debug IDs and browser source maps, resolves a release (`camsocs`, version `VERCEL_GIT_COMMIT_SHA`), uploads every map under `.next` to `https://eu.posthog.com` after compilation and then deletes all `.map` files (`deleteAfterUpload`), so the public site serves none (the chunks keep a dangling `sourceMappingURL` comment and a `debugId`). `POSTHOG_RELEASE_ID` is inlined so both SDKs tag exceptions with the release. The CLI binary (`@posthog/cli`) is downloaded from PostHog's release host on first use, because Bun skips its postinstall; the build needs network access to it. Under Turbopack a failed release lookup or upload fails the build. Checked on 2026-11-01 with a local production build and the real key: the release was created and 241 symbol sets uploaded, no `.map` file was left in `.next`.

The relay is not blocked or cached by the CPU protection below: the firewall rule denies only the GPTBot and ClaudeBot user agents, the anonymous Data Cache covers three Convex queries (the relay's upstream `fetch` is `cache: "no-store"`), and nothing puts `/relay` responses in a shared cache except what PostHog's own `Cache-Control` allows for its static assets (which the client never loads: `disable_external_dependency_loading`). A consented visitor's `ph_*` cookie does not cost a Convex auth round trip (`lib/auth-server.ts` ignores analytics-only cookies).

**Dashboards (ENG-10).** Four dashboards — `camsocs: Traffic`, `camsocs: Content`, `camsocs: Search`, `camsocs: Reliability` — are defined in code, `ops/posthog/dashboards.py` (standard library; insight queries in PostHog's query format, every one excluding internal and test traffic). Edit them there, not in PostHog: `--apply` overwrites an insight's name, description and query by name, and creates what is missing; it deletes nothing (an insight the code dropped is reported for removal by hand). Run it on the laptop with a personal API key that has `insight:write`, `dashboard:write` and `query:read` on the camsocs project — the one in the 1Password item, never the host's read-only monitor key — read into the environment without echoing it:

```bash
pixi run posthog-dashboards -- --dry-run          # the JSON it would send; no key needed
export POSTHOG_PERSONAL_API_KEY="$(mya-op read 'op://Mya/PostHog/personal API key')"
export POSTHOG_PROJECT_ID="$(mya-op read 'op://Mya/PostHog/project id')"
pixi run posthog-dashboards -- --validate         # runs every insight's query once, read-only
pixi run posthog-dashboards -- --apply            # create or update the four dashboards
unset POSTHOG_PERSONAL_API_KEY
```

The dashboards as applied on 2026-11-01 (EU Cloud, project 330133; PostHog login required):

- [camsocs: Traffic](https://eu.posthog.com/project/330133/dashboard/1075489)
- [camsocs: Content](https://eu.posthog.com/project/330133/dashboard/1075490)
- [camsocs: Search](https://eu.posthog.com/project/330133/dashboard/1075491)
- [camsocs: Reliability](https://eu.posthog.com/project/330133/dashboard/1075492)

`POSTHOG_APP_HOST` defaults to `https://eu.posthog.com`. The browser numbers count only visitors who accepted analytics; content insights break down by `orgKey`, `eventKey` and `talkKey` (names are resolved in camsocs, never sent). The hourly production checks that alert on Slack are the VPS monitor (`camsocs monitor`, `docs/ops-vps.md` §6 "Monitor"), not PostHog alerts: the project's keys have no alert scopes.

## 4. The pipeline against production

The pipeline reads `pipeline/.env` (dev) and, for another environment, a second file on top of it (`pipeline/src/camsocs_pipeline/config.py`):

1. Create `pipeline/.env.prod` (gitignored, like every `pipeline/.env.*`):

   ```dotenv
   CONVEX_HTTP_URL=https://<prod>.convex.site
   PIPELINE_API_KEY=<the value set on the production deployment>
   ```

   Everything else (LLM, User-Agent, Camdram, Meta) is inherited from `pipeline/.env`; override any of it here if production should differ.

   Optional, for run telemetry (`pipeline/src/camsocs_pipeline/telemetry.py`): the same file takes the PostHog project token, so only production runs send events:

   ```dotenv
   POSTHOG_KEY=<the project token, phc_…; 1Password Mya vault, item PostHog>
   POSTHOG_HOST=https://eu.i.posthog.com
   POSTHOG_ENV=production
   ```

   Optional, for the hourly production checks (`camsocs monitor`, `pipeline/src/camsocs_pipeline/monitor.py`, ENG-10; on the VPS only, `docs/ops-vps.md` §6 "Monitor"):

   ```dotenv
   POSTHOG_PERSONAL_API_KEY=<a personal API key scoped to the camsocs project, query:read only>
   POSTHOG_PROJECT_ID=<the numeric project id; 1Password Mya vault, item PostHog>
   ```

   Both unset, `monitor` checks nothing and exits 0. `pixi run pipeline -- --env prod monitor` runs the four checks once from the laptop.

   Unset `POSTHOG_KEY` (the default, and `pipeline/.env`'s) means nothing is sent and the SDK is not loaded. `POSTHOG_HOST` defaults to the EU host and `POSTHOG_ENV` to `development`. Events: `harvest_run_started`, `harvest_stage_completed`, `harvest_run_finished`, as `camsocs-harvester` without a person profile, carrying counts, durations, statuses, stage names and exception class names only (plus the SDK's library name and version; the host's OS and Python version are stripped). With the key set, each cliproxy request is also an `$ai_generation` (LLM analytics, ENG-9): model, provider `cliproxy`, token counts, latency, HTTP status, error flag and class name, run key as trace id and stage, never the prompt, the reply, error text or the base URL; talks stages make none. Any cost PostHog shows for those generations is indicative only (cliproxy's models match no public price list; no custom pricing is set). Details: `docs/ops-vps.md` §6. Closing the client at the end of a run waits at most about 6 s, so PostHog trouble never stretches a harvest. On the VPS host the file is `/opt/camsocs/pipeline/.env.prod` (`0600`, owned by `camsocs`; `docs/ops-vps.md` §2, §6, §7): the harvest reads it there like `PIPELINE_API_KEY`, so no unit or installer change is involved.
2. Run with `--env prod` (or `CAMSOCS_ENV_FILE=pipeline/.env.prod`, relative to the repo root; the flag wins):

   ```bash
   pixi run pipeline -- --env prod status   # "Environment: prod (pipeline/.env.prod)" and the prod URL
   pixi run pipeline -- --env prod health   # the key opens /api/pipeline/health on production
   pixi run pipeline -- --env prod sync     # the full harvest into production
   ```

**Scheduled.** On the VPS host the runner does this daily (`sync --group events`) and weekly (`sync --group full`) under systemd timers, with its own `pipeline/.env.prod` (decision D5; install, status, alerts and key rotation: `docs/ops-vps.md`). Once its timers are on, do not also run `--env prod sync` from the laptop: the one-run-at-a-time lock is per host.

Guards: a missing `pipeline/.env.prod` is an error, not a fall-back to dev. `CONVEX_URL`, `CONVEX_HTTP_URL` and `PIPELINE_API_KEY` must be the env file's own — inherited from `pipeline/.env`, or exported in the shell, the run stops before any request (write `NAME=` in `.env.prod` to unset one deliberately). `purge-dev` refuses any environment but dev (and the deployment refuses too). A non-dev environment keeps its own run state, `.camsocs-state.prod.json`. The web cache and `var/staging/` are shared, so a production sync right after a dev one re-reads pages from the cache rather than the network.

## 5. After the first deploy

1. `https://camsocs.uk/`, `/societies`, `/talks`, `/talks/departments`, a profile, `/events` render with production data (empty until the first `--env prod sync`; `/talks` until the first talks sync, §5 "Upgrading").
2. `/robots.txt` names `https://camsocs.uk/sitemap.xml`; `/sitemap.xml` lists the listings; `/opengraph-image` is the wordmark.
3. Sign in with Google → `/dashboard` opens (your address is in `BROKER_EMAILS`).
4. The read-only e2e smoke suite runs against any URL, production included: it never lets a mutation through (`webapp/e2e/fixtures.ts`).

   ```bash
   cd webapp && E2E_BASE_URL=https://camsocs.uk bun run e2e
   ```

   Its profile slugs are dev's listings; on production they exist only after the first harvest.

### Upgrading production to the talks pillar (decision D7)

For a production that already holds societies and events, deployed before the talks pillar. The order matters: the VPS pulls main at the start of every run, and its `talks` stage posts to routes that exist only once the functions are deployed.

1. **Deploy first** (§1–§2): the build's `convex deploy` adds the talks tables (additive), the `/api/pipeline/talks/*` routes and the crons `talks-retention-daily` (04:30 UTC, retention R11) and `talks-stats-daily` (00:10). `/talks` shows its empty state, and the home page has no talks figure, until the first talks sync.
2. **Then merge to main.** The next scheduled run (daily 04:30, or Sunday 02:00) runs `talks` with the other events stages (`docs/ops-vps.md` §1). Merged before the deploy, that run's `talks` stage fails against the old functions (the other stages still finish).
3. **First talks sync — optional, on the host, under the lock**, so two hosts never read talks.cam at once; well away from 04:30 and Sunday 02:00:

   ```bash
   sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod sync --group talks'
   ```

   Or simply wait for the next daily run. Not from the laptop while the VPS timers are on (§4).
4. **Never seed production with demo talks.** `talks-demo-seed` is for dev only and refuses any `--env`.
5. **Check** (§5): `/talks`, `/talks/departments` and `/talks.ics` (200, `text/calendar`) render; an unknown `/talks/talk-00000000000000000000` is a 404; `/robots.txt` disallows `/talks` for the AI crawlers. The smoke suite covers these.

## 6. Rolling back

- Site: Vercel → Deployments → the last good one → Promote to Production (instant; Convex is untouched).
- Functions: redeploy the last good commit (Vercel → Redeploy, which runs `convex deploy` again). Schema changes that removed fields need a widen-migrate-narrow plan first; never roll a schema back past data written under the newer one.

## 7. After the next deploy: cleaning what the review fixes left behind (operator)

The review of 2026-10-10 corrected the calendar-noise rules (D6) and how titles are redacted (D1). Corrected readers restate only what they still read — the events stages read nothing older than a week — so production keeps, until removed: pre-D6 notices (a past "PR closed to sisters …", "MSt students in residence"), past CTFs stored as the society's own (they count towards its `lastActiveAt`), titles an earlier redaction wrote ("I someone", "A chat with someone") that no reader restates, and future events of cards that a page no longer shows (each card file was swept on its own before). `camsocs clean-events` finds them (`pipeline/.../cleanup.py`) and removes them through a guarded route (`POST /api/pipeline/events/remove`: events only, by key, `confirm: "REMOVE-EVENTS"`, 25 a call; `convex/ingest/cleanup.ts`). Not run yet; these are Joshua's steps.

1. **Deploy** (§1–§2): the routes `events/scan` and `events/remove` ship with the functions, and the new `eventOrganisers.hosting` copy with the schema (optional, additive).
2. **Harvest** production once with the new pipeline (`pixi run harvest -- --env prod`, or the VPS's full run), then re-derive: `pixi run pipeline -- --env prod derive`. Current events are restated by their readers (titles restored, notices withdrawn, hosting claimed); what is left is what no reader restates.
3. **Dry run** — lists, removes nothing (keys, London dates, sources, reasons; `--titles` adds the stored titles, for your terminal only):

   ```bash
   pixi run pipeline -- --env prod clean-events
   pixi run pipeline -- --env prod clean-events --titles   # to check the list by eye
   ```

   Reasons: `notice:<rule>` (the D6 rules judge it a notice), `external:<rule>` (a past event the rules decisively judge someone else's, stored as hosted), `stale-redaction` (a title reading "someone" the latest harvest did not see again), `stale-card` (a future term-card event no card has shown for three days). Anything that should stay: leave it out by fixing its reading instead, never by editing the list.
4. **Apply** — only with `--env prod` (the command refuses any other environment; on dev, remove an event with `bunx convex run ingest/purge:removeEntity '{"entityType":"event","key":"evt-…"}'`):

   ```bash
   pixi run pipeline -- --env prod clean-events --apply
   ```

   It prints how many were removed and how many were already gone. Run the dry run again: it should list nothing. Once the VPS timers are on, run it on the host instead (`sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod clean-events'`), never next to a harvest.


## CPU protection: training crawlers and anonymous data (2026-11-01)

The project firewall has one active deny rule for GPTBot and ClaudeBot
(user-agent substring matches, including lowercase). Googlebot, Bingbot and
OAI-SearchBot are not blocked. The rule runs before application compute on
both camsocs.uk and camsocs.vercel.app. `ops/vercel/training-crawlers.json`
is the reviewed PATCH body for `/v1/security/firewall/config?projectId=…`.
Read the current config first and update the existing named rule; do not
blindly insert duplicates. This project-level setting survives deployments.
`robots.txt` also asks just those two training crawlers not to fetch the site.
User agents can be spoofed; this is not an authentication mechanism.

`lib/public-data.ts` caches anonymous events, anonymous restricted-event counts
(counts only), and the public college list in Next's Data Cache for 60 seconds.
The deployment URL and query arguments distinguish entries. Signed-in event
queries bypass that cache entirely. Convex client subscriptions continue to
update after hydration. Full HTML and authenticated responses are NOT put into
a shared CDN cache: the root auth provider and calendar are personalized.
No-cookie requests (and requests whose only cookies are PostHog's `ph_*` /
`__ph_*`, ENG-4) skip the redundant server auth lookup; other cookie-bearing
requests retain the existing auth flow. The former no-op proxy is removed;
access checks remain in the existing Convex functions and client auth guard.

This hotfix is based on the deployed commit 7df7d6c, not the in-progress redesign.
Frontend-only deployment must not redeploy or roll back Convex: build locally
against the pulled production public URLs with CONVEX_DEPLOY_KEY removed from
the gitignored build environment, then deploy the prebuilt output.
