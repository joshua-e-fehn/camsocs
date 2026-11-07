# CAMsocs webapp internals

Folded from the template's `webapp/agents.md`. Root rules live in `/AGENTS.md`.

## Tech stack (resolved versions, 2026-10-07)

| Layer              | Technology                                  | Version            |
| ------------------ | ------------------------------------------- | ------------------ |
| Framework          | Next.js (App Router, Turbopack)             | 16.2.12 (pinned)   |
| UI runtime         | React / React DOM                           | 19.2.4 (pinned)    |
| Language           | TypeScript                                  | 5.9.3              |
| Package manager    | Bun (only — never npm/pnpm/yarn)            | 1.3.11             |
| Backend / DB       | Convex                                      | 1.46.0             |
| Auth               | Better Auth + @convex-dev/better-auth       | 1.6.33 / 0.12.5    |
| UI components      | shadcn (radix-nova, mauve) + radix-ui       | 4.21.4 / 1.7.0     |
| Styling            | Tailwind CSS v4 (CSS-first, no config file) | 4.3.3              |
| Icons              | lucide-react                                | 1.52.0             |
| Toasts             | sonner                                      | 2.0.8              |
| Animation          | framer-motion                               | 12.43.0            |
| Analytics          | posthog-js (lazy, after consent only)       | 1.444.0 (pinned)   |
| Error tracking     | posthog-node + @posthog/nextjs-config       | 5.61.1 / 1.12.0    |
| Validation         | zod                                         | 4.6.5              |
| Lint / format      | Biome                                       | 2.4.7 (pinned)     |
| Tests              | `bun test` + convex-test + happy-dom        | 0.0.55 / 20.14.5   |
| E2E smoke          | Playwright (Chromium), `bun run e2e`        | 1.64.0             |
| Hooks              | husky + lint-staged                         | 9.1.7 / 16.4.0     |
| Hosting            | Vercel (root dir `webapp`) + Convex         | —                  |

`better-auth` is pinned `~1.6.25`, not `^`: `@convex-dev/better-auth@0.12.5` declares the peer
range `>=1.6.11 <1.7.0`, and a caret resolves to 1.7.x.

## Project structure

```
app/                         Next.js App Router pages
  layout.tsx                 Root layout: ConvexClientProvider + AuthGuard + ConsentBanner +
                             Toaster (light only); site-wide metadata (metadataBase, Open Graph)
  (site)/                    The public site (route group: header + footer frame, error, not-found)
    page.tsx                 Home: search, category tiles, this week's public events, explainer
    societies/page.tsx       Directory: URL-synced filters + facet counts + search + pages; one category or
                             college canonical to its hub, searches and combinations noindex
    societies/[slug]/page.tsx  Organisation profile, a SourceLine under every fact and a Sources list; a
                             college's own page is its hub (its listings by category). talks.cam content
                             is stripped first (lib/directory-talks-guard.ts, decision G1)
    categories/page.tsx, categories/[category]/page.tsx
                             Category hubs: every listing of a category on one self-canonical page
                             (lib/directory-hubs.ts; outside /societies/ so no slug can collide)
    events/page.tsx          Calendar: list / week / month, filters, event sheet (?event=)
    request/page.tsx         Claim / correct / remove / object / add form (?kind=&org=<slug>&event=<key>;
                             an event is named by its key in the HTML, its title read in the browser
                             with events.requestLabel, which sends none for a talks.cam-derived one;
                             preset links are rel=nofollow)
    about/page.tsx, privacy/page.tsx   About (how data is collected) and the UK GDPR notice
    term-dates/page.tsx      Full Term dates by academic year, the week of term today and each week's
                             dates (`termDates` + lib/term-calendar.ts; no hand-written dates)
  sign-in/page.tsx           Google (admin) + @cam.ac.uk email link (accounts are created on first use)
  dashboard/                 Private broker area (session required; BrokerGate shows non-brokers why
                             it is closed): overview, organisations (?org=<key> opens the drawer),
                             people, interactions, introductions, graph, reports (missing data +
                             outreach CSV), requests
  sitemap.xml/, sitemaps/    Sitemap index + pages / societies / events files (lib/sitemap.ts,
                             lib/sitemap-societies.ts, convex/sitemap.ts, orgs.sitemap): lastmod, edge-cached
                             an hour, 503 on a backend failure; category hubs and college pages listed; thin
                             profiles (G3), ended and talks.cam-derived events (G1) left out
  robots.ts                  robots disallows /dashboard, /api/, /sign-in, /relay and the parameter traps
                             (/events?, /societies?, /talks?, /request?, /talks/departments?, /events/*/ics;
                             canonical ?org= / ?page= / ?dept= / ?school= views allowed); AI agents
                             (lib/crawlers.ts T1-T3) off /talks; training crawlers (T3) also off the
                             per-request pages and any query, as the firewall denies them
                             (crawl-traps.ts TRAINING_DISALLOWS); SEO tools and scrapers (T4) off the
                             site (bot policy 2026-11-03)
  opengraph-image.tsx        Generic share image: wordmark and headline only (no University branding),
                             drawn by _og/card.tsx; a society's and an event's segment draw their own
                             (`opengraph-image.tsx`: name, kinds, logo / when, title, host, venue;
                             lib/og-card.ts: never a non-public or talks.cam-derived event, G1). Young
                             Serif is vendored in _og/fonts/ (SIL OFL, OFL.txt beside it) and read from
                             disk, so no card's text goes to a font service; file tracing ships it with
                             each card's function, as public/crest.svg
  manifest.ts                /manifest.webmanifest (name, light theme colour, icons); public/ also serves
                             apple-touch-icon.png and .well-known/security.txt (RFC 9116, held equal to
                             lib/security-txt.ts by its test: renew its Expires before 2027-09-01)
  llms.txt/route.ts          /llms.txt (lib/llms-txt.ts), static: what CAMsocs is, that it is unofficial,
                             its societies, category hubs, events, term dates and About pages; never the
                             talks pillar (G1)
  not-found.tsx              404 for any unmatched URL, server-rendered in the site frame, titled "Page not
                             found"; an unknown listing (proxy.ts) gets it too, a talk the talks pillar's
                             once hydrated (not-found-variant.tsx; see "Unknown listing URLs"). Static:
                             it reads no request header (see "Caching")
  api/auth/[...all]/route.ts /api/auth/* proxy to Better Auth in Convex (NOT a next.config rewrite)
  api/request/route.ts       POST /api/request: the request form, BotID-checked (lib/request-submit.ts)
  relay/[...path]/route.ts   /relay/* hop to PostHog EU, forwarding by allow-list (lib/relay.ts; NOT a
                             next.config rewrite: that would pass cookies on)

components/                  Atomic Design
  ui/                        ATOMS — shadcn/ui primitives
  molecules/                 MOLECULES — small composites
  organisms/                 ORGANISMS — page sections
  providers/                 PROVIDERS — context wrappers (convex client, theme, auth guard)

convex/
  schema.ts                  The domain schema (docs/data-model.md is the contract; header states the rules)
  http.ts                    Better Auth routes + /api/pipeline/* (Bearer PIPELINE_API_KEY)
                             + /api/inbound/email (forwarded list mail; Svix / Bearer, see below)
  orgs.ts events.ts venues.ts termDates.ts listingRequests.ts sitemap.ts
                             PUBLIC read API (see "Public API" below) + the listing-request form
  ingest/                    internal mutations behind /api/pipeline/* (claims, sources, orgInternal,
                             relationships + eventOrganisers, broker, files, inbound, termDates, purge,
                             suppressions, cleanup)
  derive.ts / crons.ts       background re-derivation (daily 03:30 UTC)
  retention.ts               the retention schedule as paginated walks (daily 04:15 UTC;
                             docs/compliance/retention.md)
  coverage.ts                directory coverage folded server-side, a page per scheduled mutation,
                             into `coverageSnapshots` (after each run, daily 04:45 UTC, on request);
                             the same fold page by page for the pipeline's coverage report
  runs.ts                    internal runs.start / runs.finish / runs.latest (pipeline run log)
  analytics.ts               internal captureListingRequest: listing_request_received { kind } to
                             PostHog (lib/posthog.ts; see "Server counts")
  auth.ts                    getCurrentUser, getBrokerAccess, getSignInOptions, getViewerTier (public, never throw)
  authEmail.ts               internal throttle for the @cam.ac.uk sign-in link
  broker/                    PRIVATE CRM functions — every one calls requireBrokerUser (see "Broker API")
  lib/fields.ts              claimable-field registry: validators, merge/compare rules, applicability
  lib/resolve.ts             field resolution engine (data-model §1), pure
  lib/materialise.ts         resolutions → row + meta + derived fields; lib/derived.ts the §6 rules
  lib/entityStore.ts         keyed entity reads/writes, org cards, organisation refresh
  lib/projections.ts         public projections (data-model §7) and their validators
  lib/suppressions.ts        the suppression list: keys, address hashes, the claim check
  lib/suppressionEffects.ts  what creating / lifting a suppression does to stored data
  lib/orgFilters.ts          directory filters and disjunctive facet counts, pure
  lib/viewer.ts              getViewer(ctx): signed-in / broker / verified @cam.ac.uk
  lib/auth.ts                requireUserId / getUserId / requireBrokerUser / getBrokerUser
  lib/ingest.ts              upsertRow (write only when changed), MAX_BATCH 500, guarded prune
  lib/validators.ts          literalUnion() over lib/vocab.ts tuples
  lib/checkValue.ts          checks a v.any() claim value against a field validator
  lib/harness.testing.ts     convex-test harness (two dots → never deployed)
  betterAuth/                Better Auth component (local install, from Bundestracker)
  _generated/                COMMITTED codegen (see .gitignore note)

hooks/convex/index.ts        Thin useQuery/useMutation wrappers ("skip" pattern)
hooks/use-consent.ts         useConsent() / useConsentBannerOpen() / useConsentSettingsRequests()
                             over lib/consent.ts
hooks/convex/broker.ts       The broker area's hooks (mounted only inside BrokerGate) + runWithToast
lib/                         Pure logic + *.test.ts (no server imports)
  vocab.ts                   Controlled vocabularies (as-const tuples), mirrored by the pipeline,
                             plus their display labels (Records, ignored by the parity test)
  calendar.ts                Europe/London calendar: offsets, days, view windows, formatting
                             (shared with convex/lib/derived.ts)
  url-state.ts               /societies and /events state <-> URL, and the Convex args it preloads
  source-line.ts             What a SourceLine says for a field's public meta (status, source, …)
  listing-request.ts         The request form's draft, validation (server limits) and submit args
  request-submit.ts          The form's route (server only): POST /api/request, BotID on Vercel
                             (fails open only while not set up), REQUEST_FORM_SECRET, Convex refusals
  request-client.ts          The form's sender (aborts after 30 s), REQUEST_PATH and its sentences;
                             zod-free, since instrumentation-client.ts ships it on every page
  focus.ts                   focusOnMount: a form's outcome takes focus (ENG-37)
  owner-corrections.ts       Accepting a correction: which fields, how each is edited and parsed
  syntax.ts                  isEmail / isHttpUrl, shared with convex/lib/fields.ts
  public-api.ts              Client names for the public API's return types (types only)
  format.ts                  Money, language names
  rich-text.ts               Free-text markdown → a tree (never HTML; tags dropped; links http(s) or one
                             mailto address only), rendered by molecules/rich-text; `plainLine` / `summary`
                             give the plain text for cards, short-description lines and meta descriptions
  event-runs.ts              A show's nights as one run; events already running at a view's start (the
                             folded "N ongoing" strip, soonest to end first); events by day, where a run
                             of more than 14 days sits on its first day only, never on each day it covers
  monogram.ts                Initials for an organisation without a logo
  pagination.ts              The page numbers a pager shows
  page-metadata.ts           A page's title, description, share card (with the share image) and canonical
  site.ts                    Site facts: name, URL, controller, CONTACT_EMAIL (D4), …
  cam-email.ts               The one @cam.ac.uk rule (sign-in link, getViewer, the form)
  consent.ts                 The analytics consent store (see "Analytics consent"), UNTRACKED_PATHS,
                             clearAnalyticsStorage(), hasNonAnalyticsCookie()
  analytics-client.ts        The consent-gated posthog-js client: init options, before_send
                             (sanitizeEvent), startAnalytics(), getPostHog(), posthogReady(),
                             captureBrowserException() (see "Analytics client")
  analytics-events.ts        The ENG-5 event taxonomy (event → property → value rule), shared by
                             track() and before_send; analyticsAttrs()/analyticsContext() markup
  analytics.ts               track() and the click tracker (see "Analytics client", docs/analytics.md)
  posthog-server.ts          The server's PostHog sender (posthog-node): onRequestError reports,
                             captureServerException(), captureServerEvent(), SERVER_EVENTS (see
                             "Error tracking", "Server counts")
  ics-telemetry.ts           countIcsFetch(): the .ics routes' ics_feed_fetched count, in after()
                             (see "Server counts")
  error-scrub.ts             What an error report may say: no query string, fragment or email in
                             messages and stacks, frame paths only (browser and server)
  broker/                    Broker analysis shared by server, browser and tests: coverage (the
                             fold convex/coverage.ts runs), matching, outreach (CSV + Art 14
                             notice + send log; art14-mail-merge.test.ts runs the Apps Script
                             ops/outreach/art14-mail-merge.gs), force-layout, format
  keys.ts / hash.ts          Key minting + claim fingerprints (pure SHA-1/256); keys.fixtures.json shared with Python
  broker-access.ts           BROKER_EMAILS parsing/matching
  inbound-email.ts           inbound mail: payload parsing, List-Id, HTML→text, limits, Svix verify
  resend-inbound.ts          Resend Receiving API client (body, headers, attachments; fetch injected)
  auth-routes.ts             PUBLIC_PATHS / PRIVATE_PATHS (test asserts every page is classified)
  auth-forwarded-headers.ts  The /api/auth hop without x-forwarded-host (Bundestracker outage fix)
  relay.ts                   The /relay hop to PostHog: no cookie, auth, user agent or client address
                             goes out, no PostHog cookie comes back
  convex-url.ts              Build-time check that both Convex URLs name one deployment
scripts/
  check-codegen.ts           Committed api.d.ts lists every convex module
  firewall-rules.ts          Writes ops/vercel/*.json, the Vercel firewall bodies of the bot policy
                             (lib/firewall-rules.ts; `bun run firewall:rules`; applying: docs/deploy.md)
  measure-public-api.ts      Response size and time of the public queries against .env.local's deployment
  build-env-defaults.sh      Placeholder Convex URLs only for builds going nowhere (+ .test.ts)
  convex-deploy-if-key.sh    Deploys only on Vercel; refuses a stray exported CONVEX_DEPLOY_KEY
test/setup.ts                happy-dom preload (keeps native fetch/Headers/Request/Response)
e2e/                         Playwright smoke suite (not part of `bun test`; bunfig ignores it)
  fixtures.ts                Read-only guard on the Convex socket, page checks, screenshot paths
  smoke.spec.ts              Every public page at 1440×900 and 390×844 (+ dark), filters, sheet, the
                             ongoing strip, form (sent and refused, outcome focused)
  a11y.spec.ts               The CI accessibility gate: axe over the main public pages and states;
                             serious/critical fail, the rest are reported (ENG-37)
  consent.spec.ts            The consent banner: first visit (axe), Reject, Accept, footer reopen,
                             focus never hidden behind it (360px), 400% zoom (320x256)
  analytics.spec.ts          Without a key, Accept requests nothing from /relay or PostHog and stores
                             no ph_* cookie or storage; leftover ph_* storage is cleared on load
playwright.config.ts         Projects, `next dev` on :3100 (`next start` with E2E_SERVER=start, or
                             E2E_BASE_URL), output under ../var/
instrumentation-client.ts    Browser start-up: startAnalytics(), startClickTracking() (see "Analytics client"),
                             and on a Vercel build initBotId for POST /api/request (ENG-37)
instrumentation.ts           Server: onRequestError → PostHog error report (see "Error tracking")
proxy.ts                     Listing pages and the talks pillar only: unknown society / event / talk
                             URL → real 404 (see "Unknown listing URLs"; lib/missing-listing.ts); a
                             talks.cam-derived event → 308 to /talks/events/<key> ("The talks
                             boundary"); an AI agent on /talks* → 403 (lib/crawlers.ts)
next.config.ts               Turbopack root, image hosts, trailing-slash redirect (and why there is no
                             /api/auth or /relay rewrite); PostHog source map upload on Vercel
                             production builds only (withSourceMapUpload, + next.config.test.ts)
```

