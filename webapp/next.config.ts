import path from "node:path"
import { withPostHogConfig } from "@posthog/nextjs-config"
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

/**
 * Source maps for PostHog error tracking (ENG-6, research-errors §4-§5):
 * `@posthog/nextjs-config` uploads the build's source maps to PostHog and
 * then deletes every `.map` from the output (`deleteAfterUpload`), so stacks
 * are readable in PostHog while the public site serves no maps.
 *
 * Only for a Vercel production build that has both `POSTHOG_PERSONAL_API_KEY`
 * and `POSTHOG_PROJECT_ID` (set on Production only). Anything else (local
 * builds, `next dev`, CI, previews, e2e) gets `config` back exactly as it
 * is: the plugin throws at config load without a key, and under Turbopack a
 * failed release lookup or upload fails the build, so it must never run
 * where it cannot succeed.
 */
export function sourceMapUploadOptions(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Parameters<typeof withPostHogConfig>[1] | null {
  const personalApiKey = env.POSTHOG_PERSONAL_API_KEY?.trim()
  const projectId = env.POSTHOG_PROJECT_ID?.trim()
  if (!personalApiKey || !projectId || env.VERCEL_ENV !== "production") return null
  return {
    personalApiKey,
    projectId,
    // The EU app host (not the ingestion host `eu.i.posthog.com`), as the
    // upload docs say for EU Cloud.
    host: "https://eu.posthog.com",
    logLevel: "warn",
    sourcemaps: {
      enabled: true,
      releaseName: "camsocs",
      releaseVersion: env.VERCEL_GIT_COMMIT_SHA?.trim() || undefined,
      deleteAfterUpload: true,
    },
  }
}

/** `config` wrapped for the source map upload when `sourceMapUploadOptions`
 * allows it (the PostHog wrapper must be the outermost), else `config`
 * itself. */
export function withSourceMapUpload(
  config: NextConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): NextConfig {
  const options = sourceMapUploadOptions(env)
  return options ? withPostHogConfig(config, options) : config
}

export { nextConfig }
export default withSourceMapUpload(nextConfig)
