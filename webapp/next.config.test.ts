import { describe, expect, test } from "bun:test"
import nextConfigExport, {
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
