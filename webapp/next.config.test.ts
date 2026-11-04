import { describe, expect, test } from "bun:test"
import nextConfigExport, {
  botCheckClientFlag,
  contentSecurityPolicy,
  HTML_LIMITED_BOTS,
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
 * The browser protections (ENG-35, security-headers): on every path, framing
 * refused, the full CSP report-only, and
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
    const rules = (await nextConfig.headers?.()) ?? []
    const all = rules.filter((rule) => rule.source === "/:path*")
    expect(all).toHaveLength(1)
    const names = all[0].headers.map((header) => header.key)
    expect(names).toEqual([
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
      "Content-Security-Policy",
      "Content-Security-Policy-Report-Only",
    ])
  })

  test("Next does not advertise itself", () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  test("enforce frame-ancestors alone, the rest report-only (security-headers)", () => {
    const headers = securityHeaders(PROD)
    expect(headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" })
    expect(headers).toContainEqual({
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    })
    expect(headers).toContainEqual({
      key: "Content-Security-Policy",
      value: "frame-ancestors 'none'",
    })
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
    // Only framing is enforced; the full policy stays report-only until the
    // pages show no reports, never enforced by accident.
    expect(byName["Content-Security-Policy"]).toBe("frame-ancestors 'none'")
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

describe("blocking metadata for crawlers (metadata-streamed-into-body)", () => {
  const ua = (token: string) => `Mozilla/5.0 (compatible; ${token}/1.0; +https://example.org/bot)`

  test("is the config Next reads", () => {
    expect(nextConfig.htmlLimitedBots).toBe(HTML_LIMITED_BOTS)
  })

  test("keeps Next's own list and adds the AI fetchers and Googlebot", () => {
    for (const token of [
      // Next's defaults, which setting the option would otherwise drop.
      "bingbot",
      "DuckDuckBot",
      "facebookexternalhit",
      "Twitterbot",
      "Slackbot",
      "LinkedInBot",
      "WhatsApp",
      "Discordbot",
      "applebot",
      "AdsBot-Google",
      // Added.
      "Googlebot",
      "OAI-SearchBot",
      "ChatGPT-User",
      "PerplexityBot",
      "Perplexity-User",
      "Claude-SearchBot",
      "Claude-User",
      "DuckAssistBot",
      "MistralAI-User",
    ]) {
      expect(HTML_LIMITED_BOTS.test(ua(token))).toBe(true)
    }
  })

  test("leaves people's browsers streaming", () => {
    for (const browser of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    ]) {
      expect(HTML_LIMITED_BOTS.test(browser)).toBe(false)
    }
  })
})

describe("private routes say noindex (private-routes-noindex)", () => {
  test("by header on the broker area, sign-in, the API and the relay", async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    for (const source of ["/dashboard/:path*", "/sign-in/:path*", "/api/:path*", "/relay/:path*"]) {
      const rule = rules.find((candidate) => candidate.source === source)
      expect(rule?.headers).toContainEqual({ key: "X-Robots-Tag", value: "noindex, nofollow" })
    }
  })

  test("and on nothing public", async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const noindex = rules.filter((rule) =>
      rule.headers.some((header) => header.key === "X-Robots-Tag"),
    )
    for (const rule of noindex) {
      expect(rule.source).toMatch(/^\/(dashboard|sign-in|api|relay)\//)
    }
  })
})

describe("Vercel BotID (ENG-37)", () => {
  test("its challenge paths are rewritten to Vercel, and only they may be framed", async () => {
    const rewrites = await nextConfig.rewrites?.()
    const list = Array.isArray(rewrites) ? rewrites : []
    expect(list.map((rewrite) => rewrite.destination)).toEqual([
      "https://api.vercel.com/bot-protection/v1/challenge",
      "https://api.vercel.com/bot-protection/v1/proxy/:path*",
    ])
    const rules = (await nextConfig.headers?.()) ?? []
    // Next applies the last matching rule's value: BotID's comes after the site's.
    const botid = rules.findIndex((rule) => rule.source.startsWith("/149e9513-"))
    expect(botid).toBeGreaterThan(rules.findIndex((rule) => rule.source === "/:path*"))
    expect(rules[botid].headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" })
  })

  test("the browser half starts only in a build on Vercel", () => {
    expect(botCheckClientFlag({ VERCEL: "1" })).toBe("1")
    expect(botCheckClientFlag({})).toBe("")
    expect(botCheckClientFlag({ VERCEL_ENV: "preview" })).toBe("")
    expect(nextConfig.env?.NEXT_PUBLIC_BOT_CHECK).toBe(botCheckClientFlag())
  })
})
