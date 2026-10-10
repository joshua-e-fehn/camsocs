import { checkAndCapture, expect, test } from "./fixtures"

/**
 * Smoke over every public page at desktop (1440×900) and phone (390×844)
 * size; pages tagged @dark run again in dark mode. Each test loads a page,
 * checks the basics (fixtures.ts `checkAndCapture`: one h1, no horizontal
 * overflow, a title, a description and a share image, no axe-core violation,
 * no uncaught errors, no write) and saves a full-page screenshot.
 *
 * Profiles are representative listings of the dev data (2026-10-08 harvest),
 * picked by `scripts/measure-public-api.ts`-style scans for data richness:
 */
const PROFILES = {
  /** University-level theatre company: logo, long description, ~37 Camdram
   * events, a conflicting field. */
  "profile-university": "amateur-dramatic-club",
  /** An SU-registered society whose orgType / level come from the classify
   * stage's rules (inferred), with events and weekly sessions. */
  "profile-su-society": "ethics-in-mathematics-society",
  /** A University sports club with sport facts and nine regular sessions (no
   * club has teams in the dev data yet). */
  "profile-sport": "triathlon-club",
  /** A college JCR. */
  "profile-jcr": "union-of-clare-students",
} as const

const PAGES: { name: string; path: string; dark?: boolean }[] = [
  { name: "home", path: "/", dark: true },
  { name: "societies", path: "/societies", dark: true },
  { name: "societies-filtered", path: "/societies?cat=sport&level=university" },
  { name: "societies-search", path: "/societies?q=music" },
  { name: "societies-page-2", path: "/societies?page=2" },
  { name: "societies-empty", path: "/societies?q=zzqx-no-such-society" },
  ...Object.entries(PROFILES).map(([name, slug]) => ({
    name,
    path: `/societies/${slug}`,
    dark: name === "profile-university",
  })),
  { name: "events-list", path: "/events", dark: true },
  { name: "events-week", path: "/events?view=week" },
  { name: "events-month", path: "/events?view=month", dark: true },
  { name: "events-org", path: `/events?org=${PROFILES["profile-university"]}` },
  { name: "about", path: "/about" },
  { name: "privacy", path: "/privacy" },
  { name: "request", path: "/request" },
  { name: "request-org", path: `/request?kind=correct&org=${PROFILES["profile-sport"]}` },
  { name: "sign-in", path: "/sign-in" },
  { name: "not-found", path: "/societies/zzqx-no-such-society" },
]

for (const { name, path, dark } of PAGES) {
  test(`${name}${dark ? " @dark" : ""}`, async ({ page }, testInfo) => {
    const response = await page.goto(path)
    if (name === "not-found") {
      // 404, or 200 once a loading boundary has streamed — then Next marks it noindex.
      expect([200, 404]).toContain(response?.status())
      await expect(page.getByText("Not found", { exact: true })).toBeVisible()
    } else {
      expect(response?.status(), `${path} status`).toBe(200)
    }
    await expect(page.locator("main, [data-slot=card]").first()).toBeVisible()
    await checkAndCapture(page, testInfo, name)
  })
}

test("dashboard sends a signed-out visitor to sign-in", async ({ page }, testInfo) => {
  await page.goto("/dashboard")
  await page.waitForURL("**/sign-in")
  await checkAndCapture(page, testInfo, "dashboard-signed-out")
})

test("directory filters change the URL and the results", async ({ page, isMobile }, testInfo) => {
  await page.goto("/societies")
  if (isMobile) {
    await page.getByRole("button", { name: /^Filters/ }).click()
    const sheet = page.getByRole("dialog", { name: "Filters" })
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(400)
    await checkAndCapture(page, testInfo, "societies-filter-sheet", {
      fullPage: false,
      skipSettle: true,
    })
    await sheet.getByRole("checkbox", { name: /Sport & Fitness/ }).click()
    await page.waitForURL(/cat=sport/)
    await sheet.getByRole("button", { name: /^Show \d+ results?$/ }).click()
    await expect(sheet).toBeHidden()
  } else {
    await page
      .getByRole("complementary", { name: "Filters" })
      .getByRole("checkbox", { name: /Sport & Fitness/ })
      .click()
  }
  await page.waitForURL(/cat=sport/)
  await expect(page.getByRole("button", { name: "Remove filter: Sport & Fitness" })).toBeVisible()
})

test("an event opens in a sheet @dark", async ({ page }, testInfo) => {
  await page.goto("/events")
  const first = page.locator("main ul li a").first()
  await expect(first).toBeVisible()
  await first.click()
  await page.waitForURL(/event=evt-/)
  const sheet = page.getByRole("dialog")
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText(/Listed from/)).toBeVisible()
  await page.waitForTimeout(400)
  await checkAndCapture(page, testInfo, "events-sheet", { fullPage: false, skipSettle: true })
})

test("events already running fold into one row that opens @dark", async ({ page }, testInfo) => {
  await page.goto("/events")
  // Count the toggle only once the list (or its empty state) is on screen:
  // counting before it rendered skipped the test by chance (review 2026-10-10).
  const listed = page.locator("main ul li a").first()
  await expect(listed.or(page.getByText("No events in this range"))).toBeVisible()
  const toggle = page.getByRole("button", { name: /^\d+ ongoing events?\b/ })
  test.skip((await toggle.count()) === 0, "nothing in the data began before today and is still on")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  const chips = page.locator("[data-slot=collapsible-content] a")
  await expect(chips.first()).toBeVisible()
  await expect(chips.first()).toContainText(/^until /)
  await checkAndCapture(page, testInfo, "events-ongoing", { fullPage: false })
})

test("the request form submits (mocked, nothing is written)", async ({ page, guard }, testInfo) => {
  guard.mock("listingRequests:submit", { key: "req-e2e-mocked" })
  await page.goto(`/request?kind=claim&org=${PROFILES["profile-jcr"]}`)
  // The button is enabled once React has hydrated the form; typing before
  // that would be reset by hydration.
  const send = page.getByRole("button", { name: "Send request" })
  await expect(send).toBeEnabled()
  await page.getByLabel("Your email").fill("e2e-test@example.com")
  await page
    .getByLabel("Message")
    .fill("End-to-end test of the request form. This submission is mocked and never sent.")
  await send.click()
  await expect(page.getByText("Request received")).toBeVisible()
  await expect(page.getByText("req-e2e-mocked")).toBeVisible()
  await checkAndCapture(page, testInfo, "request-submitted")
})

test("robots.txt, the sitemap and the share image are served", async ({ request }) => {
  const robots = await request.get("/robots.txt")
  expect(robots.status()).toBe(200)
  const robotsText = await robots.text()
  expect(robotsText).toContain("Disallow: /dashboard")
  expect(robotsText).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/)

  const sitemap = await request.get("/sitemap.xml")
  expect(sitemap.status()).toBe(200)
  const xml = await sitemap.text()
  expect(xml).toContain("<urlset")
  expect(xml).toContain(`/societies/${PROFILES["profile-university"]}</loc>`)

  const image = await request.get("/opengraph-image")
  expect(image.status()).toBe(200)
  expect(image.headers()["content-type"]).toBe("image/png")
})
