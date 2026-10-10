# camsocs webapp internals

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
  layout.tsx                 Root layout: ConvexClientProvider + ThemeProvider + AuthGuard + Toaster;
                             site-wide metadata (metadataBase, Open Graph)
  (site)/                    The public site (route group: header + footer frame, error, not-found)
    page.tsx                 Home: search, category tiles, this week's public events, explainer
    societies/page.tsx       Directory: URL-synced filters + facet counts + search + pages
    societies/[slug]/page.tsx  Organisation profile, a SourceLine under every fact
    events/page.tsx          Calendar: list / week / month, filters, event sheet (?event=)
    request/page.tsx         Claim / correct / remove / object / add form (?kind=&org=<slug>)
    about/page.tsx, privacy/page.tsx   About (how data is collected) and the UK GDPR notice
  sign-in/page.tsx           Google (admin) + @cam.ac.uk email link (accounts are created on first use)
  dashboard/                 Private broker area (session required; BrokerGate shows non-brokers why
                             it is closed): overview, organisations (?org=<key> opens the drawer),
                             people, interactions, introductions, graph, reports (missing data +
                             outreach CSV), requests
  sitemap.ts / robots.ts     Per-request sitemap of listings; robots disallows /dashboard, /api/, /sign-in
  opengraph-image.tsx        Share image: wordmark and tagline only (no University branding)
  not-found.tsx              404 outside the site frame
  api/auth/[...all]/route.ts /api/auth/* proxy to Better Auth in Convex (NOT a next.config rewrite)

components/                  Atomic Design
  ui/                        ATOMS — shadcn/ui primitives
  molecules/                 MOLECULES — small composites
  organisms/                 ORGANISMS — page sections
  providers/                 PROVIDERS — context wrappers (convex client, theme, auth guard)

convex/
  schema.ts                  The domain schema (docs/data-model.md is the contract; header states the rules)
  http.ts                    Better Auth routes + /api/pipeline/* (Bearer PIPELINE_API_KEY)
                             + /api/inbound/email (forwarded list mail; Svix / Bearer, see below)
  orgs.ts events.ts venues.ts termDates.ts listingRequests.ts
                             PUBLIC read API (see "Public API" below) + the listing-request form
  ingest/                    internal mutations behind /api/pipeline/* (claims, sources, orgInternal,
                             relationships + eventOrganisers, broker, files, inbound, termDates, purge,
                             suppressions)
  derive.ts / crons.ts       background re-derivation (daily 03:30 UTC)
  retention.ts               the retention schedule as paginated walks (daily 04:15 UTC;
                             docs/compliance/retention.md)
  coverage.ts                directory coverage folded server-side, a page per scheduled mutation,
                             into `coverageSnapshots` (after each run, daily 04:45 UTC, on request);
                             the same fold page by page for the pipeline's coverage report
  runs.ts                    internal runs.start / runs.finish / runs.latest (pipeline run log)
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
hooks/convex/broker.ts       The broker area's hooks (mounted only inside BrokerGate) + runWithToast
lib/                         Pure logic + *.test.ts (no server imports)
  vocab.ts                   Controlled vocabularies (as-const tuples), mirrored by the pipeline,
                             plus their display labels (Records, ignored by the parity test)
  calendar.ts                Europe/London calendar: offsets, days, view windows, formatting
                             (shared with convex/lib/derived.ts)
  url-state.ts               /societies and /events state <-> URL, and the Convex args it preloads
  source-line.ts             What a SourceLine says for a field's public meta (status, source, …)
  listing-request.ts         The request form's draft, validation (server limits) and submit args
  owner-corrections.ts       Accepting a correction: which fields, how each is edited and parsed
  syntax.ts                  isEmail / isHttpUrl, shared with convex/lib/fields.ts
  public-api.ts              Client names for the public API's return types (types only)
  format.ts                  Money, language names, paragraphs
  rich-text.ts               Description markdown subset → a tree (never HTML); molecules/rich-text renders it
  event-runs.ts              A show's nights as one run; events already running at a view's start ("Ongoing")
  monogram.ts                Initials for an organisation without a logo
  pagination.ts              The page numbers a pager shows
  page-metadata.ts           A page's title, description, share card (with the share image) and canonical
  site.ts                    Site facts: name, URL, controller, CONTACT_EMAIL (D4), …
  cam-email.ts               The one @cam.ac.uk rule (sign-in link, getViewer, the form)
  broker/                    Broker analysis shared by server, browser and tests: coverage (the
                             fold convex/coverage.ts runs), matching, outreach (CSV + Art 14
                             notice), force-layout, format
  keys.ts / hash.ts          Key minting + claim fingerprints (pure SHA-1/256); keys.fixtures.json shared with Python
  broker-access.ts           BROKER_EMAILS parsing/matching
  inbound-email.ts           inbound mail: payload parsing, List-Id, HTML→text, limits, Svix verify
  resend-inbound.ts          Resend Receiving API client (body, headers, attachments; fetch injected)
  auth-routes.ts             PUBLIC_PATHS / PRIVATE_PATHS (test asserts every page is classified)
  auth-forwarded-headers.ts  The /api/auth hop without x-forwarded-host (Bundestracker outage fix)
  convex-url.ts              Build-time check that both Convex URLs name one deployment
scripts/
  check-codegen.ts           Committed api.d.ts lists every convex module
  measure-public-api.ts      Response size and time of the public queries against .env.local's deployment
  build-env-defaults.sh      Placeholder Convex URLs only for builds going nowhere (+ .test.ts)
  convex-deploy-if-key.sh    Deploys only on Vercel; refuses a stray exported CONVEX_DEPLOY_KEY
test/setup.ts                happy-dom preload (keeps native fetch/Headers/Request/Response)
e2e/                         Playwright smoke suite (not part of `bun test`; bunfig ignores it)
  fixtures.ts                Read-only guard on the Convex socket, page checks, screenshot paths
  smoke.spec.ts              Every public page at 1440×900 and 390×844 (+ dark), filters, sheet, form
playwright.config.ts         Projects, `next dev` on :3100 (or E2E_BASE_URL), output under ../var/
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

Public pages render on the server. A page with interaction (directory, calendar) parses its URL
state (`lib/url-state.ts`), calls `preloadQuery` from `convex/nextjs` and hands the result to a
client organism that reads it with `usePreloadedQuery` (live afterwards); a filter change is a
`router.push` of the new URL. A page without interaction (profile, home, About) uses `fetchQuery`
and ships no client JavaScript of its own. Viewer-dependent queries (`events.*`,
`orgs.getBySlug`) get `{ token: await getToken() }` (`lib/auth-server.ts`, memoised per request).
Opening an event only changes `?event=` with `window.history.pushState` (no server round trip).

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
opens the mobile filter sheet, an event's details and submits the request form.

**Read-only by construction** (`e2e/fixtures.ts`): the Convex WebSocket is routed through
Playwright and every `Mutation` / `Action` message is answered by the guard instead of the server
(the test fails if any page tries one); the request-form test registers a mock result for
`listingRequests:submit`, so the success state renders and nothing is written. Non-GET
`/api/auth/*` requests are aborted. Server-rendered pages call public queries only.
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
  `{ signedIn, isBroker, isCamVerified }` are public queries for the UI.
- Better Auth runs **inside Convex**. Flow: client → same-origin `/api/auth/*` → route handler
  (`lib/auth-forwarded-headers.ts`) → Convex site URL → Better Auth → session in the component's
  tables → `ConvexBetterAuthProvider` holds the token.
- `proxy.ts` passes everything through. `AuthGuard` only decides what to render. **Access is
  enforced in Convex**: every `convex/broker/*` function calls `requireBrokerUser`, which admits
  only verified emails listed in the Convex env var `BROKER_EMAILS` (comma-separated); unset or
  empty means nobody.
- OAuth callback (Google console): `<SITE_URL>/api/auth/callback/google`, dev and prod.
- Never re-export the library's `handler`/`getToken` from `lib/auth-server.ts`, and never add a
  `next.config` rewrite for `/api/auth/*` (see next.config.ts).

## Environments

Dev and prod are separate Convex deployments of the `camsocs` project with independent data.
Production setup, step by step (Convex prod, Vercel, the pipeline's `--env prod`): `docs/deploy.md`.

- `.env.local` (written by `bunx convex dev`): `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`,
  `NEXT_PUBLIC_CONVEX_SITE_URL`, optionally `NEXT_PUBLIC_SITE_URL`. See `.env.example`.
- Vercel production: the three `NEXT_PUBLIC_*` values + `CONVEX_DEPLOY_KEY` (production only).
  A deploying build never defaults `NEXT_PUBLIC_SITE_URL` to localhost: unset, `lib/site.ts`
  uses `https://camsocs.vercel.app`.
- Convex env (`bunx convex env set [--prod] …`): `BETTER_AUTH_SECRET`, `SITE_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PIPELINE_API_KEY`, `BROKER_EMAILS`,
  `RESEND_API_KEY`, `RESEND_FROM` (the last two switch on the `@cam.ac.uk` sign-in link).
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
| `orgs.list` | `OrgFilters & { paginationOpts }` | `{ page: OrgCardPublic[], isDone, continueCursor }` — name order, or search relevance with `q`; works with `usePaginatedQuery` (cursor = offset) |
| `orgs.facets` | `OrgFilters` | `{ total, categories, levels, orgTypes, collegeKeys, activityTypes, audiences, statuses, blueStatus, gender, beginnerFriendly, truncated }`, each but the last `Record<value, count>`; disjunctive (a facet ignores its own selection); `total` = what `list` returns; `truncated` when a search matched more than one query returns (1,024, Convex's limit) and the counts cover the best matches only |
| `orgs.getBySlug` | `{ slug }` | `null` or `{ org: OrgPublic, teams: TeamPublic[], sessions: SessionPublic[], events: EventListItem[], relationships: RelationshipPublic[] }`; events are upcoming (from London midnight today, plus multi-day runs still on), at most 50, gated by the viewer, without withdrawn ones; relationships are public edges with `direction` and the counterpart's `{key, slug, name}` |
| `orgs.colleges` | `{}` | `{ key, slug, name }[]` of colleges, by name (for the college filter) |

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
| `events.list` | `{ from, to, categories?, eventTypes?, orgKey?, q?, collegeKeys?, includeTakingPart? }` (epoch ms, `to` exclusive, window ≤ 186 days) | `EventListItem[]` by start time (≤ 1000), gated by the viewer: events starting in the window and multi-day events still running in it; `q` keeps titles holding every word; `categories` / `collegeKeys` match the organisers' or co-hosts'; `includeTakingPart: false` leaves out events societies only take part in (`hosting: takes_part`, decision D6; included by default). Never: events whose every host is hidden, withdrawn events (data-model §2 `sweepGroup`) |
| `events.get` | `{ key }` | `EventPublic \| null` (null also when the viewer may not see it, every host is hidden, or it was withdrawn) |
| `events.restrictedCount` | same args as `events.list` | `{ camOnly }`: how many `cam_only` events are hidden from this viewer in the whole London weeks around `from`–`to` (at least one week, four with `orgKey`; `q`, types, categories and colleges ignored) — a coarse count for the "N Cambridge-only events in these weeks, sign in" note, never an oracle (data-model §7). 0 when they can see them |

`EventPublic` (`events.get`, the details sheet): `key, title, description?, startsAt, endsAt?,
allDay, termWeekLabel?, venueKey?, venueText?, organisers: {key, slug, name, role}[], speakers,
price?, bookingUrl?, signupRequired?, visibility, eventType, imageUrl?, cancelled, status, source,
sourceUrl? (absent for mailing-list events), hosting, externalUrl?, lastSeenAt, confidence, meta`.

`hosting` (decision D6) is `hosts` or `takes_part`: someone else's event (a CTF, a conference,
another university's event) the listed societies only take part in. The UI then names them as
taking part ("Cyber Security Society takes part", the "Taking part" badge, a dashed card),
never as organisers, and links `externalUrl` — the event's own page, present only for
`takes_part` — off-site; the calendar's "Include events societies take part in" toggle
(`?external=hide` when off) maps to `includeTakingPart`.

`EventListItem` (`events.list`, a profile's upcoming events): `key, title, startsAt, endsAt?,
allDay, termWeekLabel?, venueKey?, venueText?, organisers, visibility, eventType, cancelled,
status, source, sourceUrl?, hosting, externalUrl?` — no description, speakers, price, image or
`meta`. A month of events
was ~450 KB with them and is ~50 KB without (`scripts/measure-public-api.ts`, dev data 2026-10-09);
the sheet reads the rest with `events.get`.

### Reference data and the form

| Function | Args | Returns |
|---|---|---|
| `venues.list` | `{}` | `{ key, name, aliases, address?, collegeKey?, lat?, lng? }[]` by name |
| `termDates.list` | `{}` | `{ academicYear, term, fullTermStart, fullTermEnd, sourceUrl }[]` in calendar order |
| `runs.lastHarvest` | `{}` | `{ finishedAt } \| null`: when the last run that wrote data (`success` / `partial`) finished — the run log's only public read |
| `listingRequests.submit` (mutation) | `{ kind: "claim"\|"correct"\|"remove"\|"object"\|"add", orgKey? (required unless add), submitterEmail, role?, message (10–5000 chars), fields?: Record<field, string> }` | `{ key }`. Throws a `ConvexError` whose `data` is a user-readable message on invalid input, an unknown listing, more than 5 requests per address per hour, or a full hourly budget (removals and objections have their own, larger one) (a plain `Error`'s message is hidden in production) |

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
| `broker/orgs` | `page` (paginated slim rows of every organisation, incl. counterparts and hidden: coverage flags, missingFields, best non-personal address, held fields, source hosts, needs/offers chips, suppressed), `search({q})`, `detail({key})` (full row with meta, orgInternal, profile, people, relationships, interactions), `updateProfile`, `setNeedOffer` (`confirmed` / `rejected` / `null` = forget), `setHidden` (showing a listing again is refused while it is on the suppression list) |
| `broker/people` | `list`, `create`, `update` (the row becomes `manual`), `setArchived` |
| `broker/interactions` | `list({orgKey?})`, `followUps({days?})`, `create`, `update`, `completeFollowUp`, `remove` |
| `broker/introductions` | `list`, `create` (each side one org or one person), `update`, `remove` |
| `broker/graph` | `relationships({types?})` (nodes + edges, public and internal), `matches` (complementary needs/offers and past sponsors of similar societies, `lib/broker/matching.ts`) |
| `broker/overview` | `summary` (events next 14 days by source, latest runs, open requests, due follow-ups, stale people, introductions by status, the latest `coverage` snapshot, the latest resolve stage's `quarantine` counts), `refreshCoverage` (schedules the fold now) |
| `broker/listingRequests` | `list({status?})`, `setStatus`, `acceptCorrections({key, corrections: {field, value}[]})` (claim / correct → `owner_submitted` claims through `internal.ingest.claims.ingest`, run as a sub-transaction; all or nothing), `acceptRemoval({key, scope, fields?, address?, personKeys?, eventKeys?, name?})` (remove / object → suppressions, enforced at once; `event` and `name` need no listing) |
| `broker/suppressions` | `list({orgKey?})` (an address shows only as `contact: true`), `lift({key})` |
| `broker/session` | `me` |

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
