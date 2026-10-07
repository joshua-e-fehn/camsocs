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
| Hooks              | husky + lint-staged                         | 9.1.7 / 16.4.0     |
| Hosting            | Vercel (root dir `webapp`) + Convex         | —                  |

`better-auth` is pinned `~1.6.25`, not `^`: `@convex-dev/better-auth@0.12.5` declares the peer
range `>=1.6.11 <1.7.0`, and a caret resolves to 1.7.x.

## Project structure

```
app/                         Next.js App Router pages
  layout.tsx                 Root layout: ConvexClientProvider + ThemeProvider + AuthGuard + Toaster
  page.tsx                   Public landing page
  sign-in/page.tsx           Google (admin) + @cam.ac.uk email link (accounts are created on first use)
  dashboard/                 Private area (session required; data needs broker access)
  not-found.tsx              404
  api/auth/[...all]/route.ts /api/auth/* proxy to Better Auth in Convex (NOT a next.config rewrite)

components/                  Atomic Design
  ui/                        ATOMS — shadcn/ui primitives
  molecules/                 MOLECULES — small composites
  organisms/                 ORGANISMS — page sections
  providers/                 PROVIDERS — context wrappers (convex client, theme, auth guard)

convex/
  schema.ts                  The domain schema (docs/data-model.md is the contract; header states the rules)
  http.ts                    Better Auth routes + /api/pipeline/* (Bearer PIPELINE_API_KEY)
  orgs.ts events.ts venues.ts termDates.ts listingRequests.ts
                             PUBLIC read API (see "Public API" below) + the listing-request form
  ingest/                    internal mutations behind /api/pipeline/* (claims, sources, orgInternal,
                             relationships + eventOrganisers, broker, files, inbound, termDates, purge)
  derive.ts / crons.ts       background re-derivation (daily 03:30 UTC)
  runs.ts                    internal runs.start / runs.finish / runs.latest (pipeline run log)
  auth.ts                    getCurrentUser, getBrokerAccess, getSignInOptions, getViewerTier (public, never throw)
  authEmail.ts               internal throttle for the @cam.ac.uk sign-in link
  broker/                    PRIVATE CRM functions — every one calls requireBrokerUser
  lib/fields.ts              claimable-field registry: validators, merge/compare rules, applicability
  lib/resolve.ts             field resolution engine (data-model §1), pure
  lib/materialise.ts         resolutions → row + meta + derived fields; lib/derived.ts the §6 rules
  lib/entityStore.ts         keyed entity reads/writes, org cards, organisation refresh
  lib/projections.ts         public projections (data-model §7) and their validators
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
lib/                         Pure logic + *.test.ts (no server imports)
  vocab.ts                   Controlled vocabularies (as-const tuples), mirrored by the pipeline
  keys.ts / hash.ts          Key minting + claim fingerprints (pure SHA-1/256); keys.fixtures.json shared with Python
  broker-access.ts           BROKER_EMAILS parsing/matching
  auth-routes.ts             PUBLIC_PATHS / PRIVATE_PATHS (test asserts every page is classified)
  auth-forwarded-headers.ts  The /api/auth hop without x-forwarded-host (Bundestracker outage fix)
  convex-url.ts              Build-time check that both Convex URLs name one deployment
scripts/
  check-codegen.ts           Committed api.d.ts lists every convex module
  build-env-defaults.sh      Placeholder Convex URLs only for builds going nowhere (+ .test.ts)
  convex-deploy-if-key.sh    Deploys only on Vercel; refuses a stray exported CONVEX_DEPLOY_KEY
test/setup.ts                happy-dom preload (keeps native fetch/Headers/Request/Response)
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

## Code quality

- Biome replaces ESLint and Prettier: 2 spaces, line width 100, double quotes, semicolons as
  needed, organize imports on, Next and React rule domains on. CSS is not linted (Tailwind v4
  syntax). `convex/_generated/` and `convex/betterAuth/_generated/` are excluded; `components/ui/`
  has relaxed a11y rules (generated code).
- Scripts: `bun run lint`, `bun run format`, `bun run check` (lint + format, writes),
  `bun run typecheck`, `bun run test`, `bun run check:codegen`, `bun run build`.
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
  throttles to 3 links per address per 15 minutes and 60 per hour overall (`convex/authEmail.ts`,
  table `signInLinkSends`, sha256 of the address only, pruned after a day). A verified link means
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

- `.env.local` (written by `bunx convex dev`): `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`,
  `NEXT_PUBLIC_CONVEX_SITE_URL`, optionally `NEXT_PUBLIC_SITE_URL`. See `.env.example`.
- Vercel production: the three `NEXT_PUBLIC_*` values + `CONVEX_DEPLOY_KEY` (production only).
- Convex env (`bunx convex env set [--prod] …`): `BETTER_AUTH_SECRET`, `SITE_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PIPELINE_API_KEY`, `BROKER_EMAILS`,
  `RESEND_API_KEY`, `RESEND_FROM` (the last two switch on the `@cam.ac.uk` sign-in link).

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
| `orgs.facets` | `OrgFilters` | `{ total, categories, levels, orgTypes, collegeKeys, activityTypes, audiences, statuses, blueStatus, gender, beginnerFriendly }`, each `Record<value, count>`; disjunctive (a facet ignores its own selection); `total` = what `list` returns |
| `orgs.getBySlug` | `{ slug }` | `null` or `{ org: OrgPublic, teams: TeamPublic[], sessions: SessionPublic[], events: EventPublic[], relationships: RelationshipPublic[] }`; events are upcoming (from today, London), at most 50, gated by the viewer; relationships are public edges with `direction` and the counterpart's `{key, slug, name}` |
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
| `events.list` | `{ from, to, categories?, eventTypes?, orgKey?, q?, collegeKeys? }` (epoch ms, `to` exclusive, window ≤ 186 days) | `EventPublic[]` by start time (≤ 1000), gated by the viewer; `categories` / `collegeKeys` match the organisers' or co-hosts' |
| `events.get` | `{ key }` | `EventPublic \| null` (null also when the viewer may not see it) |

`EventPublic`: `key, title, description?, startsAt, endsAt?, allDay, termWeekLabel?, venueKey?,
venueText?, organisers: {key, slug, name, role}[], speakers, price?, bookingUrl?, signupRequired?,
visibility, eventType, imageUrl?, cancelled, status, source, sourceUrl? (absent for mailing-list
events), lastSeenAt, confidence, meta`.

### Reference data and the form

| Function | Args | Returns |
|---|---|---|
| `venues.list` | `{}` | `{ key, name, aliases, address?, collegeKey?, lat?, lng? }[]` by name |
| `termDates.list` | `{}` | `{ academicYear, term, fullTermStart, fullTermEnd, sourceUrl }[]` in calendar order |
| `listingRequests.submit` (mutation) | `{ kind: "claim"\|"correct"\|"remove"\|"object"\|"add", orgKey? (required unless add), submitterEmail, role?, message (10–5000 chars), fields?: Record<field, string> }` | `{ key }`. Throws a user-readable message on invalid input, an unknown listing, or more than 5 requests per address per hour |

Labels for vocabularies: `CATEGORY_LABELS` in `lib/vocab.ts`; the rest are added there when the UI
needs them.

## Ingestion API (pipeline only)

`POST /api/pipeline/<path>` with `Authorization: Bearer $PIPELINE_API_KEY`; batches ≤ 500 rows
(`MAX_BATCH`). Bodies and responses are modelled in `pipeline/src/camsocs_pipeline/models/wire.py`
(the route table is in its docstring); the pipeline calls them through `ConvexLoader`
(`pipeline/load.py`). Errors: 401 bad key, 400 validation (message names the field), 404 "not
found". Item-level refusals (a bad claim, an unknown event) come back in the 200 response
(`rejected`, `missingEvents`, `missing`) and the rest of the batch lands.

| Path | Writes |
|---|---|
| `claims` | `fieldClaims` + the entity row (created on first claims), re-resolved and re-derived; `{inserted, updated, unchanged, entities: {created, updated, unchanged}, rejected[]}` |
| `sources` | `sources` by key (`src-<sha1(url)>`) |
| `orgInternal` | `orgInternal` by orgKey (patch; lists merge) |
| `relationships` | `relationships` by server-minted key, evidence merged |
| `eventOrganisers` | replaces each event's organiser set; mirrors it on the event; co-host / sponsor edges |
| `brokerInferences` | inferred needs/offers and public-source people (never overwrites manual / confirmed) |
| `files` | `{data: base64, contentType}` → `{storageId, sha256}` (≤ 2 MB, raster image or PDF, deduplicated) |
| `inbound/pending`, `inbound/mark` | read pending list mail; record extraction outcome |
| `termDates` | Full Term dates by (academicYear, term); re-labels events |
| `derive` | schedules the daily re-derivation now |
| `purge` | `{confirm: "PURGE-DEV"}`; empties pipeline tables, **dev deployment only** |
| `runs/start`, `runs/finish` | the run log |
