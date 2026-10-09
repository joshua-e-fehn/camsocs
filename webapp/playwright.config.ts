import { defineConfig } from "@playwright/test"

/**
 * The e2e smoke suite (`bun run e2e`, never part of `bun test`): every public
 * page, rendered by `next dev` against the deployment in `.env.local` (the dev
 * deployment), at desktop and phone size, with a full-page screenshot of each
 * under `<repo>/var/screenshots/<London date>/<E2E_LABEL>/` (gitignored).
 *
 * Read-only by construction (e2e/fixtures.ts): the Convex WebSocket is routed
 * through a guard that never lets a mutation or action reach the server — the
 * one form test answers its submit with a mocked response — and any non-GET
 * request to /api/auth is aborted. Server-rendered pages call public queries
 * only.
 *
 *   bun run e2e:install               # once: the Chromium build Playwright drives
 *   bun run e2e                       # starts `next dev` on :3100 unless E2E_BASE_URL is set
 *   E2E_LABEL=after bun run e2e       # a second set of screenshots beside the first
 */

const PORT = Number(process.env.E2E_PORT ?? 3100)
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`

const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
const mobile = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // `next dev` compiles each route on first request; two workers keep it busy
  // without starving it.
  workers: 2,
  fullyParallel: true,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "../var/e2e-results",
  use: {
    baseURL,
    browserName: "chromium",
    navigationTimeout: 120_000,
    locale: "en-GB",
    timezoneId: "Europe/London",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...desktop, colorScheme: "light" } },
    { name: "mobile", use: { ...mobile, colorScheme: "light" } },
    // Both themes are first-class (DESIGN.md §8): the pages tagged @dark again in dark.
    { name: "desktop-dark", grep: /@dark/, use: { ...desktop, colorScheme: "dark" } },
    { name: "mobile-dark", grep: /@dark/, use: { ...mobile, colorScheme: "dark" } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bunx next dev --turbopack --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
      },
})
