import { describe, expect, test } from "bun:test"
import nextConfigExport, {
  HTML_LIMITED_BOTS,
  nextConfig,
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

describe("security headers (security-headers)", () => {
  test("every path gets them, with frame-ancestors as the whole CSP", async () => {
    const rules = (await nextConfig.headers?.()) ?? []
    const all = rules.find((rule) => rule.source === "/:path*")
    expect(all?.headers).toEqual([
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    ])
  })

  test("Next does not advertise itself", () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
