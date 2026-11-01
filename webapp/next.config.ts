import path from "node:path"
import type { NextConfig } from "next"

/**
 * No `/api/auth/*` rewrite here, deliberately.
 *
 * Inherited lesson from Bundestracker's production outage: a rewrite forwarding
 * `/api/auth/:path*` to `${NEXT_PUBLIC_CONVEX_SITE_URL}` sat beside the route
 * handler at `app/api/auth/[...all]/route.ts`. Measured on Next 16.2.12, an
 * `afterFiles` rewrite matching a path that also has a filesystem route
 * **wins**, so the rewrite ran and the handler was dead code.
 *
 * Next's rewrite proxy sets `x-forwarded-host` to the public origin, and
 * Convex's edge router reads that header to resolve the deployment. A host that
 * is not the deployment's own is rejected at ingress with a bare 404, so every
 * auth call 404'd in production while working on localhost. `rewrites()` has no
 * hook for outbound headers, so the rewrite had to go.
 *
 * `app/api/auth/[...all]/route.ts` serves these paths through
 * `lib/auth-forwarded-headers.ts`, which forwards without the poisoned header.
 *
 * ⚠ Do not reintroduce a rewrite for `/api/auth/:path*`. It would silently take
 * over from the route handler again.
 */
const nextConfig: NextConfig = {
  // Pin the workspace root to this directory. Without it Next walks up looking
  // for lockfiles and can adopt an unrelated one above the repo (it picked
  // ~/package-lock.json on the scaffold machine), which changes file tracing.
  turbopack: { root: path.join(__dirname) },
  // Logos and event images are our own stored copies (data-model §2: never
  // hotlinked), served from Convex file storage; nothing else is optimised.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.convex.cloud", pathname: "/api/storage/**" },
    ],
  },
  // The PostHog reverse proxy (ENG-4, lib/analytics-client.ts `RELAY_PATH`):
  // the browser sends analytics to our own origin, which forwards to PostHog's
  // EU Cloud (research-js §2). Unrelated to the `/api/auth` lesson above:
  // `/relay` has no filesystem route for a rewrite to shadow, and PostHog's
  // ingestion is not routed by `x-forwarded-host`. Order matters: the asset
  // rules come before the catch-all. Only consented visitors' browsers ever
  // call it; robots.ts disallows it.
  async rewrites() {
    return [
      {
        source: "/relay/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/relay/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      { source: "/relay/:path*", destination: "https://eu.i.posthog.com/:path*" },
    ]
  },
  // PostHog's endpoints end in a slash (`/e/`, `/flags/`); Next's built-in
  // redirect would answer each with a 308 to the slashless path first. It is
  // switched off, and `redirects()` restores it for everything but the relay,
  // so `/about/` still 308s to `/about` (one URL per page, as before) and
  // `/api/auth/*/` still reaches its handler.
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      // Next's own rule (`/:path+/` → `/:path+`, 308) minus `/relay/…`.
      { source: "/:path((?!relay(?:/|$)).+)/", destination: "/:path", permanent: true },
    ]
  },
}

export default nextConfig