### Component architecture (Atomic Design)

- Atoms (`components/ui/`) **never** import from molecules or organisms.
- Molecules may import atoms but **never** organisms.
- Organisms may import atoms and molecules.
- Providers are standalone wrappers, imported only in layouts.
- New shadcn components go in `components/ui/`; import paths use `@/components/{layer}/{name}`.

### Data fetching

Convex hooks only (`hooks/convex/`), via `useQuery`/`useMutation` from `convex/react`. There is no
REST layer and no React Query; never wrap a Convex query in another fetching library.

Public pages render on the server, anonymously (see "Caching"). A page with interaction
(directory, calendar) parses its URL state (`lib/url-state.ts`), calls `publicPreload`
(`lib/public-data.ts`) and hands the result to a client organism that reads it with
`usePreloadedQuery` (live afterwards); a filter change is a `router.push` of the new URL. A page
without interaction (profile, home, About) uses `publicQuery` and ships no client JavaScript of its
own. No server render of a page passes a token: what only a signed-in reader may see is added in the
browser. Opening an event only changes `?event=` with `window.history.pushState` (no server round
trip).

### Caching (SEO audit 2026-11-02, no-cdn-cache)

Public pages are served from Vercel's edge, rendered again at most every 5 minutes (incremental
static regeneration), so a crawler's or a reader's view is usually no function call and no Convex
read. What makes that work, and what keeps it working:

- **Nothing above a public page reads the request.** The root layout reads no session (no
  `getToken()`, so the Convex provider has no `initialToken`), and `app/not-found.tsx`, which Next
  renders into every route's payload, reads no header (`app/not-found-variant.tsx` picks the
  talks pillar's not-found page in the browser). One `headers()` or `cookies()` call in either makes
  every page dynamic again.
- **Every server read of public data is `publicQuery` / `publicPreload`** (`lib/public-data.ts`):
  anonymous by signature, kept in Next's Data Cache per function and arguments for
  `PUBLIC_DATA_REVALIDATE` (300 s). `fetchQuery` from `convex/nextjs` sends `cache: "no-store"`,
  which makes the page that calls it dynamic, so it is left for route handlers (`.ics` feeds,
  sitemaps, share cards, the proxy).
- **`revalidate = 300`** in `app/(site)/layout.tsx` (a literal; `PUBLIC_DATA_REVALIDATE` and the
  proxy's `FOUND_TTL_MS` are held equal to it by tests). Pages that read their search params stay
  dynamic (`/societies`, `/events`, `/talks`, `/talks/departments`, `/request`), with their reads
  cached. A cached page can be up to twice that behind the database; the interactive pages' live
  queries catch up once hydrated.
- **No prefetch of a dynamic page from a link on every page** (bot policy 2026-11-03). A
  next/link prefetches what comes into view, and a prefetch of one of the pages above is a server
  render. The header's sections, the footer, the home page's overview and "Try" links, the event
  and talk pages' breadcrumbs and department chips, a profile's calendar and filter links and the
  Cambridge-only sign-in hints (`/sign-in` reads its parameters too) are `prefetch={false}` for
  them (the header by its `NAV` list, the rest through `lib/crawl-traps.ts` `linkProps` /
  `dynamicPrefetch`, which also sets a crawler trap's `rel="nofollow"`); links to cached pages
  keep Next's default.
- **Dynamic segments build nothing** (`generateStaticParams` returns `[]` on `/societies/[slug]`,
  `/events/[key]`, `/talks/[key]`, `/talks/events/[key]`): each page is rendered on its first
  request, so `next build` never reads Convex for them. Pages without a segment (`/`, `/about`,
  `/privacy`, `/categories`, `/term-dates`) are prerendered by a real build from its own
  deployment, as any static page is. The 16 category hubs (`/categories/[category]`) are the
  exception: a fixed vocabulary, listed by `generateStaticParams` with `dynamicParams = false`, so
  a real build prerenders them like `/categories` and any other slug is an unmatched URL that gets
  `app/not-found.tsx`'s static 404 (x-matched-path /404, edge-cached; re-check 2026-11-03
  not-found-template). In a placeholder or failed-read build the route is `ƒ` and the page's own
  `notFound()` answers unknown slugs as before. A build against
  `scripts/build-env-defaults.sh`'s placeholder must not contact Convex, so there every cached read
  calls `connection()` first and those pages become dynamic in that build only (`lib/convex-url.ts`
  `isPlaceholderDeployment`). The build's route table therefore shows them (and the category
  hubs) as `ƒ` in CI; build
  with real `NEXT_PUBLIC_CONVEX_*` URLs to see `○ … 5m`. A real build whose deployment fails a read
  (a preview's dev deployment unreachable, or behind the branch's functions) does not fail either:
  during `next build` only (`NEXT_PHASE === "phase-production-build"`), a failed cached read logs
  a `console.warn` naming the function (one per failed read) and calls `connection()`, so that page is `ƒ` in that
  build and renders on its first request (review of the SEO audit 2026-11-02, build-coupling).
  Never on Vercel Production (`VERCEL_ENV=production`): its functions were just pushed to the
  production deployment, so a failed read there is an outage and the build fails, leaving the
  last good deployment live (build-fallback-production). Outside the build the error propagates
  unchanged, and Next's own control-flow errors are rethrown first (`unstable_rethrow`). A
  `public-data: … failed during the build` warning in a build log means a page that should be
  static was not.
