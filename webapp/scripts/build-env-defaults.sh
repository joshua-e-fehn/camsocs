#!/usr/bin/env bash
# Runs its arguments with the two public Convex URLs `next build` needs, filling
# in a placeholder pair *only* for a build that is going nowhere.
#
#   bash scripts/build-env-defaults.sh next build
#
# Ported from Bundestracker (webapp/scripts/build-env-defaults.sh); the matrix
# and the reasoning are unchanged.
#
# ## The matrix, which is the whole contract
#
# | `NEXT_PUBLIC_CONVEX_URL` / `…_SITE_URL` | deploying? | result |
# |---|---|---|
# | both set        | either | pass through untouched |
# | **exactly one** | either | **exit 1** — never substitute |
# | neither set     | yes    | **exit 1** — a shipped build must name its backend |
# | neither set     | no     | placeholder pair; compile check only |
#
# "Deploying" means `CONVEX_DEPLOY_KEY`, `VERCEL` or `VERCEL_ENV` is set.
#
# ## Why a build needs them at all
#
# lib/auth-server.ts validates both URLs at module load (lib/convex-url.ts), and
# `next build` imports it while collecting page data. That check is
# load-bearing: a build compiled against the wrong deployment does not crash, it
# serves empty answers as if they were true. So `bun run build` fails without
# the pair — right on Vercel, wrong for CI and a clean checkout, which is the
# gap this script closes.
#
# ## A real value always wins
#
# No configured value is ever replaced, and a half-configured pair is an error
# rather than something to paper over (Bundestracker PR #50, F1: substituting
# both when one was missing let Convex deploy to the real backend while the
# frontend compiled against a deployment that does not exist).
#
# Note that `next build` loads `.env.local` itself, but *after* this script has
# looked at the shell environment, and process env beats `.env.local`. So a
# local `bun run build` without exported URLs compiles against the placeholder
# — a compile check, not a servable build. Export the pair to build for real.
#
# `exec` rather than `source`, so the variables reach the child process and
# nothing else. `pixi.toml`'s `[tasks.*.env]` cannot express this: pixi's task
# env overrides an ambient value instead of defaulting to it.
#
# ## Why this placeholder is safe
#
# `placeholder-build-check-000` is not a Convex deployment (Convex mints names as
# `adjective-animal-NNN`), it is never contacted during the build, and
# `NEXT_PUBLIC_*` values are public by construction. `CONVEX_DEPLOY_KEY` is
# tested for and never read. The announcement goes to stderr.
set -euo pipefail

PLACEHOLDER_DEPLOYMENT="placeholder-build-check-000"

cloud_set=false
site_set=false
[ -n "${NEXT_PUBLIC_CONVEX_URL:-}" ] && cloud_set=true
[ -n "${NEXT_PUBLIC_CONVEX_SITE_URL:-}" ] && site_set=true

# Whether this build's output is going somewhere real. Any one of these is
# enough — they are independent signals and a placeholder is wrong under all of
# them, so the check is a disjunction rather than a guess at which is canonical.
#
#   CONVEX_DEPLOY_KEY  scripts/convex-deploy-if-key.sh has already deployed the
#                      backend by the time this runs. A frontend compiled
#                      against a placeholder would then be shipped *alongside* a
#                      real deployment — the worst case in the matrix.
#   VERCEL             set to "1" on every Vercel build, preview included. A
#                      preview that silently serves no data is still a broken
#                      preview, and previews are what reviewers look at.
#   VERCEL_ENV         production/preview/development. Checked as well as VERCEL
#                      so an environment that forwards only this one still trips.
deploying=false
if [ -n "${CONVEX_DEPLOY_KEY:-}" ] || [ -n "${VERCEL:-}" ] || [ -n "${VERCEL_ENV:-}" ]; then
  deploying=true
fi

if [ "$cloud_set" = true ] && [ "$site_set" = true ]; then
  echo "▸ Convex URLs set — building against the configured deployment" >&2

elif [ "$cloud_set" = true ] || [ "$site_set" = true ]; then
  # Exactly one half. Never substitute here, in any context: someone who set
  # one variable is configuring a real deployment and mistyped the other.
  missing="NEXT_PUBLIC_CONVEX_SITE_URL"
  present="NEXT_PUBLIC_CONVEX_URL"
  [ "$cloud_set" = true ] || { missing="NEXT_PUBLIC_CONVEX_URL"; present="NEXT_PUBLIC_CONVEX_SITE_URL"; }
  echo "✖ ${present} is set but ${missing} is not." >&2
  echo "  Both are required and must name the same Convex deployment." >&2
  echo "  Refusing to substitute a placeholder: that would discard the value you set" >&2
  echo "  and compile this build against a deployment that does not exist." >&2
  echo "  Set ${missing}, or unset ${present} for a credential-free compile check." >&2
  exit 1

elif [ "$deploying" = true ]; then
  # Neither is set, but this build is going somewhere. A placeholder would
  # ship exactly the failure lib/convex-url.ts exists to prevent.
  reason="CONVEX_DEPLOY_KEY is set"
  [ -n "${CONVEX_DEPLOY_KEY:-}" ] || reason="this is a Vercel build (VERCEL/VERCEL_ENV set)"
  echo "✖ No Convex URLs set, but ${reason}." >&2
  echo "  A deploying build must name its backend: the placeholder is a compile" >&2
  echo "  check only, and shipping it would serve a site where every query returns" >&2
  echo "  nothing and real records render as \"does not exist\"." >&2
  echo "  Set NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_CONVEX_SITE_URL." >&2
  exit 1

else
  export NEXT_PUBLIC_CONVEX_URL="https://${PLACEHOLDER_DEPLOYMENT}.convex.cloud"
  export NEXT_PUBLIC_CONVEX_SITE_URL="https://${PLACEHOLDER_DEPLOYMENT}.convex.site"
  echo "▸ No Convex URLs set — building against ${PLACEHOLDER_DEPLOYMENT}" \
    "(compile check only; this build cannot serve data)" >&2
fi

# `NEXT_PUBLIC_SITE_URL` is where the app is served from. Unlike the pair above
# it has no validator, and .env.example documents localhost as its development
# value, so the same default is the honest one for a build going nowhere.
: "${NEXT_PUBLIC_SITE_URL:=http://localhost:3000}"
export NEXT_PUBLIC_SITE_URL

exec "$@"
