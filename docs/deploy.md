# Deploying camsocs (T14)

How the production site goes live: a **Convex production deployment** (separate from dev, `hushed-rhinoceros-215`, with its own data), the **Vercel project** that builds `webapp/` and deploys Convex as part of its build, and the **pipeline** pointed at production with its own env file. Nothing here has been run yet; these are Joshua's steps (PLAN.md J1, J2), checked against the installed CLIs on 2026-10-09 (Convex 1.46.0: `bunx convex deploy --help`, `deployment create --help`, `deployment token create --help`, `env --help`).

**Secrets.** Never paste a value into a chat, a commit or a log. Each one goes in exactly one place: Convex env, Vercel env or `pipeline/.env.prod`. `bunx convex env set NAME` without a value prompts for it, which keeps it out of the shell history.

**Never export `CONVEX_DEPLOY_KEY`** in a shell (AGENTS.md). It overrides `.env.local`, and has deployed one project's functions onto another project's production before. A key belongs in Vercel's production environment, or on the one command line that uses it.

```
browser ──► Vercel (camsocs.vercel.app, root dir webapp/) ──► Convex prod  ◄── pipeline --env prod (laptop)
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

- **Vercel-side (normal path).** With `CONVEX_DEPLOY_KEY` in Vercel's *Production* environment, every production build runs `scripts/convex-deploy-if-key.sh` → `bunx convex deploy` (typecheck, codegen, push of functions, indexes and schema) before `next build`. Preview builds have no key and deploy nothing.
- **Local, deliberately (first deploy, or Vercel not set up yet).** The build script refuses an exported key outside Vercel. Put the key on the one command line instead, so it never enters the shell's environment:

  ```bash
  cd webapp && unset CONVEX_DEPLOY_KEY
  CONVEX_DEPLOY_KEY='<production deploy key>' CAMSOCS_ALLOW_LOCAL_CONVEX_DEPLOY=1 bun run build
  ```

  This deploys the functions to production, then compiles the site (against whatever `NEXT_PUBLIC_CONVEX_*` the shell has: the local compile is a check, Vercel's build is what ships). In zsh, `setopt HIST_IGNORE_SPACE` and a leading space keep the line out of the history.
- `bunx convex deploy` alone (no key; `.env.local` names the dev deployment) also targets the project's default production deployment. It is the same push without the guard; prefer the two routes above.

## 2. The Vercel project

1. Import `joshua-e-fehn/camsocs` (J1). **Root Directory: `webapp`**. Framework preset: Next.js. `webapp/vercel.json` sets the rest: `bun install`, `bun run build`, output `.next`. Node.js 22.x.
2. Environment variables:

   | Variable | Production | Preview | Notes |
   |---|---|---|---|
   | `NEXT_PUBLIC_CONVEX_URL` | `https://<prod>.convex.cloud` | `https://hushed-rhinoceros-215.convex.cloud` | Required: a Vercel build without both Convex URLs fails on purpose (`scripts/build-env-defaults.sh`) |
   | `NEXT_PUBLIC_CONVEX_SITE_URL` | `https://<prod>.convex.site` | `https://hushed-rhinoceros-215.convex.site` | Same deployment as the line above (`lib/convex-url.ts` checks) |
   | `NEXT_PUBLIC_SITE_URL` | `https://camsocs.vercel.app` | unset | Unset, `lib/site.ts` falls back to `https://camsocs.vercel.app` (never localhost on Vercel) — previews keep canonical links on production |
   | `CONVEX_DEPLOY_KEY` | the production deploy key | **never** | Production only; a preview with it would deploy previews' code to production |

   Previews read the dev deployment through public queries only; sign-in does not work there (dev's `SITE_URL` is localhost), which is fine for reviewing pages.
3. Deploy: push to `main` (or `vercel --prod` from `webapp/`). The build log shows `▸ CONVEX_DEPLOY_KEY found — deploying Convex…`, then `▸ Convex URLs set — building against the configured deployment`.

What the site serves for crawlers and sharing, already in the code: `app/robots.ts` (allow everything public; disallow `/dashboard`, `/api/`, `/sign-in`; sitemap link), `app/sitemap.ts` (rendered per request from `orgs.list`, so it never needs a build against real data), `metadataBase` = `SITE_URL` in `app/layout.tsx`, and `app/opengraph-image.tsx` (the camsocs wordmark and tagline as text, no University branding).

## 3. Convex production environment

`bunx convex env set --prod NAME` (prompts for the value), from `webapp/`:

| Variable | Needed for | Value |
|---|---|---|
| `BETTER_AUTH_SECRET` | any sign-in | `openssl rand -base64 32` — a new one, not dev's |
| `SITE_URL` | Better Auth's base URL and trusted origin | `https://camsocs.vercel.app` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | admin sign-in (J2) | the OAuth client whose callbacks include `https://camsocs.vercel.app/api/auth/callback/google` |
| `BROKER_EMAILS` | the private `/dashboard` | your Google address; unset = nobody |
| `PIPELINE_API_KEY` | `/api/pipeline/*` | `openssl rand -hex 32` — a new one; the same value goes into `pipeline/.env.prod` |
| `RESEND_API_KEY`, `RESEND_FROM` | the `@cam.ac.uk` sign-in link (J3) | optional; both unset = the option shows as off |
| `RESEND_WEBHOOK_SECRET`, `RESEND_INBOUND_API_KEY`, `INBOUND_EMAIL_RECIPIENTS`, `INBOUND_TRUSTED_AUTHSERV_IDS`, `INBOUND_EMAIL_SECRET` | forwarded list mail (J3, J4) | optional; see `docs/setup/inbox-instagram.md`. Point the Resend webhook at the **production** site URL (`https://<prod>.convex.site/api/inbound/email`) once production is the one that should receive mail |

`bunx convex env list --prod` prints values; use `bunx convex env list --prod --names-only` to check what is set.

## 4. The pipeline against production

The pipeline reads `pipeline/.env` (dev) and, for another environment, a second file on top of it (`pipeline/src/camsocs_pipeline/config.py`):

1. Create `pipeline/.env.prod` (gitignored, like every `pipeline/.env.*`):

   ```dotenv
   CONVEX_HTTP_URL=https://<prod>.convex.site
   PIPELINE_API_KEY=<the value set on the production deployment>
   ```

   Everything else (LLM, User-Agent, Camdram, Meta) is inherited from `pipeline/.env`; override any of it here if production should differ.
2. Run with `--env prod` (or `CAMSOCS_ENV_FILE=pipeline/.env.prod`, relative to the repo root; the flag wins):

   ```bash
   pixi run pipeline -- --env prod status   # "Environment: prod (pipeline/.env.prod)" and the prod URL
   pixi run pipeline -- --env prod health   # the key opens /api/pipeline/health on production
   pixi run pipeline -- --env prod sync     # the full harvest into production
   ```

Guards: a missing `pipeline/.env.prod` is an error, not a fall-back to dev. `CONVEX_URL`, `CONVEX_HTTP_URL` and `PIPELINE_API_KEY` must be the env file's own — inherited from `pipeline/.env`, or exported in the shell, the run stops before any request (write `NAME=` in `.env.prod` to unset one deliberately). `purge-dev` refuses any environment but dev (and the deployment refuses too). A non-dev environment keeps its own run state, `.camsocs-state.prod.json`. The web cache and `var/staging/` are shared, so a production sync right after a dev one re-reads pages from the cache rather than the network.

## 5. After the first deploy

1. `https://camsocs.vercel.app/`, `/societies`, a profile, `/events` render with production data (empty until the first `--env prod sync`).
2. `/robots.txt` names `https://camsocs.vercel.app/sitemap.xml`; `/sitemap.xml` lists the listings; `/opengraph-image` is the wordmark.
3. Sign in with Google → `/dashboard` opens (your address is in `BROKER_EMAILS`).
4. The read-only e2e smoke suite runs against any URL, production included: it never lets a mutation through (`webapp/e2e/fixtures.ts`).

   ```bash
   cd webapp && E2E_BASE_URL=https://camsocs.vercel.app bun run e2e
   ```

   Its profile slugs are dev's listings; on production they exist only after the first harvest.

## 6. Rolling back

- Site: Vercel → Deployments → the last good one → Promote to Production (instant; Convex is untouched).
- Functions: redeploy the last good commit (Vercel → Redeploy, which runs `convex deploy` again). Schema changes that removed fields need a widen-migrate-narrow plan first; never roll a schema back past data written under the newer one.