- **Signed-in readers get their extra in the browser.** The Convex client fetches the session after
  hydration and its queries rerun with it: the calendar's `events.list` and `restrictedCount`
  subscriptions gain a `@cam.ac.uk` reader's Cambridge-only events by themselves; a society
  profile's "Coming up" (`ProfileCamOnlyEvents`) and an event page that says "not available"
  (`RestrictedEvent`) ask `events.*` again only once the client is authenticated
  (`useSignedInEventWindow`, `useSignedInEvent`), so a signed-out view costs no extra read. The
  broker's `BrokerGate` waits for the client's session before asking `getBrokerAccess`. These
  additions are never in the server's HTML, so they are never in the shared cache.
- **The proxy still runs on every listing view** (it runs before the edge cache): one remembered
  existence check per instance and listing (`FOUND_TTL_MS`), as the 404 gate needs (below).
- **The auth client** reads the session once per page load, not on every tab focus
  (`sessionOptions.refetchOnWindowFocus: false`; the broker's area reads it again on focus,
  `AuthGuard`), and a browser with no cookie but PostHog's is answered `null` by the
  `/api/auth/[...all]` handler without asking Convex (`isAnonymousSessionRead`).
- **Region.** Functions run in Vercel's default `iad1` (Washington, D.C.), beside the Convex
  production deployment: its URL carries no region segment (`<name>.convex.cloud`, docs/deploy.md),
  which is Convex's default US East region (a non-default region is `<name>.<region>.convex.cloud`,
  `lib/convex-url.ts`). Moving functions to London would put a transatlantic round trip on every
  Convex read; the edge cache is what brings pages close to UK readers. Only a Convex deployment in
  an EU region would make `lhr1` / `dub1` the better choice.

### Unknown listing URLs (ENG-20)

`/societies/<slug>`, `/events/<key>` and `/talks/<key>` answer an unknown key with HTTP 404 and the
site's not-found page in the server's HTML, for browsers and crawlers alike. The page cannot do it
itself in Next 16: under a `loading.tsx` its `notFound()` comes after a 200 (a noindex soft 404),
and outside every Suspense boundary Next sends the 404 with an empty `html#__next_error__` shell
that only JavaScript fills in. (`/societies`, `/societies/<slug>`, `/events` and `/events/<key>`
have no `loading.tsx` since the SEO audit of 2026-11-02, content-in-hidden-suspense: a streamed
page put the H1, cards and JSON-LD in hidden `<div>`s after the footer, which non-JS extractors
drop. Their fallback `notFound()` is a real 404 status with that empty shell.) So `proxy.ts`,
matched on those three paths (and the rest of the talks pillar, for its AI-agent 403), decides first
(`lib/missing-listing.ts`): a malformed key (`isOrgSlug` / `isEventKey` / `isTalkKey`) is missing
without a Convex call; a well-formed one costs one anonymous indexed query (`orgs.exists`,
`events.locate`, `talks.exists`, which share their test with `getBySlug` / `get`); a talks.cam-derived
event is answered with a 308 to `/talks/events/<key>` (see "The talks boundary"), and a superseded
event key (ENG-47) with a 308 to the page of the event that took it over (`/talks/events/<survivor>`
when that one is talks.cam-derived; from either prefix, never back, since it is always another key;
`lib/missing-listing.ts` `eventListingState`). A missing listing
is rewritten to a path no route matches, so Next renders `app/not-found.tsx` with status 404: the
site's not-found page in the (site) frame, which becomes the talks not-found page in the browser
for a talk's address (`app/not-found-variant.tsx`; deciding on the server would need a request
header, see "Caching"). Router and
browser prefetches skip the proxy in its matcher (`missing` header conditions: Next strips
`next-router-prefetch` and `rsc` from the headers a proxy sees, so a check in code never fires).
Static siblings (`/talks/departments`, or a metadata file such as `opengraph-image` in the section;
the unit test fails on a new one not listed) and non-GET requests pass unchecked. A failed check, or
one slower than 800 ms, lets the page answer, so an outage never 404s a real listing. A found
listing is remembered per instance for as long as a page is cached (`FOUND_TTL_MS`, 300 s;
missing ones and a superseded key's redirect never: a later load can swap two keys' roles, and a
stale redirect beside a fresh one would loop), so repeat views skip the round
trip. A `cam_only` event exists for everyone: a visitor still gets its "not available, sign in"
page (200); see data-model §7. The pages keep their own `notFound()` as the fallback for a listing
hidden since the check. A client-side navigation to a missing listing becomes a full page load (the
rewritten RSC response is outside the (site) tree); a stale in-site link is rare, and the end state
is the same 404 page.

## Code quality

- Biome replaces ESLint and Prettier: 2 spaces, line width 100, double quotes, semicolons as
  needed, organize imports on, Next and React rule domains on. CSS is not linted (Tailwind v4
  syntax). `convex/_generated/` and `convex/betterAuth/_generated/` are excluded; `components/ui/`
  has relaxed a11y rules (generated code).
- Scripts: `bun run lint`, `bun run format`, `bun run check` (lint + format, writes),
  `bun run typecheck`, `bun run test`, `bun run check:codegen`, `bun run build`,
  `bun run e2e` (below).

## E2E smoke suite

