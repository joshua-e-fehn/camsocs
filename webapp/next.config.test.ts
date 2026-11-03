import { describe, expect, test } from "bun:test"
import nextConfigExport, {
  contentSecurityPolicy,
  nextConfig,
  securityHeaders,
  sourceMapUploadOptions,
  withSourceMapUpload,
} from "./next.config"

/**
 * The PostHog source map upload (ENG-6) wraps the config only on a Vercel
 * production build with both credentials; everywhere else the config is the
 * very same object, since the plugin throws without a key and fails a
 * Turbopack build when the upload fails. Credentials here are fakes.
 */

const CREDENTIALS = { POSTHOG_PERSONAL_API_KEY: "phx_fake", POSTHOG_PROJECT_ID: "12345" }

describe("the source map upload gate", () => {
  test("leaves the config exactly unchanged unless every condition holds", () => {
    for (const env of [
      {},
      { VERCEL_ENV: "production" },
      { ...CREDENTIALS },
      { ...CREDENTIALS, VERCEL_ENV: "preview" },
      { ...CREDENTIALS, VERCEL_ENV: "development" },
      { POSTHOG_PERSONAL_API_KEY: "phx_fake", VERCEL_ENV: "production" },
      { POSTHOG_PROJECT_ID: "12345", VERCEL_ENV: "production" },
      { POSTHOG_PERSONAL_API_KEY: " ", POSTHOG_PROJECT_ID: "12345", VERCEL_ENV: "production" },
    ]) {
      expect(sourceMapUploadOptions(env)).toBeNull()
      expect(withSourceMapUpload(nextConfig, env)).toBe(nextConfig)
    }
  })

  test("this test run's own config is the plain object", () => {
    expect(process.env.POSTHOG_PERSONAL_API_KEY).toBeUndefined()
    expect(nextConfigExport).toBe(nextConfig)
  })

  test("a production build with both credentials uploads to EU Cloud and deletes the maps", () => {
    const env = { ...CREDENTIALS, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "abc123" }
    expect(sourceMapUploadOptions(env)).toEqual({
      personalApiKey: "phx_fake",
      projectId: "12345",
      host: "https://eu.posthog.com",
      logLevel: "warn",
      sourcemaps: {
        enabled: true,
        releaseName: "camsocs",
        releaseVersion: "abc123",
        deleteAfterUpload: true,
      },
    })
    // withPostHogConfig returns Next's config-function form.
    expect(typeof withSourceMapUpload(nextConfig, env)).toBe("function")
  })
})

/**
 * The browser protections (ENG-35): on every path, the CSP report-only, and
 * the policy naming the Convex deployment the build talks to.
 */
const PROD = {
  NEXT_PUBLIC_CONVEX_URL: "https://cheerful-bandicoot-511.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://cheerful-bandicoot-511.convex.site",
  VERCEL_ENV: "production",
  NODE_ENV: "production",
}

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split("; ").map((part) => {
      const [name, ...sources] = part.split(" ")
      return [name, sources]
    }),
  )
}

describe("the security headers", () => {
  test("apply to every path", async () => {
    const rules = await nextConfig.headers?.()
    expect(rules?.map((rule) => rule.source)).toEqual(["/:path*"])
    const names = rules?.[0].headers.map((header) => header.key)
    expect(names).toEqual([
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
      "Content-Security-Policy-Report-Only",
    ])
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  test("refuse framing and sniffing, trim referrers and switch off device features", () => {
    const byName = Object.fromEntries(securityHeaders(PROD).map((h) => [h.key, h.value]))
    expect(byName["X-Content-Type-Options"]).toBe("nosniff")
    expect(byName["Referrer-Policy"]).toBe("strict-origin-when-cross-origin")
    expect(byName["X-Frame-Options"]).toBe("DENY")
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(byName["Permissions-Policy"]).toContain(`${feature}=()`)
    }
    // HSTS is Vercel's (max-age=63072000 on camsocs.uk); never a second copy.
    expect(byName["Strict-Transport-Security"]).toBeUndefined()
    // Report-only until the pages show no reports; never enforced by accident.
    expect(byName["Content-Security-Policy"]).toBeUndefined()
  })

  test("the CSP allows self, the build's own Convex deployment and stored images", () => {
    const csp = directives(contentSecurityPolicy(PROD))
    expect(csp["default-src"]).toEqual(["'self'"])
    expect(csp["connect-src"]).toEqual([
      "'self'",
      "https://cheerful-bandicoot-511.convex.cloud",
      "wss://cheerful-bandicoot-511.convex.cloud",
      "https://cheerful-bandicoot-511.convex.site",
    ])
    expect(csp["img-src"]).toContain("https://*.convex.cloud")
    expect(csp["frame-ancestors"]).toEqual(["'none'"])
    expect(csp["object-src"]).toEqual(["'none'"])
    expect(csp["form-action"]).toEqual(["'self'"])
    // PostHog goes through /relay, so its hosts are not named.
    expect(contentSecurityPolicy(PROD)).not.toContain("posthog")
    expect(csp["script-src"]).not.toContain("'unsafe-eval'")
    expect(contentSecurityPolicy(PROD)).not.toContain("vercel.live")
  })

  test("falls back to any Convex deployment without a valid URL, and widens for dev and previews", () => {
    const bare = directives(contentSecurityPolicy({ NEXT_PUBLIC_CONVEX_URL: "not a url" }))
    expect(bare["connect-src"]).toEqual([
      "'self'",
      "https://*.convex.cloud",
      "wss://*.convex.cloud",
      "https://*.convex.site",
    ])
    const dev = directives(contentSecurityPolicy({ ...PROD, NODE_ENV: "development" }))
    expect(dev["script-src"]).toContain("'unsafe-eval'")
    const preview = directives(contentSecurityPolicy({ ...PROD, VERCEL_ENV: "preview" }))
    expect(preview["script-src"]).toContain("https://vercel.live")
    expect(preview["frame-src"]).toEqual(["https://vercel.live"])
    expect(preview["frame-ancestors"]).toEqual(["'none'"])
  })
})
