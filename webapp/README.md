# camsocs webapp

Next.js 16 + Convex + Better Auth (Google) + shadcn/ui. Bun is the only package manager.

## Setup

```bash
bun install                                   # also installs the husky hook (repo root)
unset CONVEX_DEPLOY_KEY                       # never export it in a shell
bunx convex dev                               # dev deployment; writes .env.local, keep running
bun run dev                                   # http://localhost:3000
```

Convex env vars (dev; add `--prod` for production) are listed in `.env.example`.

## Gates

```bash
bun run lint && bun run typecheck && bun run test && bun run check:codegen && bun run build
```

`convex/_generated/` is committed. After adding or removing a Convex module, regenerate it with
`bunx convex dev --once` and commit the result; `bun run check:codegen` fails until you do.

`bun run build` without exported `NEXT_PUBLIC_CONVEX_*` values compiles against a placeholder
deployment (a compile check, not a servable build) — see `scripts/build-env-defaults.sh`.

See `AGENTS.webapp-notes.md` for structure and conventions, and `DESIGN.md` for UI rules.
