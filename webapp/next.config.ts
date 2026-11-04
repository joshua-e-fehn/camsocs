import path from "node:path"
import { withPostHogConfig } from "@posthog/nextjs-config"
import { withBotId } from "botid/next/config"
import type { NextConfig } from "next"
// An internal Next path, not a public export: if an upgrade moves it the build
// fails loudly here, and HTML_LIMITED_BOTS below needs re-pointing (or a copy).
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots"

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
/**
 * User agents that get their `<title>`, description and canonical in
 * `<head>` (SEO audit 2026-11-02, metadata-streamed-into-body).
 *
 * Next 16 streams `generateMetadata` that awaits Convex: the loading shell
 * flushes `</head>` first and the tags arrive in `<body>` about 85 KB later,
 * where a head-only parser misses them and Google honours no canonical. Next
 * blocks on metadata only for the user agents in this regex, and setting it
 * replaces Next's own list, so it starts from that list (imported, so an
 * upgrade carries its changes) and adds the AI search and answer fetchers it
 * lacks plus Googlebot itself, which Next leaves out because it renders
 * (it then raced: head on some fetches, body on others). This changes only
 * where the tags are placed for these agents, at a small cost in time to
 * first byte for them; what they may crawl is robots.txt's business.
 */
export const HTML_LIMITED_BOTS = new RegExp(
  [
    HTML_LIMITED_BOT_UA_RE.source,
    "Googlebot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "PerplexityBot",
    "Perplexity-User",
    "Claude-SearchBot",
    "Claude-User",
    "DuckAssistBot",
    "MistralAI-User",
    "YouBot",
    "Meta-ExternalFetcher",
    "Amazonbot",
  ].join("|"),
  "i",
)

/**
 * Routes with nothing for a search engine: the broker area, the sign-in page,
 * the auth and pipeline endpoints and the analytics relay (SEO audit
 * 2026-11-02, private-routes-noindex). robots.txt asks crawlers not to fetch
 * them, but a disallowed URL linked from elsewhere can still be listed
 * ("Indexed, though blocked by robots.txt"); the header says noindex even on
 * a response a crawler never parses as HTML. /dashboard also says it in its
 * layout's metadata.
 */
export const NOINDEX_SOURCES = [
  "/dashboard/:path*",
  "/sign-in/:path*",
  "/api/:path*",
  "/relay/:path*",
] as const

/**
 * Whether the browser half of Vercel BotID starts (`instrumentation-client.ts`,
 * ENG-37): only in a build on Vercel, whose rewrites reach Vercel's challenge.
 * Anywhere else (`next dev`, CI, the e2e suite) a protected `fetch` would wait
 * for a challenge nobody answers. Inlined at build time as
 * `process.env.NEXT_PUBLIC_BOT_CHECK`; the server decides for itself at run
 * time (lib/request-submit.ts `botCheckEnabled`).
 */
export function botCheckClientFlag(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "1" | "" {
  return env.VERCEL === "1" ? "1" : ""
}

/**
 * Wrapped by `withBotId` (ENG-37), which adds the two rewrites that carry
 * BotID's challenge scripts from this origin to Vercel (a fixed
 * `/149e9513-…/2d206a39-…/` prefix) and, for that prefix only, headers that
 * let Vercel's challenge frame itself (`X-Frame-Options: SAMEORIGIN`,
 * `frame-ancestors 'self'`). Next lets the last matching rule win, and the
 * wrapper's comes after `securityHeaders()`, so the site's `DENY` holds
 * everywhere else. Same-origin paths, so the CSP needs no new source.
 */
const nextConfig: NextConfig = withBotId({
  // No `x-powered-by: Next.js`: it tells a scanner nothing we want it to know.
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BOT_CHECK: botCheckClientFlag() },
  // Pin the workspace root to this directory. Without it Next walks up looking
  // for lockfiles and can adopt an unrelated one above the repo (it picked
  // ~/package-lock.json on the scaffold machine), which changes file tracing.
  turbopack: { root: path.join(__dirname) },
  htmlLimitedBots: HTML_LIMITED_BOTS,
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
    return [
      { source: "/:path*", headers: securityHeaders() },
      ...NOINDEX_SOURCES.map((source) => ({
        source,
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
    ]
  },
})

/**
 * The browser protections every response carries (ENG-35, launch audit
 * 2026-11-02; SEO audit 2026-11-02, security-headers): no MIME sniffing; only
 * the origin as referrer to other sites (the browser default, made explicit;
 * outbound links keep `noreferrer`, G7); no camera, microphone, location or
 * other device feature; and no framing by any site. HSTS is not among them:
 * Vercel already sends `strict-transport-security: max-age=63072000` on
 * camsocs.uk (G10), and a second copy here could only disagree with it.
 *
 * Framing is refused for real twice over: `X-Frame-Options: DENY` for old
 * browsers and an enforced Content-Security-Policy that is `frame-ancestors
 * 'none'` alone, since a report-only policy never enforces frame-ancestors.
 * The full policy beside it is report-only: a browser reports what it would
 * block in its console and blocks nothing, so a source this list forgot
 * cannot break a page. Enforce it (fold it into the enforced header) once the
 * pages show no reports. Scripts and styles keep 'unsafe-inline' because the App
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
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
