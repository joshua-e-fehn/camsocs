import type { Page, Request } from "@playwright/test"
import { expect, test } from "./fixtures"

/**
 * The analytics client in the real app (lib/analytics-client.ts, started by
 * instrumentation-client.ts). e2e runs without `NEXT_PUBLIC_POSTHOG_KEY`
 * (docs/deploy.md "PostHog") and under `navigator.webdriver`, so even
 * "Accept analytics" must send nothing and store nothing of PostHog's: no
 * request to the `/relay` proxy or a PostHog host, no `ph_*` / `__ph_*`
 * cookie or storage. A page without a grant also clears such storage left
 * from earlier, which proves the client runs on every page.
 */

test.use({ consent: null })

const POSTHOG = /\/relay(\/|$)|posthog\.com/

function watchAnalytics(page: Page): string[] {
  const seen: string[] = []
  page.on("request", (request: Request) => {
    if (POSTHOG.test(request.url())) seen.push(`${request.method()} ${request.url()}`)
  })
  return seen
}

async function analyticsStorage(page: Page): Promise<string[]> {
  const cookies = (await page.context().cookies())
    .map((cookie) => cookie.name)
    .filter((name) => name.startsWith("ph_") || name.startsWith("__ph_"))
    .map((name) => `cookie:${name}`)
  const stored = await page.evaluate(() => {
    const out: string[] = []
    for (const [label, storage] of [
      ["local", window.localStorage],
      ["session", window.sessionStorage],
    ] as const) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) ?? ""
        if (key.startsWith("ph_") || key.startsWith("__ph_")) out.push(`${label}:${key}`)
      }
    }
    return out
  })
  return [...cookies, ...stored]
}

test("without a key, Accept sends nothing to PostHog and stores nothing", async ({ page }) => {
  const seen = watchAnalytics(page)
  await page.goto("/")
  await page
    .getByRole("region", { name: "Analytics cookies" })
    .getByRole("button", { name: "Accept analytics" })
    .click()
  // A client-side navigation: the SDK would send a pageview here.
  await page.getByRole("contentinfo").getByRole("link", { name: "How CAMsocs works" }).click()
  await expect(page).toHaveURL(/\/about$/)
  await page.waitForLoadState("networkidle")
  await page.reload()
  await page.waitForLoadState("networkidle")
  expect(seen, "requests to the relay or PostHog").toEqual([])
  expect(await analyticsStorage(page), "PostHog cookies and storage").toEqual([])
})

test("without a key, taxonomy events (search, page views) send nothing", async ({ page }) => {
  // ENG-5: the search hook and the view islands run (the click tracker too),
  // but `track()` has no client to send through.
  const seen = watchAnalytics(page)
  await page.goto("/societies")
  await page
    .getByRole("region", { name: "Analytics cookies" })
    .getByRole("button", { name: "Accept analytics" })
    .click()
  await page.getByRole("searchbox", { name: "Search societies and clubs" }).fill("zzzzqx")
  await expect(page).toHaveURL(/[?&]q=zzzzqx/)
  await page.waitForLoadState("networkidle")
  await page.goto("/talks")
  await page.waitForLoadState("networkidle")
  expect(seen, "requests to the relay or PostHog").toEqual([])
  expect(await analyticsStorage(page), "PostHog cookies and storage").toEqual([])
})

test("a page without a grant clears PostHog storage left from before", async ({
  page,
  context,
}) => {
  const url = new URL(test.info().project.use.baseURL ?? "http://localhost:3100")
  await context.addCookies([
    { name: "ph_phc_left_over_posthog", value: "x", domain: url.hostname, path: "/" },
  ])
  await page.addInitScript(() => {
    try {
      if (window.sessionStorage.getItem("seeded")) return
      window.sessionStorage.setItem("seeded", "1")
      window.localStorage.setItem("ph_phc_left_over_posthog", '{"distinct_id":"x"}')
      window.localStorage.setItem("__ph_opt_in_out_phc_left_over", "1")
      window.sessionStorage.setItem("ph_phc_left_over_window_id", "w")
    } catch {
      // about:blank has no storage.
    }
  })
  await page.goto("/about")
  await expect
    .poll(() => analyticsStorage(page), { message: "leftover PostHog storage is cleared" })
    .toEqual([])
})
