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
  // No `/relay` rewrites either, though PostHog's Next.js recipe uses them
  // (research-js §2): a rewrite would forward the visitor's cookies, Better
  // Auth's session among them, to PostHog. `app/relay/[...path]/route.ts`
  // forwards by allow-list instead (lib/relay.ts).
  //
  // PostHog's endpoints end in a slash (`/e/`, `/flags/`), and the relay
  // keeps it; Next's built-in redirect would answer each with a 308 to the
  // slashless path first. It is switched off, and `redirects()` restores it
  // for everything but the relay, so `/about/` still 308s to `/about` (one URL
  // per page, as before) and `/api/auth/*/` still reaches its handler.
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      // Next's own rule (`/:path+/` → `/:path+`, 308) minus `/relay/…`.
      { source: "/:path((?!relay(?:/|$)).+)/", destination: "/:path", permanent: true },
    ]
  },
}

export default nextConfig
