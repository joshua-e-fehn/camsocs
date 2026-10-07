# camsocs webapp — notes for the root AGENTS.md

Folded from the template's `webapp/agents.md` (MunichMinds), keeping only what is still true for
camsocs. Deployment names, URLs, Vercel IDs, Hono/React Query, email/password, GitHub and Apple
auth were removed. To be merged into the root `AGENTS.md`, then this file deleted.

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
  sign-in/page.tsx           Google sign-in (creates the account on first use; no sign-up page)
  dashboard/                 Private area (session required; data needs broker access)
  not-found.tsx              404
  api/auth/[...all]/route.ts /api/auth/* proxy to Better Auth in Convex (NOT a next.config rewrite)

components/                  Atomic Design
  ui/                        ATOMS — shadcn/ui primitives
  molecules/                 MOLECULES — small composites
  organisms/                 ORGANISMS — page sections
  providers/                 PROVIDERS — context wrappers (convex client, theme, auth guard)

convex/
  schema.ts                  App schema (harvestRuns so far; header states the schema rules)
  http.ts                    Better Auth routes + /api/pipeline/* (Bearer PIPELINE_API_KEY)
  runs.ts                    internal runs.start / runs.finish / runs.latest (pipeline run log)
  auth.ts                    getCurrentUser, getBrokerAccess (public, never throw)
  broker/                    PRIVATE CRM functions — every one calls requireBrokerUser
  lib/auth.ts                requireUserId / getUserId / requireBrokerUser / getBrokerUser
  lib/ingest.ts              upsertRow (write only when changed), MAX_BATCH 500, guarded prune
  lib/validators.ts          literalUnion() over lib/vocab.ts tuples
  lib/harness.testing.ts     convex-test harness (two dots → never deployed)
  betterAuth/                Better Auth component (local install, from Bundestracker)
  _generated/                COMMITTED codegen (see .gitignore note)

hooks/convex/index.ts        Thin useQuery/useMutation wrappers ("skip" pattern)
lib/                         Pure logic + *.test.ts (no server imports)
  vocab.ts                   Controlled vocabularies (as-const tuples), mirrored by the pipeline
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

- **Google only**, registered only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set
  on the Convex deployment (otherwise sign-in answers PROVIDER_NOT_FOUND; nothing crashes).
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
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PIPELINE_API_KEY`, `BROKER_EMAILS`.

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
