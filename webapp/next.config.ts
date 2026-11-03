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
  // No `x-powered-by: Next.js`: it tells a scanner nothing we want it to know.
  poweredByHeader: false,
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }]
  },
}

/**
 * The browser protections every response carries (ENG-35, launch audit
 * 2026-11-02). HSTS is not among them: Vercel already sends
 * `strict-transport-security: max-age=63072000` on camsocs.uk, and a second
 * copy here could only disagree with it.
 *
 * The Content-Security-Policy is report-only: a browser reports what it
 * would block in its console and blocks nothing, so a source this list
 * forgot cannot break a page. Enforce it (rename the header) once the pages
 * show no reports. Scripts and styles keep 'unsafe-inline' because the App
 * Router inlines its flight data and framer-motion writes style attributes;
 * a nonce would need the proxy on every page, which was removed for CPU
 * (docs/deploy.md "CPU protection").
 */
export function securityHeaders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { key: string; value: string }[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: [
        "camera=()",
        "microphone=()",
        "geolocation=()",
        "payment=()",
        "usb=()",
        "serial=()",
        "hid=()",
        "bluetooth=()",
        "midi=()",
        "magnetometer=()",
        "gyroscope=()",
        "accelerometer=()",
        "display-capture=()",
        "browsing-topics=()",
      ].join(", "),
    },
    { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(env) },
  ]
}

/** A Convex origin from `url` (`https://name.convex.cloud`), or `fallback`
 * when it is unset or not one (`next dev` before `.env.local`, tests). */
function convexOrigin(url: string | undefined, fallback: string): string {
  const origin = url?.trim().replace(/\/+$/, "")
  return origin && /^https:\/\/[a-z0-9.-]+\.convex\.(cloud|site)$/.test(origin) ? origin : fallback
}

/**
 * Every origin a page loads from, by reading the code (ENG-35):
 *
 *  - **self**: pages, scripts, styles, `next/font` files (self-hosted), logos
 *    and event images through `/_next/image`, Better Auth (`/api/auth/*`, the
 *    route handler forwards it) and PostHog (`/relay/*`, with external script
 *    loading switched off in lib/analytics-client.ts);
 *  - **the Convex deployment**: the client's WebSocket and HTTP calls
 *    (`NEXT_PUBLIC_CONVEX_URL`), the site URL beside it, and stored images on
 *    `*.convex.cloud` (the same hosts `images.remotePatterns` allows);
 *  - **Vercel's toolbar** (`vercel.live`), on preview deployments only.
 *
 * Google sign-in and the map and calendar links are navigations, which a CSP
 * does not restrict. `next dev` also needs `eval` for its refresh runtime.
 */
export function contentSecurityPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const cloud = convexOrigin(env.NEXT_PUBLIC_CONVEX_URL, "https://*.convex.cloud")
  const site = convexOrigin(env.NEXT_PUBLIC_CONVEX_SITE_URL, "https://*.convex.site")
  const socket = cloud.replace(/^https:/, "wss:")
  const preview = env.VERCEL_ENV === "preview"
  const toolbar = preview ? ["https://vercel.live"] : []
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
      ...toolbar,
    ],
    "style-src": ["'self'", "'unsafe-inline'", ...toolbar],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      "https://*.convex.cloud",
      ...(preview ? ["https://vercel.live", "https://vercel.com"] : []),
    ],
    "font-src": [
      "'self'",
      ...(preview ? ["https://vercel.live", "https://assets.vercel.com"] : []),
    ],
    "connect-src": [
      "'self'",
      cloud,
      socket,
      site,
      ...(preview ? ["https://vercel.live", "wss://ws-us3.pusher.com"] : []),
    ],
    "frame-src": preview ? ["https://vercel.live"] : ["'none'"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ")
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