`bun run e2e:install` once (Playwright's Chromium), then `bun run e2e`: it starts `next dev` on
port 3100 against the deployment in `.env.local` (or tests `E2E_BASE_URL`, production included)
and loads every public page at desktop (1440×900) and phone (390×844) size — the pages tagged
`@dark` again in dark mode — checking one `<h1>`, no horizontal overflow, a title, a description and a share image, no axe-core
violation (WCAG 2.1 A/AA, in the page's theme), no uncaught error or console error, then saving a full-page screenshot to
`<repo>/var/screenshots/<London date>/<E2E_LABEL or "latest">/<project>/` (gitignored). It also
opens the mobile filter sheet, an event's details and the calendar's "N ongoing" strip (skipped
when nothing began before today), and submits the request form. `E2E_PORT` picks another port
(another worktree's server on 3100 would otherwise be reused).

Every test starts with a stored analytics refusal (the `consent` fixture option), so the consent
banner neither covers what a test clicks nor sits in its screenshot; `e2e/consent.spec.ts` sets
`test.use({ consent: null })` to meet the banner as a first visitor.

**Read-only by construction** (`e2e/fixtures.ts`): the Convex WebSocket is routed through
Playwright and every `Mutation` / `Action` message is answered by the guard instead of the server
(the test fails if any page tries one); the request-form test registers a mock result for
`listingRequests:submit`, so the success state renders and nothing is written. Non-GET
`/api/auth/*` requests are aborted. Server-rendered pages call public queries only. The request
form posts to the site's own `POST /api/request` instead (below), which the guard blocks too unless
a test answers it with `guard.answerRequestForm(status, body)`.

**Accessibility gate (ENG-37).** `e2e/a11y.spec.ts` runs axe-core (WCAG 2.1 A/AA and best
practice) over the main public pages — home, directory, a profile, the calendar views, an event,
talks, about, privacy, terms, the request form, sign-in, a 404 — and the states a visitor reaches:
the request form with errors and after sending, the search palette, the consent banner. A serious or
critical violation fails it; moderate and minor ones are annotated and logged. The profile and
event are the first ones linked, so it needs no particular data. CI's `accessibility (axe)` job
(`.github/workflows/ci.yml`) builds against the dev deployment's public URLs (no secret; repository
variables `E2E_CONVEX_URL` / `E2E_CONVEX_SITE_URL` override them), then runs
`E2E_SERVER=start pixi run a11y` (`bun run e2e:a11y`: desktop and phone projects) over
`next start`. Locally, `pixi run a11y` runs it over `next dev` against `.env.local`.

**The request form's route (ENG-37, `lib/request-submit.ts`).** The form posts its arguments to
`POST /api/request` rather than calling the mutation from the browser. On Vercel the route runs
Vercel BotID's `checkBotId()` first (the browser half, `initBotId` in `instrumentation-client.ts`,
adds its challenge headers to that one request; next.config's `withBotId` rewrites carry the
challenge script from this origin) and answers a bot 403. Off Vercel neither half runs. The check
fails open only while BotID is not set up (no OIDC token or request context: the request is stored
and the failure logged); any other throw fails closed (503, the generic sentence with the contact
address), so a client cannot get past the check by making it throw. `REQUEST_BOT_CHECK=off` on
Vercel, plus a redeploy, switches it off. The browser's sender (`lib/request-client.ts`) is a
separate, zod-free module because `instrumentation-client.ts` imports its `REQUEST_PATH`, and that
file's imports load on every page; it aborts the request after 30 s. The route then calls `listingRequests.submit` with
`formSecret` = `REQUEST_FORM_SECRET`; once that is set on Convex too, the mutation refuses any other
caller (docs/deploy.md "Request form bot check"). Convex's refusals reach the form in its own words
(422); nothing the visitor wrote is logged. The outcome, "Request received" or "Not sent", takes
focus (`lib/focus.ts`), as does the sign-in form's "Check your inbox".
- Pre-commit: husky runs `webapp/.husky/pre-commit` (it `cd webapp`s, since `.git` is one level
  up; `prepare` is `cd .. && husky webapp/.husky`), which runs lint-staged →
  `biome check --write --no-errors-on-unmatched` on staged JS/TS/JSON. Unfixable lint errors block
  the commit.
- VS Code: `.vscode/settings.json` sets Biome as formatter with format-on-save.

## Authentication

Two tiers, both Better Auth inside Convex (`convex/betterAuth/auth.ts`); `/sign-in` offers both
(`?cam=1` preselects the Cambridge option, `?next=/path` is where a Cambridge sign-in lands).

- **Google, for the admin**, registered only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  are both set on the Convex deployment (otherwise sign-in answers PROVIDER_NOT_FOUND; nothing
  crashes). Broker access is `BROKER_EMAILS` (below).
- **`@cam.ac.uk` sign-in link** (Better Auth's magic-link plugin, supported by
  @convex-dev/better-auth 0.12.5), registered only when `RESEND_API_KEY` and `RESEND_FROM` are
  both set (otherwise the endpoint is a 404 and the form shows the option as off). The link is
  sent from the `/api/auth/*` HTTP action through Resend's HTTP API (`convex/lib/signInEmail.ts`),
  works once and expires in 10 minutes. The server refuses any address that is not exactly
  `@cam.ac.uk` (`lib/cam-email.ts`, the same rule `getViewer` uses) before storing anything, and
  throttles to 3 links per address per 15 minutes, 10 per client (a sha256 of the
  `x-forwarded-for` IP) per hour and 60 per hour overall — a cap an address that has signed in
  before never hits (`convex/authEmail.ts`, table `signInLinkSends`, hashes only, pruned after a
  day). A verified link means
  `emailVerified: true`, so `getViewer(ctx).isCamVerified` holds for that session.
- `auth.getSignInOptions` → `{ google, camEmail }` (booleans) and `auth.getViewerTier` →
  `{ signedIn, isBroker, isCamVerified }` are public queries for the UI. While `camEmail` is
  off, a signed-out visitor sees no Sign in in the header, and no page offers the Cambridge-only
  sign-in: not /events, a society page or an unavailable event's page under /events or
  /talks/events (`lib/sign-in-options.ts` on the server, an anonymous cached read like any other,
  so a switch reaches the cached pages within a revalidation); /sign-in shows only the options that are on, and says sign-in is not open when
  none is (ENG-35).
- Better Auth runs **inside Convex**. Flow: client → same-origin `/api/auth/*` → route handler
  (`lib/auth-forwarded-headers.ts`) → Convex site URL → Better Auth → session in the component's
  tables → `ConvexBetterAuthProvider` holds the token.
- `proxy.ts` passes everything through. `AuthGuard` only decides what to render. **Access is
  enforced in Convex**: every `convex/broker/*` function calls `requireBrokerUser`, which admits
  only verified emails listed in the Convex env var `BROKER_EMAILS` (comma-separated); unset or
  empty means nobody.
  `AuthGuard` sits in the root layout, so a public page's cached HTML depends on `isPublicPath`
  classifying the server's pathname: on Vercel an ISR re-render of "/" reports "/index", which
  `routePathname` (`lib/auth-routes.ts`) folds into "/" (SEO re-check 2026-11-03,
  home-ssr-spinner).
- OAuth callback (Google console): `<SITE_URL>/api/auth/callback/google`, dev and prod.
- Never re-export the library's `handler`/`getToken` from `lib/auth-server.ts`, and never add a
  `next.config` rewrite for `/api/auth/*` (see next.config.ts).

## Analytics consent

Nothing of PostHog loads, runs or stores before a visitor clicks "Accept analytics" (UK PECR reg 6
and the ICO's consent guidance). The pieces:

- **Store, `lib/consent.ts`** (pure TS, `lib/consent.test.ts`): localStorage `camsocs-consent` =
  `{"v":1,"choice":"granted"|"denied","at":"<ISO>"}`, in force for 180 days. Anything missing,
  malformed, of another version, expired or future-dated reads as no choice. Storage that throws
  reads as no choice, and a choice made on the page then holds in memory until it closes. The page's
  own latest choice wins over storage (so a refusal that cannot be written still beats an older
  stored grant, which is then removed); another tab's change, via the `storage` event, replaces it.
  `getConsent()`, `setConsent()`, `clearConsent()`, `subscribe()` (the `useSyncExternalStore`
  contract), `onConsentChange(cb)` (only real changes of choice; listeners hear a refusal before
  storage is cleared), `openConsentSettings()` (the reopen signal; every press counts, see
  `getConsentSettingsRequests()`) and `isConsentBannerOpen()`.
- **Withdrawal**: `setConsent("denied")`, `clearConsent()` and a refusal or withdrawal arriving from
  another tab call `clearAnalyticsStorage()` after the listeners have run, which
  deletes every `ph_*` / `__ph_*` cookie (host-only and each parent domain, path `/`) and
  localStorage / sessionStorage key. The analytics client calls `reset()`, turns persistence off
  and calls `opt_out_capturing()` from its `onConsentChange` listener (below).
- **Banner, `organisms/consent-banner.tsx`**: a labelled region (not a dialog: no overlay, no focus
  trap) fixed to the bottom, mounted in the root layout and hidden on `UNTRACKED_PATHS`
  (`/dashboard*`, `/sign-in*`, never tracked). Two identical outline buttons, the PostHog EU Cloud
  disclosure and a link to `/privacy#cookies`. Not in server HTML; appears after hydration. While
  open it sets `--consent-inset` (its height) on `<html>`, which `globals.css` turns into body
  `padding-bottom` and `scroll-padding-bottom`: the end of the page scrolls clear of it and a
  focused control is never hidden behind it (WCAG 2.2 SC 2.4.11). Capped at the viewport below the
  header and scrolling inside itself past that, so it stays readable at 400% zoom (SC 1.4.10).
- **Reopen, `molecules/cookie-settings-button.tsx`**: "Cookie settings" in the footer's CAMsocs
  column; each press moves focus to the banner (also while it is already open) and a choice returns
  focus to the button. A choice made without it (a first visit) hands focus to `<main id="main">`
  (`tabIndex={-1}`), not `<body>`.

## Analytics client

`instrumentation-client.ts` (Next runs it in the browser before hydration) calls `startAnalytics()`
from `lib/analytics-client.ts` (`lib/analytics-client.test.ts`, posthog-js mocked;
`e2e/analytics.spec.ts`). Full behaviour and settings: `docs/deploy.md` "PostHog (monitoring)".

- **Gate**: posthog-js is a lazy `import()` that runs only once `getConsent()` is "granted", with
  `NEXT_PUBLIC_POSTHOG_KEY` set and `navigator.webdriver` false. Any other state (including every
  page load without a grant) ends in `withdraw()`: `reset()`, persistence off, `opt_out_capturing()`,
  `clearAnalyticsStorage()`. A new grant on the same page opts the instance back in (posthog-js
  initialises once per page).
- **`before_send` = `sanitizeEvent`**: drops everything unless consent is granted at that moment, on
  `UNTRACKED_PATHS`, SDK events other than `$pageview` / `$pageleave` (`SDK_EVENTS`), and custom
  events without an allow-list entry; strips query strings and fragments, titles, element text,
  the user-agent string, the search keyword, campaign parameters, window size, device model and
  previous-page duration (each also as its `$initial_…` / `$session_entry_…` copy); sets
  `environment`, `campus` (see "Campus profile") and `$geoip_disable`. A throw drops the event
  (posthog-js), so it fails closed.
  At the source: `save_referrer` and `save_campaign_params` off (no URL in PostHog's cookie),
  `disable_capture_url_hashes`, `disable_scroll_properties`.
- **For ENG-6**: `getPostHog()` returns the instance only while it may send, else null; call it
  at the moment of use (`posthogReady()` waits for a package load under way first). `$exception`
  is already in `SDK_EVENTS` and goes through `sanitizeEvent`'s scrub; error boundaries report
  through `captureBrowserException()` (see "Error tracking" below).
- **Product events (ENG-5)**: `lib/analytics-events.ts` is the taxonomy, one table of event →
  property → value rule (key shapes, enums, bounded counts), read by both `track()`
  (`lib/analytics.ts`) and `sanitizeEvent` (the default `customEvents`). `track()` is a no-op
  unless the client runs and drops an event missing a required property. Client components call
  `track()`, `useTrackView` or `useTrackSearch` (`hooks/use-analytics.ts`); server components render
  `<TrackView>` (`molecules/track-view.tsx`) or spread `analyticsAttrs(...)` on a link, which the
  click tracker (`startClickTracking()`, started by `instrumentation-client.ts`) reads, with the
  nearest `analyticsContext({ orgKey })`. `providers/sign-in-tracker.tsx` sends
  `sign_in_completed` from the `?signed_in=cam` marker on the magic link's callback. Taxonomy,
  rules and how to add an event: `docs/analytics.md`.
- **Proxy**: `app/relay/[...path]/route.ts` (`lib/relay.ts`) forwards `/relay/static|array/*` to
  `eu-assets.i.posthog.com` and every other `/relay/*` to `eu.i.posthog.com`, by allow-list:
  only `content-type`, `content-encoding` and `accept` go out (no cookie: Better Auth's session
  and `convex_jwt` would otherwise reach PostHog), only `content-type` and `cache-control` come
  back. Not PostHog's `next.config` rewrites, which forward every header and cannot filter.
  `skipTrailingSlashRedirect` plus a `redirects()` rule keep Next's trailing-slash 308 for every
  path but `/relay`.

## Error tracking

PostHog error tracking (ENG-6); full behaviour, settings and the source map upload:
`docs/deploy.md` "PostHog (monitoring)", "Error tracking".

- **Server**: `instrumentation.ts` `onRequestError` (Node.js runtime only) → `reportRequestError`
  in `lib/posthog-server.ts`, which returns at once and sends in the background (`waitUntil`).
  Fixed distinct id `camsocs-server`, no person profile, no GeoIP; only the path without query
  string, the method, Next's router facts, `environment` and `campus` go with the exception, and the
  client's `before_send` (`sanitizeServerEvent`) drops everything else. Headers are never read.
  Nothing for `/dashboard*` / `/sign-in*` (path or route pattern); at most 10 reports per error
  and route per instance, then one per 10 s; nothing at all without `NEXT_PUBLIC_POSTHOG_KEY`.
  `captureServerEvent(event, props)` is the allow-listed sender for server counts (ENG-7 adds its
  events to `SERVER_EVENTS`). Tests: `lib/posthog-server.test.ts` (real posthog-node, recording
  `fetch`).
- **Browser**: `capture_exceptions: true` in the consent-gated client, with PostHog's
  exception-autocapture extension bundled into its lazy chunk (no external script);
  `app/(site)/error.tsx` and `app/global-error.tsx` call `captureBrowserException(error)`, a no-op
  unless the client runs, for errors without a `digest` (a server error was already reported by
  the server). `sanitizeEvent` scrubs `$exception` (`lib/error-scrub.ts`).

## Server counts

Aggregate PostHog events from server code, without consent (nothing touches the visitor's device;
record of processing P12). Full table, settings and caveats: `docs/deploy.md` "PostHog
(monitoring)", "Server counts". Fixed distinct id `camsocs-server`, no person profile, no GeoIP,
`environment` and `campus`; IDs and enums only.

| Event | Properties | Sender |
|---|---|---|
| `ics_feed_fetched` | `feed` (`talks` / `events` / `event` / `talk`), `key?` (a valid event or talk key) | the `.ics` route handlers → `countIcsFetch` (`lib/ics-telemetry.ts`) in `after()` → `captureServerEvent` |
| `listing_request_received` | `kind` (`LISTING_REQUEST_KINDS`) | `listingRequests.submit` schedules `internal.analytics.captureListingRequest` → capture API (`convex/lib/posthog.ts`) |

- A new server event needs an entry in `SERVER_EVENTS` (Next) or its own internal action (Convex),
  a row in both tables, and a check against P12 and `/privacy`.
- `ics_feed_fetched` is a lower bound: edge-cached `.ics` responses (one hour per URL) never reach
  the function.
- Neither can change or fail what it counts: the `.ics` response is complete before `after()` runs,
  and the Convex action swallows PostHog failures after the request is stored.
- Tests: `lib/ics-telemetry.test.ts`, `app/ics-routes.test.ts` (the route handlers with stubbed
  Convex, `after()` and sender, in their own process), `lib/posthog-server.test.ts`,
  `convex/analytics.test.ts` (convex-test, stubbed `fetch`).

## Campus profile

One deployment serves one campus (decision D8, `docs/campuses/README.md`). `lib/campus/` is the
campus registry, pure TS that Convex and Next both import: `profile.ts` (the shape),
`profiles/cam.ts` (Cambridge, today's literals), `index.ts` (`CAMPUS_IDS`, `getCampus`,
`currentCampus`), `deployment.ts` (Convex's `deploymentCampus()`, from the deployment's
`CAMSOCS_CAMPUS`), `terms.ts` and `member-email.ts`. The synthetic `zz` profile
(`profiles/zz.testing.ts`) is for tests only and never registered.

- **Next** reads `currentCampus()`: `NEXT_PUBLIC_CAMPUS`, inlined at build time; unset or empty
  means `cam`, and an unknown value fails the build. There is no `[campus]` segment, no host
  routing and no proxy change: each campus is its own Vercel project, so routing, caching and ISR
  are the same on every host.
- **Consumers keep their export names**, so their importers are untouched:
  - `lib/site.ts`: `SITE_NAME`, `SITE_TAGLINE`, `SITE_DESCRIPTION`, `SITE_INTRO`, the `SITE_URL`
    fallback (`origin`), `BOT_USER_AGENT`, `CAM_SIGN_IN_HREF`, `SHARE_IMAGE_ALT` and `DISCLAIMER`
    come from `brand`, `origin`, `botUserAgent` and `memberTier`;
  - `lib/events.ts`: `UNIVERSITY_NAME` and the JSON-LD organiser URL (`university`);
  - `lib/term-week.ts`: `TERM_NAMES`, `TERM_SHORT`, `TEACHING_WEEKS` and the weekday a week
    starts on (`terms`, `facts.terms.weekStartJs`);
  - `lib/llms-txt.ts`: the summary (`brand.llmsSummary`);
  - `app/_og/card.tsx`: the wordmark, the foot line and `GENERIC_HEADLINE`
    (`brand.shareHeadline`); `molecules/wordmark.tsx`: `brand.wordmark`;
  - `organisms/login-form.tsx` and `organisms/public-header.tsx`: the member tier's copy
    (`memberTier`, `place.name`, the first member domain);
  - `lib/analytics-client.ts` and `lib/posthog-server.ts`: the `campus` property on every event
    (the browser's super property, kept by `sanitizeEvent`; pinned by `sanitizeServerEvent`).
    Convex's sender adds the same from `CAMSOCS_CAMPUS` (`convex/lib/posthog.ts`). PostHog
    queries read `ifNull(properties.campus,'cam')`, since events before this change have none.
- **Cambridge is byte-identical.** Every Cambridge value is the literal it replaced; copy is
  rendered as one template string per text run, so the server renders the same text nodes as
  before (no `<!-- -->` separators). Checked by building base and branch with
  `NEXT_PUBLIC_CAMPUS` unset and diffing the served HTML of `/`, `/about`, `/sign-in` and
  `/llms.txt`.
- **Still Cambridge-only**, and launch blockers for a second site (`docs/campuses/README.md`):
  legal pages, directory titles and regexes, collegiate facets, category copy and the About
  page's sources.

## Environments

Dev and prod are separate Convex deployments of the `camsocs` project with independent data.
Production setup, step by step (Convex prod, Vercel, the pipeline's `--env prod`): `docs/deploy.md`.

- `.env.local` (written by `bunx convex dev`): `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`,
  `NEXT_PUBLIC_CONVEX_SITE_URL`, optionally `NEXT_PUBLIC_SITE_URL`. See `.env.example`.
- Vercel production: the three `NEXT_PUBLIC_*` values + `CONVEX_DEPLOY_KEY` (production only).
  A deploying build never defaults `NEXT_PUBLIC_SITE_URL` to localhost: unset, `lib/site.ts`
  uses `https://camsocs.uk`.
- Convex env (`bunx convex env set [--prod] …`): `BETTER_AUTH_SECRET`, `SITE_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PIPELINE_API_KEY`, `BROKER_EMAILS`,
  `RESEND_API_KEY`, `RESEND_FROM` (the last two switch on the `@cam.ac.uk` sign-in link),
  `POSTHOG_KEY`, `POSTHOG_HOST` (production only: the listing-request count, "Server counts").
- Inbound list mail (all optional; each unset means that sender is denied):
  `RESEND_WEBHOOK_SECRET` (the Resend webhook's `whsec_…` signing secret),
  `RESEND_INBOUND_API_KEY` (full-access key for the Receiving API; falls back to `RESEND_API_KEY`),
  `INBOUND_EMAIL_RECIPIENTS` (comma-separated addresses to accept; unset accepts none),
  `INBOUND_TRUSTED_AUTHSERV_IDS` (receivers whose DKIM / DMARC verdict counts; default
  `mx.microsoft.com`),
  `INBOUND_EMAIL_SECRET` (Bearer secret for the provider-agnostic JSON sender).
  Setup: `docs/setup/inbox-instagram.md`.

## Commands

```bash
bun run dev                          # Next.js dev server
unset CONVEX_DEPLOY_KEY; bunx convex dev        # Convex dev (keep running) — targets the dev deployment
unset CONVEX_DEPLOY_KEY; bunx convex dev --once # push functions once + regenerate convex/_generated
bunx convex env list                 # dev env vars (add --prod for production)
bun run build                        # compile check; deploys Convex only on Vercel with a key
bunx @better-auth/cli generate --output ./convex/betterAuth/schema.ts -y   # regenerate auth schema
```

⚠ Never export `CONVEX_DEPLOY_KEY` in a shell: it overrides `.env.local` and has deployed one
project's functions onto another project's production (2026-07-29).

## UI/UX

All frontend design decisions are governed by `webapp/DESIGN.md`. Any time UI is created or
modified, consult it. Sections marked ✏️ are meant to evolve.

Document titles stay within 60 characters (`MAX_TITLE_LENGTH`), " · CAMsocs" dropped first. A
profile's (`societyTitle`, owner decision G2) is the first that fits of: the society's own full name
naming Cambridge, "<Name>, Cambridge", a shorter name the sources give (longest first, as is when it
names Cambridge, else with ", Cambridge"), the name, and the name cut at a word with "…" (plus
", Cambridge"). Never "University of Cambridge …" of our making; a society so named leads with a
shorter name when the sources give one, else keeps its own.

## Public API

Everything a page needs comes from these Convex functions (via `hooks/convex/`). They are safe
for a signed-out visitor, return only the public projection (data-model §7,
`convex/lib/projections.ts`), and their `returns` validators are the exact types the client gets
(`FunctionReturnType<typeof api.orgs.getBySlug>` etc.). Never read the internal or broker tables
from a page.

### Who is looking

`convex/lib/viewer.ts` — `getViewer(ctx) → { userId?, email?, isBroker, isCamVerified }`.
`isCamVerified` = a *verified* email ending exactly `@cam.ac.uk` (not a subdomain);
`isBroker` = verified email on `BROKER_EMAILS`. `visibleEventTiers(viewer)` = `["public"]`, plus
`"cam_only"` for a cam-verified viewer or the broker. `members_only` is never visible. For the UI's
own "am I signed in / broker?" question use `api.auth.getCurrentUser` / `api.auth.getBrokerAccess`.

### Organisations (`convex/orgs.ts`)

Shared filter arguments (`OrgFilters`, `convex/lib/orgFilters.ts`) — OR within a facet, AND
across facets; an absent or empty facet does not filter:

```ts
{
  q?: string                         // full-text over name, aliases, short name/description, tags, category labels
  categories?: Category[]            // CATEGORIES
  levels?: OrgLevel[]
  orgTypes?: OrgType[]
  collegeKeys?: string[]             // org keys of colleges (orgs.colleges)
  activityTypes?: ActivityType[]
  audiences?: Audience[]
  statuses?: OrgStatus[]             // default: everything except "archived"
  sport?: { blueStatus?: BlueStatus[], beginnerFriendly?: boolean, gender?: GenderCategory[] }
}
```

Counterparts (`isCounterpart`: colleges, companies, offices) are never listed.

| Function | Args | Returns |
|---|---|---|
| `orgs.list` | `OrgFilters & { sort?: "relevance" \| "name" \| "active", paginationOpts }` | `{ page: (OrgCardPublic & { activity? })[], isDone, continueCursor }` — `relevance` (default): search rank with `q`, else name; `name`: A–Z also with `q`; `active`: most counted events this term first (`convex/lib/orgActivity.ts`: public events a listing organises or co-hosts, not taking-part ones). `activity` = `{ count, inTerm, next?: { startsAt, allDay, termWeekLabel? } }` (term = Week 0 to the end of Full Term; outside term, the next 8 weeks). Works with `usePaginatedQuery` (cursor = offset) |
| `orgs.facets` | `OrgFilters` | `{ total, categories, levels, orgTypes, collegeKeys, activityTypes, audiences, statuses, blueStatus, gender, beginnerFriendly, truncated }`, each but the last `Record<value, count>`; disjunctive (a facet ignores its own selection); `total` = what `list` returns; `truncated` when a search matched more than one query returns (1,024, Convex's limit) and the counts cover the best matches only |
| `orgs.exists` | `{ slug }` | `boolean`: whether `getBySlug` would show a listing (not hidden, not suppressed); viewer-independent, for the 404 gate in `proxy.ts` |
| `orgs.getBySlug` | `{ slug }` | `null` or `{ org: OrgPublic, teams: TeamPublic[], sessions: SessionPublic[], events: EventListItem[], relationships: RelationshipPublic[], hasPublicEvents? }`; events are upcoming (from London midnight today, plus multi-day runs still on), at most 50, gated by the viewer, without withdrawn or talks.cam-derived ones (`isTalksDerivedEvent`); relationships are public edges with `direction` and the counterpart's `{key, slug, name}`, whose evidence never links a talks.cam page (an edge seen only on talks.cam pages is left out); `hasPublicEvents`: any public event not from talks.cam, past or upcoming, viewer-independent (decision G3). The whole result is passed through the talks guard (decision G1) |
| `orgs.hub` | `{ category?, collegeKey? }` | Every listing of one category or one college, by name: `{ key, slug, name, shortName?, shortDescription?, orgType?, level?, status, collegeKeys, categories, sport?: {sport?} }[]` (no logo, no activity); the directory's rules (no counterparts, nothing archived). For the hub pages (decision G13) |
| `orgs.sitemap` | `{ cursor?, numItems? }` | `{ page: { slug, kind: "listing" \| "college", updatedAt, indexable }[], isDone, continueCursor }` (offset cursor, ≤ 100 a page): every listing and college page; `indexable` false for a thin profile (no description, no public event, no website: decision G3, `lib/directory-indexing.ts` `isThinListing`, judged on the same guarded projection the profile shows, so suppressed fields, talks.cam websites and talks.cam events do not count) and a college that lists nobody; a listing removed on request is left out. Read by `lib/sitemap-societies.ts` |
| `orgs.colleges` | `{}` | `{ key, slug, name }[]` of colleges, by name (for the college filter) |
| `orgs.busy` | `{ limit? }` | `{ label?, from, to, orgs: { card: OrgCardPublic, count }[] }` — the "Busy this week" shelf: listings with the most counted, not cancelled events this term week (Thu–Wed; `label` "MT26 Wk 4"), else the next 7 days; at most 12 |
| `orgs.related` | `{ slug, limit? }` | `OrgCardPublic[]` (≤ 6): the same college first, then what the group does: the same sport, shared categories, telling words shared in the name, the same specific kind, shared activities and audiences (`relatedScore`); ties in a fixed per-pair hash order, never the alphabet; empty for an unknown or hidden slug |

Every card these return (`list`, `busy`, `related`, `hub`) and the whole of `getBySlug` are
stripped of talks.cam content (`lib/directory-talks-guard.ts`, decision G1): talks.cam events and
links, values whose source is talks.cam, and relationships resting only on talks.cam pages. The
directory and profiles are open to AI crawlers; talks.cam content stays under `/talks`.

`OrgCardPublic`: `key, slug, name, shortName?, shortDescription?, orgType?, level?, status,
collegeKeys, categories, activityTypes, audiences, beginnerFriendly?, sport?: {sport?, blueStatus?,
genderCategories}, logoUrl?`.

`OrgPublic`: every public organisation field of data-model §2 (with `logo: {url, credit?}`, no
personal email, `mailingList: {platform?, signupUrl?}`), plus `missingFields`, `updatedAt` and
**`meta: Record<field, PublicFieldMeta>`** — one entry per claimable field, including dotted ones
(`meta["sport.blueStatus"]`, `meta["registrations.su"]`). Render a `SourceLine` from it:
`status` (chip), `sourceUrl` host (absent for internal sources: show "private source"),
`retrievedAt` (date), `confidence`, `claimCount`; `conflicting` comes with `conflicts[]` (the other
readings, each with its source) — show both; `missing` comes with `missingReason`
(`not_attempted` = nobody has looked yet).

### Events (`convex/events.ts`)

| Function | Args | Returns |
|---|---|---|
| `events.list` | `{ from, to, categories?, eventTypes?, orgKey?, q?, collegeKeys?, includeTakingPart?, university?, talksCam? }` (epoch ms, `to` exclusive, window ≤ 186 days) | `EventListItem[]` by start time (≤ 1000), gated by the viewer: events starting in the window and multi-day events still running in it; `q` keeps titles holding every word; `categories` / `collegeKeys` match the organisers' or co-hosts' (so never a University listing, which has none); `includeTakingPart: false` leaves out events societies only take part in (`hosting: takes_part`, decision D6; included by default); `university: "hide"` leaves out the University's own listings (`fromUniversity`, ENG-24) and `"only"` lists nothing else (both kinds by default); `talksCam` (`exclude` by default, `only`, `include`): talks.cam-derived events (see "The talks boundary" below). The window is read per tier and per stream (`events.stream`, ENG-31: indexes `by_stream_visibility_startsAt` and `by_stream_visibility_spanEndsAt`); `university` picks the streams read. The streams of one tier share one read budget, the bound from before ENG-31: 1,000 starting and 200 spanning rows, society events first, then rows not yet backfilled, then the University's in what is left (`events.ts` `tierRows`). A list therefore reads at most 1,200 events per tier, 2,400 for a signed-in viewer's two (~11.5 MB at the 4.8 KB mean measured on dev 2026-11-04, inside Convex's 16 MiB read limit per function), and University listings never take a society event's room. The 1,000-row cap is then applied society events first: every society event of the window up to the cap, then the University's listings in the room left, earliest first — a Cambridge Festival window of University listings can drop only its own later days, never a society's event, and the University view has the whole cap. Only when filters (`q`, `eventTypes`, talks.cam) drop society rows read can the University get fewer rows than the cap's room, as with any filter applied after the read. Rows written before `stream` existed are read through the `stream`-unset range and classified in memory until the backfill has run (data-model §2 `stream`; above 1,000 events a tier they compete by start time as before ENG-31, so production backfills straight after the deploy, deploy.md). Never: events whose every host is hidden, withdrawn events (data-model §2 `sweepGroup`), superseded events (data-model §2 `supersededBy`, ENG-47) |
| `events.get` | `{ key }` | `EventPublic \| null` (null also when the viewer may not see it, every host is hidden, or it was withdrawn or superseded) |
| `events.requestLabel` | `{ key }` | `{ title: string \| null }`: the title `get` would show this viewer, null when it shows nothing or for a talks.cam-derived event (G1); for the request form at `/request?event=`, so no talks.cam text reaches it |
| `events.exists` | `{ key }` | `boolean`: whether `get` would return the event to a verified @cam.ac.uk viewer (so `cam_only` is true for everyone; `members_only`, withdrawn, suppressed or every host hidden is false); for the 404 gate in `proxy.ts` |
| `events.locate` | `{ key }` | `"missing" \| "event" \| "talks" \| { supersededBy, talks }`: `missing` when `exists` is false, `talks` for a talks.cam-derived event (its page is `/talks/events/<key>`), `{ supersededBy, talks }` for a key another source's event took over (ENG-47, data-model §2 `supersededBy`: the survivor's key, following at most 3 retirements, and whether its page is under /talks; `missing` when the chain loops or ends at nothing shown); for the gate in `proxy.ts` |
| `events.restrictedCount` | same args as `events.list` | `{ camOnly }`: how many `cam_only` events are hidden from this viewer in the whole London weeks around `from`–`to` (at least one week, four with `orgKey`; `q`, types, categories and colleges ignored; talks.cam-derived events count unless `talksCam: "exclude"`, which a society profile passes) — a coarse count for the "N Cambridge-only events in these weeks, sign in" note, never an oracle (data-model §7). 0 when they can see them |

`EventPublic` (`events.get`, the details sheet): `key, title, description?, startsAt, endsAt?,
allDay, termWeekLabel?, venueKey?, venueText?, organisers: {key, slug, name, role}[], speakers,
price?, bookingUrl?, signupRequired?, visibility, eventType, imageUrl?, cancelled, status, source,
sourceUrl? (absent for mailing-list events), hosting, externalUrl?, talksDerived, fromUniversity, lastSeenAt,
confidence, meta`.

`hosting` (decision D6) is `hosts` or `takes_part`: someone else's event (a CTF, a conference,
another university's event) the listed societies only take part in. The UI then names them as
taking part ("Cyber Security Society takes part", the "Taking part" badge, a dashed card),
never as organisers, and links `externalUrl` — the event's own page, present only for
`takes_part` — off-site; the calendar leaves them out by default (`includeTakingPart: false`)
and its "Include taking part" toggle (`?external=show`) lists them.

`fromUniversity` (ENG-24) marks the University's own listings: read from the University of
Cambridge's public events programme (`source: uni_events_api`) and credited to no student group
as organiser or co-host. It is derived in the projection (`convex/lib/derived.ts`
`isUniversityListing`) at every read; its stored, indexed copy `events.stream` (ENG-31) only
selects rows for `events.list`. An event of the programme that names exactly one society is
that society's and is not `fromUniversity`.
`fromUniversity` says only that no student group is linked here, not who runs the event (a
department, a college, a museum, two societies): the UI says "listed by" the University, never
that no society runs it. The UI names the University in words ("University of Cambridge", the "University" badge with a
landmark icon, never a University mark) and has no page for it: the event page's side panel is
"From the University", linking the event's page in the University's programme (`sourceUrl`) and
the calendar's University view; its JSON-LD `organizer` is the University
(`https://www.cam.ac.uk`) and its `sameAs` that page; its `.ics` and calendar links say it is
listed in the University's public events programme, with that page. University event pages are
indexed like any public event (decision of 2026-11-02).

The calendar's "All · Societies & clubs · University" switch (`?university=hide|only`, default
all; `lib/url-state.ts` `UniversityView`) sits under the headline. The University view drops and
greys out the category, college and society filters, which match through organiser cards, with
a one-line reason. The headline counts societies from the student groups credited and the
University's listings apart ("… from 12 societies and clubs · 4 from the University"). The
University view shows no "Cambridge-only events, sign in" note: its listings are all public, so
`events.restrictedCount` is not asked there. The home
page's columns stay societies' and clubs' events; the University's are one link, "N University
events this week", to `/events?university=only`.

The `/events` page (`components/organisms/events-calendar.tsx`, URL state in
`lib/url-state.ts`) loads one week at a time: `?weeks=N` (1–8, "Show next week") from
`?date=` (default today), or a `?preset=` range (today, tomorrow, week, weekend, term), never
less than a week so the week strip has a count for every day. The search box (`?q=`) is
matched in the browser over the loaded days, against title, organisers and venue
(`lib/events.ts`), so `q` is not sent to `events.list`. Each event has a page,
`/events/[key]`, and a one-event `.ics` at `/events/[key]/ics` (read with the viewer's
session; a Cambridge-only event's file is `private, no-store`). `/events.ics` is the feed of
the next 60 days' public events, "Cambridge events · CAMsocs": societies' and the University's
own listings, as the calendar's default (`?org=<slug>` for one society's, named for it),
edge-cached an hour, and the calendar and event pages advertise their `.ics` as a
`text/calendar` alternate. It reads `events.list` once, so the cap there applies: society
events first (ENG-31), so in a Cambridge Festival window the feed can lose only the
University's later days; `university: "hide"` would read the society stream alone.

For search engines the calendar is two pages (`lib/url-state.ts` `eventsIndexing`): `/events`
and one society's `/events?org=<slug>` (which loads four weeks, `ORG_WEEKS`), each canonical
with its own title; every other combination of the URL's filters is noindex, follow with the
canonical of the page it slices. A society's calendar is indexable only while its four weeks
list an event and its profile is not thin (G3); an empty one is noindex, follow and keeps its own
canonical (the metadata reads the page's own cached `events.list`), and the profile's calendar
links are nofollow while it shows "Nothing coming up" (SEO re-check 2026-11-03,
events-param-urls). Both indexable pages carry a CollectionPage / ItemList of the event pages on
screen. "Show next week", "From <day>", the week and month arrows, "Today" and the day cells are
real links for readers (handled in place on a click), but every slice of the calendar is a
robots.txt trap since the bot policy of 2026-11-03: robots.txt disallows it and the links carry
`rel="nofollow"` (`lib/crawl-traps.ts` `crawlerTrapRel`, the one list app/robots.ts reads). So do
the directory's filter, facet and search links, the home page's "Try" and day links and the talks
department index's A-Z view; `/events?org=<slug>`, `/societies?page=N`, `/talks?dept=` and
`/talks?school=` alone stay followed. An event page's "All its events" link is its lead
society's canonical calendar, `/events?org=<slug>` (`eventsIndexing(...).canonical`), never a
slice. Event pages are found through the sitemap
(`sitemaps/events.xml`), the canonical calendars and the society profiles, whose rows link them;
an event page's breadcrumb is "Events" alone (no day crumb, which would point at a trap), the same
in its JSON-LD BreadcrumbList. Neither `/events` nor `/events/[key]` has a
`loading.tsx`: their H1, text and JSON-LD are in the first HTML chunk.

`EventListItem` (`events.list`, a profile's upcoming events): `key, title, startsAt, endsAt?,
allDay, termWeekLabel?, venueKey?, venueText?, organisers, visibility, eventType, cancelled,
status, source, sourceUrl?, hosting, externalUrl?, talksDerived, fromUniversity, meta?` — no description, speakers, price,
image or full `meta`: `meta` holds only `startsAt: { status, method?, sourceType? }`, which decides (with the fields above)
whether the event's page has an Event node (`eventHasStructuredData`), so a profile's JSON-LD links
only events whose `@id` exists. A month of events
was ~450 KB with them and is ~50 KB without (`scripts/measure-public-api.ts`, dev data 2026-10-09);
the sheet reads the rest with `events.get`.

### The talks boundary (owner decision G1)

No talks.cam-derived text (a talk's title, speakers, abstract, a department's talk listing, a
talks.cam URL) appears in the server HTML, RSC payload, JSON-LD, sitemap or feeds of any URL outside
`/talks`: robots.txt keeps AI agents out of `/talks` only, as talks.cam's own robots.txt keeps them
out of talks.cam (`lib/crawlers.ts`). The rule is `lib/talks-boundary.ts`: a society event is
talks.cam-derived when its source is `talks_cam`, its source URL, own page, booking link or
description points at talks.cam, or any field's provenance (`meta[field].sourceUrl` or a
conflicting reading's) is on talks.cam.

The rule runs in Convex only, over the stored event: a projection drops fields it reads
(`externalUrl` outside `takes_part`, a mailing-list event's `sourceUrl`, and a list item's
description and booking link), so running it again there could disagree with `events.locate` and
send a talks.cam-derived event's readers to the wrong side. Its answer travels as `talksDerived`
on `EventListItem` and `EventPublic`; pages, links (`eventPath`), feeds and JSON-LD read that.
Such an event:

- is left out of `events.list` unless the caller passes `talksCam` other than `exclude`, which no
  server module outside the /talks routes does (`app/talks-boundary.test.tsx` scans app/,
  components/ and lib/ for it); `/events` adds them in the browser after hydration
  (`useTalksSideEvents`), and `orgs.getBySlug` leaves them out of a profile's "Coming up";
- has its page at `/talks/events/<key>` (and `.ics` beside it), with no JSON-LD; `/events/<key>`
  answers 308 there (`proxy.ts`, `events.locate`, with `Cache-Control: no-store`; the page and the
  `.ics` route redirect too, should the proxy's check fail). Only outward
  (`talksBoundaryRedirect`): `/talks/events/<key>` renders any event, one not talks.cam-derived
  with its canonical at `/events/<key>`. The proxy reads `events.locate` fresh while the pages read
  `events.get` through Next's Data Cache (300 s), so for a while after a harvest changes an
  event's verdict the two can disagree; a redirect each way then looped;
- is never in a sitemap or `/events.ics`, and never drawn on a share card (`lib/og-card.ts`, by
  `talksDerived`).

Two predicates, one host test: `isTalksCamUrl` (`lib/talks-boundary.ts`) is the only talks.cam URL
check. The stored-event rule above uses it, and so does the directory's deep guard
(`lib/directory-talks-guard.ts` `withoutTalksCam`), which strips talks.cam links, values read from
talks.cam and relationships resting on talks.cam pages alone from every `orgs.*` result; its
`isTalksCamEvent` takes a projection's `talksDerived` verdict first. A society's connection whose
evidence is all talks.cam pages is left out of `getBySlug` (the co-hosting rests on talks.cam
alone); one with other evidence keeps it, minus the talks.cam links.

The home page's Talks column carries counts from the server; its rows (titles, speakers, series) are
read in the browser once hydrated (`HomeOverview`, `homeTalkRows`).

### Reference data and the form

| Function | Args | Returns |
|---|---|---|
| `venues.list` | `{}` | `{ key, name, aliases, address?, collegeKey?, lat?, lng? }[]` by name |
| `venues.get` | `{ key }` | one venue (same shape) or null — an event page's Place |
| `termDates.list` | `{}` | `{ academicYear, term, fullTermStart, fullTermEnd, sourceUrl }[]` in calendar order |
| `runs.lastHarvest` | `{}` | `{ finishedAt } \| null`: when the last run that wrote data (`success` / `partial`) finished — the run log's only public read |
| `listingRequests.submit` (mutation) | `{ kind: "claim"\|"correct"\|"remove"\|"object"\|"add", orgKey? (required unless add, or a correct with an eventKey: a University listing has no host), submitterEmail, role?, message (10–5000 chars), fields?: Record<field, string>, eventKey? (`evt-…` of a stored event; not with add), formSecret? (only from `/api/request`; required once `REQUEST_FORM_SECRET` is set, ENG-37) }` | `{ key }`. Throws a `ConvexError` whose `data` is a user-readable message on invalid input, an unknown listing or event, or a full budget: per address, per listing (when one is named), or overall, hourly and daily (removals and objections have their own; a listing's first requests of the day may pass the overall one, up to a bounded reserve; `convex/listingRequests.ts`) (a plain `Error`'s message is hidden in production) |

Labels for vocabularies: `CATEGORY_LABELS` and the other `*_LABELS` records in `lib/vocab.ts`
(`ORGANISATION_FIELD_LABELS` names each claimable field for visitors).

## Broker API (private)

Broker mutations throw `ConvexError`s (or plain errors) whose message `hooks/convex/broker.ts`
`errorMessage` turns into the toast.

Every function in `convex/broker/*` calls `requireBrokerUser` first; `convex/broker/gating.test.ts`
reads the directory, calls every exported function with validator-generated arguments, and fails
unless each refuses a signed-out caller, a non-listed account, an unverified broker address and
everyone when `BROKER_EMAILS` is unset. No internal functions live there. Read models are in
`convex/lib/brokerRows.ts`; pure analysis (coverage, matching, outreach CSV, graph layout) is in
`lib/broker/` so the browser and `bun test` share it.

| Module | Functions |
|---|---|
| `broker/orgs` | `page` (paginated slim rows of every organisation, incl. counterparts and hidden: coverage flags, missingFields, the outreach address (`bestRoleAddress`: a role address with its `EMAIL_TYPES` kind, never a personal CRSid, lists.cam.ac.uk or webmail address) and `nextAddresses` (the other such addresses, in the order to try them after a bounce), `webmailAddresses` (every published webmail address, best first, for the webmail-only export), held fields, source hosts, needs/offers chips, suppressed), `search({q})`, `detail({key})` (full row with meta, orgInternal, profile, people, relationships, interactions), `updateProfile`, `setNeedOffer` (`confirmed` / `rejected` / `null` = forget), `setHidden` (showing a listing again is refused while it is on the suppression list) |
| `broker/people` | `list` (each row with `sensitiveBecause` and `sensitiveProblem`, why a stored row breaks the sensitive-society rules), `rules({orgKey})` (what a manual entry there may hold: `sensitiveBecause`, `website`, `staleAfterLimit`), `create`, `update` (the row becomes `manual`; `sourceUrl`, `consentRecord`; checked as it would be after the edit), `setArchived`. Both writes refuse a suppressed person (key, or a suppressed name anywhere in the typed name) or listing and, for sensitive societies (`lib/broker/sensitive.ts`, DPIA-lite §5), a source off the society's own website, links, notes, a later `staleAfter` and unrecorded consent, as `ConvexError`s the form shows; stored rows that break those rules are counted, without names, by the internal `coverage.sensitiveOfficers` (post-deploy check) |
| `broker/interactions` | `list({orgKey?})`, `followUps({days?})`, `create`, `update`, `completeFollowUp`, `remove`, `recordSendLog({entries: {orgKey, email, sentOn, bounced}[]})` (the outreach send log, ≤ 200 rows a call: one email interaction per organisation, address and date, keyed so a second import changes nothing; a bounce adds a follow-up; returns counts, unknown organisations and addresses the listing does not show) |
| `broker/introductions` | `list`, `create` (each side one org or one person), `update`, `remove` |
| `broker/graph` | `relationships({types?})` (nodes + edges, public and internal), `ecosystem({layers?, types?})` (the graph page's ecosystem map, `lib/broker/ecosystem.ts`: layers `relationships` (the default), `cohosting` (hosted, uncancelled events with a co-host or sponsor over the last 3 academic years, counted org↔org per academic year), `sponsors` (past sponsors and `sponsors` relationships) and `outreach` (introductions as edges, interactions as a count); node ids `${campus}:${key}` from `CAMSOCS_CAMPUS`; people only as a count per organisation, never nodes; sensitive societies flagged `sensitive`; hidden and suppressed listings left out of every layer but `relationships`; talks.cam evidence and talks.cam-derived events excluded (`lib/talks-boundary.ts`), as is a sighting whose event was not read; `truncated` when any read hit its limit), `matches` (complementary needs/offers and past sponsors of similar societies, `lib/broker/matching.ts`) |
| `broker/overview` | `summary` (events next 14 days by source, latest runs, open requests, due follow-ups, stale people, introductions by status, the latest `coverage` snapshot, the latest resolve stage's `quarantine` counts), `refreshCoverage` (schedules the fold now) |
| `broker/listingRequests` | `list({status?})`, `setStatus`, `acceptCorrections({key, corrections: {field, value}[]})` (claim / correct → `owner_submitted` claims through `internal.ingest.claims.ingest`, run as a sub-transaction; all or nothing), `acceptRemoval({key, scope, fields?, address?, personKeys?, eventKeys?, name?})` (remove / object → suppressions, enforced at once; `event` and `name` need no listing) |
| `broker/suppressions` | `list({orgKey?})` (an address shows only as `contact: true`), `lift({key})` |
| `broker/session` | `me` |

### Sending the Art 14 notice

The phase-2 outreach email is also each society's UK GDPR Art 14 notice (J7). Nothing in the app
sends it; the broker sends it and records what went out, which is the Art 5(2) evidence of who
was told and when. Send it by **9 Nov 2026**: Art 14(3)(a) allows one month from the 9 Oct
harvest that collected the data.

1. **Export.** `/dashboard/reports` → "Download outreach CSV": one row per listed, non-suppressed
   society with an outreach address (`lib/broker/outreach.ts`). The address is a role address
   (`email`, with `role` and `email_kind`; `next_emails` holds the others to try after a
   bounce); personal CRSid, lists.cam.ac.uk and webmail addresses are never chosen. A society
   that publishes only those, or no address at all, is left out of the CSV and counted under "No
   outreach address", complete listing or not; it needs the webmail-only file (step 6) or
   another route (step 5). `notice` holds the personalised text; `sent_on` and `bounced` are
   empty.
2. **Send** with the mail merge script `ops/outreach/art14-mail-merge.gs`, from the published
   contact address (`CONTACT_EMAIL`, a "Send mail as" address of the Workspace account, so
   replies reach it). Import the CSV into a new Google Sheet (File → Import → Upload → "Replace
   current sheet", with "Convert text to numbers, dates and formulas" **off**), then
   Extensions → Apps Script, paste the script, save and reload: the sheet gets an "Art 14
   notice" menu. "Check the setup" confirms the sender and the day's quota; "Send a test to me"
   sends the first row to your own @cam.ac.uk address (check where it lands: inbox, junk or
   quarantine); "Send the next batch" sends up to 100 rows, one email per row (never Cc or
   Bcc), and writes the date into each row's `sent_on` as it goes, so a stopped run leaves an
   exact log. Apps Script allows 1,500 recipients a day from a Workspace account.
3. **Bounces.** After a batch, wait an hour and run "Mark bounces": it reads the bounce
   messages (`from:mailer-daemon OR postmaster`, failures only, not delay warnings) and puts
   `yes` in `bounced` for each address one names. "Queue the next address for bounces" then
   appends a row for the next address in that society's `next_emails` (the other role
   addresses its listing publishes, best first), to go out with the next batch; a society with
   none left is named, and needs step 5.
4. **Log.** File → Download → CSV, and "Import send log" on the same dashboard page. Any bad row
   stops the whole file with the row named; nothing is recorded until it is fixed. A minimal log
   with just `org_key,email,sent_on,bounced` works as well (`sent_on` as `YYYY-MM-DD`; a UK
   `DD/MM/YYYY` is read too). A bounce becomes a follow-up on the interaction ("Send the notice
   to the next role address, or find another route"). Import again after each round: rows
   already recorded are left as they are, and a bounce is never undone. An interaction you
   have edited since (a reply, a new address) is not overwritten.
5. **Other routes.** For each society under "No outreach address", send the notice (the
   "Notice" button copies its text) through its contact form or social account, then add an
   interaction from its drawer: channel `message` (or `other`), summary "Art 14 notice
   (outreach) sent via … on YYYY-MM-DD". That is the record for those societies; the import
   takes email sends only.
6. **Webmail-only societies (your choice).** "Download webmail-only CSV (Art 14)" on the same
   page gives the societies whose only usable published address is webmail (a society
   @gmail.com, @outlook.com and the like), in the same columns (`webmailOutreachCsv`). The
   outreach CSV never holds them, because a webmail address may be one officer's own; whether
   to send to them is yours. `email_kind` is `webmail` on every row, and each notice adds that
   it went to the contact address the society publishes and asks the reader to pass it to the
   committee if it reaches one person. CRSid and alumni addresses are personal under
   `classifyEmail` and are never in it; nor are hidden, suppressed or counterpart listings. The
   "No outreach address" tile says how many there are, and the "Notice" button on such a row
   shows the webmail text. To send them, import the file as a **second sheet** of the same
   spreadsheet (File → Import → Upload → "Insert new sheet(s)", conversion off) or into a
   separate Google Sheet with its own copy of the script. Every menu item works on the tab in
   front, and "Check the setup" names it: select the webmail tab and run steps 2–3 the same way
   (check, test, batches, "Mark bounces" on that tab, then "Queue the next address", which
   keeps `email_kind` as `webmail`). Both tabs draw on one daily quota. Then File → Download →
   CSV *with the webmail tab selected* and "Import send log" as in step 4; the import records
   the sends the same way. A webmail-only society you do not send to still needs step 5, or
   the disproportionate-effort measures in DPIA-lite §4.

`sent_on` must fall between 1 Oct 2026 and today. A date outside that, usually a sheet in a US
locale that wrote 5 Nov as `11/5/2026`, stops the import with the row named; a file with an
unclosed quote is refused as a whole.

Each recorded send is an `email` interaction on the organisation ("Art 14 notice (outreach) sent
to … on …"), shown in its drawer and under Interactions.

## Ingestion API (pipeline only)

`POST /api/pipeline/<path>` with `Authorization: Bearer $PIPELINE_API_KEY`; batches ≤ 500 rows
(`MAX_BATCH`). Bodies and responses are modelled in `pipeline/src/camsocs_pipeline/models/wire.py`
(the route table is in its docstring); the pipeline calls them through `ConvexLoader`
(`pipeline/load.py`). Errors: 401 bad key, 400 validation (message names the field), 404 "not
found". Item-level refusals (a bad claim, an unknown event) come back in the 200 response
(`rejected`, `missingEvents`, `missing`) and the rest of the batch lands.

| Path | Writes |
|---|---|
| `claims` | `fieldClaims` + the entity row (created on first claims), re-resolved and re-derived; `{inserted, updated, unchanged, entities: {created, updated, unchanged}, rejected[]}`. A claim the suppression list forbids is `rejected` ("suppressed: …") |
| `sources` | `sources` by key (`src-<sha1(url)>`) |
| `orgInternal` | `orgInternal` by orgKey (patch; lists merge); a suppressed listing's patch is skipped (`suppressed`) |
| `relationships` | `relationships` by server-minted key, evidence merged; edges with a suppressed end skipped (`suppressed`) |
| `eventOrganisers` | replaces each event's organiser set; mirrors it on the event; co-host / sponsor edges; suppressed listings left out of the set |
| `brokerInferences` | inferred needs/offers and public-source people (never overwrites manual / confirmed); suppressed listings and people skipped (`suppressed`) |
| `files` | `{data: base64, contentType}` → `{storageId, sha256}` (≤ 2 MB, raster image or PDF, deduplicated) |
| `inbound/pending`, `inbound/mark` | read pending list mail; record extraction outcome |
| `crosswalk` | read: `{cursor?, limit?}` → a page of `{orgKey, name, aliases, shortName, orgType, level, collegeKeys, isCounterpart, suOrgId, suSlug, proctorsName, sportSlug, camdramSlug, camdramId, cucbcClub, instagramHandle, websiteDomain}`, for the pipeline's identity resolver |
| `inbound/file` | `{messageId, storageId}` → `{data: base64, contentType, filename}`: one attachment (or the HTML body) of that mail only |
| `worklist` | `{paginationOpts}` → a page of non-counterpart organisations with status, mailing list, Sympa list, feeds on record and upcoming event sources (read by `camsocs worklist`) |
| `suppressions` | read: `{}` → `{organisations, fields: {orgKey, field}[], contactHashes, people, truncated}` — what the load stage filters by before posting |
| `coverage` | read: `{cursor?, limit?}` → `{counts, rows, isDone, continueCursor}`, one page of organisations folded into coverage counts (the coverage report sums them) |
| `coverage/events` | read: `{from, cursor?, limit?}` → events starting at or after `from` by source and visibility, a page at a time |
| `termDates` | Full Term dates by (academicYear, term); re-labels events |
| `derive` | schedules the daily re-derivation now |
| `purge` | `{confirm: "PURGE-DEV"}`; empties pipeline tables, **dev deployment only** |
| `events/scan` | read: `{cursor?, limit?}` → a page of every event (any visibility) with its title, start of description, venue, source, hosting, organisers, `sweepGroup`, `lastSeenAt` — for `camsocs clean-events` |
| `events/remove` | `{keys, confirm: "REMOVE-EVENTS"}` (events only, ≤ 25 a call) → `{removed, missing}`: deletes events as `ingest/purge:removeEntity` does (docs/deploy.md §7) |
| `events/superseded` | `{events: [{key, by}]}` (≤ 500) → `{updated, unchanged, unknown, rejected}`: each event key whose reading this load folded into another source's event `by`, or an LLM stage dropped as that event's (ENG-47, `convex/ingest/superseded.ts`); sets `supersededBy` on an existing old event, counts a key or survivor the deployment lacks as `unknown` (the load's note shows the count). The load posts it after the organiser sets; a 404 (route not deployed yet) is a warning, not a failure |
| `runs/start`, `runs/finish` | the run log |

## Inbound mail webhook

`POST /api/inbound/email` stores forwarded society list mail in the internal
`inboundEmails` table as `pending` (source-research §16). It is not part of the
pipeline API and does not accept the pipeline key.

- **Resend** (`svix-id` / `svix-timestamp` / `svix-signature` headers present): the
  signature is verified with `RESEND_WEBHOOK_SECRET` (HMAC-SHA256, 5-minute tolerance,
  constant-time). `email.received` metadata is followed by `GET /emails/receiving/{id}`
  (`?html_format=cid`) and its attachments list; other event types are acknowledged
  and ignored.
- **Anything else**: the provider-agnostic JSON body (`webapp/lib/inbound-email.ts`
  `parseGenericPayload`) with `Authorization: Bearer $INBOUND_EMAIL_SECRET`.
- Deduplicated by `Message-ID`; HTML (≤ 2 MB) and kept attachments (images, PDF,
  calendars; ≤ 5 MB each, at most 10; never SVG) go to storage; `List-Id` is parsed into
  `listId` / `listName`; `receivedAt` is the `Date` header clamped to now.
- `INBOUND_EMAIL_RECIPIENTS` (unset accepts no mail) must match `To`/`Cc` or a delivery header
  (`Delivered-To`, `X-Original-To`, `Resent-To`, `Received … for <…>`); for Resend this is
  checked after the headers are fetched.
- `senderVerified` is recorded per mail (`lib/inbound-email.ts` `senderAuthenticated`): a
  trusted receiver's DMARC or aligned DKIM pass for the `From` domain, read from the
  highest-instance `ARC-Authentication-Results`, else a trusted `Authentication-Results`.
  The pipeline attributes only verified mail to an organisation.
- Answers: 200 `{stored}` / `{duplicate}` / `{ignored}`; 401 bad signature or secret;
  400 malformed; 413 too large; 502/503 when Resend's API failed or is not configured
  (Resend retries for about a day).
