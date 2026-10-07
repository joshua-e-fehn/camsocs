#!/usr/bin/env bash
# Deploy Convex as part of `bun run build`, but only where that is intended.
#
# Ported from Bundestracker, with one guard added. Behaviour:
#
#   no CONVEX_DEPLOY_KEY                → skip (local builds, CI, Vercel previews)
#   CONVEX_DEPLOY_KEY + Vercel build    → `bunx convex deploy` (production)
#   CONVEX_DEPLOY_KEY + anywhere else   → refuse, exit 1
#
# Why the refusal: a deploy key names the project it deploys to, not the code.
# On 2026-07-29 a CONVEX_DEPLOY_KEY exported in a shell turned an ordinary local
# build into a deploy of one repo's functions onto *another* project's
# production (recorded in the cambridge repo's HANDOFF.md). A key in a local
# shell is far more likely to be a leftover than an intention, so the local case
# fails loudly instead of deploying. Deploy deliberately with
# `CAMSOCS_ALLOW_LOCAL_CONVEX_DEPLOY=1 bun run build` after checking which
# project the key belongs to.
set -euo pipefail

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "▸ No CONVEX_DEPLOY_KEY — skipping Convex deploy (local / CI / preview build)"
  exit 0
fi

if [ -n "${VERCEL:-}" ] || [ "${CAMSOCS_ALLOW_LOCAL_CONVEX_DEPLOY:-}" = "1" ]; then
  echo "▸ CONVEX_DEPLOY_KEY found — deploying Convex…"
  bunx convex deploy
  exit 0
fi

echo "✖ CONVEX_DEPLOY_KEY is set, but this is not a Vercel build." >&2
echo "  Refusing to deploy: an exported key has deployed onto the wrong project before." >&2
echo "  Run \`unset CONVEX_DEPLOY_KEY\` and build again, or deploy deliberately with" >&2
echo "  CAMSOCS_ALLOW_LOCAL_CONVEX_DEPLOY=1 once you have checked the key's project." >&2
exit 1
