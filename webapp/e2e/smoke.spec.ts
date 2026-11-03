import { checkAndCapture, expect, test } from "./fixtures"

/**
 * Smoke over every public page at desktop (1440×900) and phone (390×844)
 * size; pages tagged @dark run again with a dark OS preference (the site is
 * light only, DESIGN.md §8). Each test loads a page,
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
  // Talks: a heading or the empty state, never the error boundary — also on
  // the first deploy, before the first talks sync (deploy.md §5.4).
  { name: "talks", path: "/talks", dark: true },
  { name: "talks-week", path: "/talks?preset=week" },
  { name: "talks-departments", path: "/talks/departments" },
  { name: "about", path: "/about" },
  { name: "privacy", path: "/privacy" },
  { name: "request", path: "/request" },
  { name: "request-org", path: `/request?kind=correct&org=${PROFILES["profile-sport"]}` },
  { name: "sign-in", path: "/sign-in" },
]

for (const { name, path, dark } of PAGES) {
  test(`${name}${dark ? " @dark" : ""}`, async ({ page }, testInfo) => {
    const response = await page.goto(path)
    expect(response?.status(), `${path} status`).toBe(200)
    await expect(page.locator("main, [data-slot=card]").first()).toBeVisible()
    await checkAndCapture(page, testInfo, name)
  })
}

/**
 * Unknown listing URLs are real 404s with the site's not-found page in the
 * server's HTML (ENG-20: proxy.ts, lib/missing-listing.ts) — never a 200
 * marked noindex, nor an empty shell that only JavaScript fills in. A
 * well-formed key the data does not have costs one existence query; a
 * malformed one none.
 */
// `heading` once hydrated; the server's HTML has the site's "Not found" for
// every kind (app/not-found-variant.tsx: the root not-found reads no request
// header, so it leaves every page cacheable).
const UNKNOWN: { name: string; path: string; heading: string }[] = [
  { name: "society", path: "/societies/zzqx-no-such-society", heading: "Not found" },
  { name: "society-malformed", path: "/societies/No_Such!", heading: "Not found" },
  { name: "event", path: `/events/evt-${"0".repeat(40)}`, heading: "Not found" },
  { name: "event-malformed", path: "/events/not-an-event", heading: "Not found" },
  { name: "talk", path: `/talks/talk-${"0".repeat(20)}`, heading: "This talk is no longer listed" },
  { name: "talk-malformed", path: "/talks/nope", heading: "This talk is no longer listed" },
]

for (const { name, path, heading } of UNKNOWN.filter((u) => !u.name.endsWith("-malformed"))) {
  test(`an unknown ${name} is a 404 in the site frame`, async ({ page }, testInfo) => {
    const response = await page.goto(path)
    expect(response?.status(), `${path} status`).toBe(404)
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible()
    await expect(page.locator("header").first()).toBeVisible()
    await expect(page.locator("footer").first()).toBeVisible()
    await checkAndCapture(page, testInfo, `not-found-${name}`)
  })
}

test.describe("without JavaScript, as a crawler", () => {
  test.use({
    javaScriptEnabled: false,
    userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  })
  for (const { name, path } of UNKNOWN) {
    test(`an unknown ${name} answers 404 with its not-found page in the HTML`, async ({ page }) => {
      const response = await page.goto(path)
      expect(response?.status(), `${path} status`).toBe(404)
      await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible()
      await expect(page.locator("html#__next_error__")).toHaveCount(0)
    })
  }

  test("a known profile still answers 200 with its content", async ({ page }) => {
    const response = await page.goto(`/societies/${PROFILES["profile-university"]}`)
    expect(response?.status()).toBe(200)
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0)
  })
})

test("router prefetches skip the 404 gate", async ({ request }) => {
  // The proxy's matcher keeps prefetches away (Next strips the header inside
  // the proxy), so a prefetch of a well-formed unknown key is not rewritten
  // to the missing-listing path (lib/missing-listing.ts MISSING_LISTING_PATH).
  // It may still be a 404: with no loading.tsx the page's own notFound()
  // sets the status (SEO audit, content-in-hidden-suspense) — in an RSC
  // payload, not the proxy's rewritten not-found page.
  const prefetch = await request.get(UNKNOWN[0].path, {
    headers: { RSC: "1", "Next-Router-Prefetch": "1" },
    maxRedirects: 0,
  })
  expect(prefetch.headers()["content-type"]).toContain("text/x-component")
  expect(prefetch.headers()["x-nextjs-rewritten-path"]).toBeUndefined()
  // The same request without the prefetch header passes the proxy, which
  // rewrites it: the header above would show a rewrite.
  const navigation = await request.get(UNKNOWN[0].path, { headers: { RSC: "1" }, maxRedirects: 0 })
  expect(navigation.status()).toBe(404)
  expect(navigation.headers()["x-nextjs-rewritten-path"]).toBe("/_missing-listing")
})

test("dashboard sends a signed-out visitor to sign-in", async ({ page }, testInfo) => {
  await page.goto("/dashboard")
  await page.waitForURL("**/sign-in")
  await checkAndCapture(page, testInfo, "dashboard-signed-out")
})

test("directory filters change the URL and the results", async ({ page, isMobile }, testInfo) => {
  await page.goto("/societies")
  // A category is a toggle chip (aria-pressed) named by its label and count.
  const sport = { name: /^Sport & Fitness \d+$/ }
  if (isMobile) {
    await page.getByRole("button", { name: /^Filters/ }).click()
    const sheet = page.getByRole("dialog", { name: "Filters" })
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(400)
    await checkAndCapture(page, testInfo, "societies-filter-sheet", {
      fullPage: false,
      skipSettle: true,
    })
    const chip = sheet.getByRole("button", { ...sport, pressed: false })
    await chip.click()
    await expect(sheet.getByRole("button", { ...sport, pressed: true })).toBeVisible()
    // The sheet keeps a draft: the URL changes only on "Show N societies".
    expect(page.url()).not.toMatch(/cat=sport/)
    await sheet.getByRole("button", { name: /^Show \d+ societ(y|ies)$/ }).click()
    await expect(sheet).toBeHidden()
  } else {
    const filters = page.getByRole("complementary", { name: "Filters" })
    await filters.getByRole("button", { ...sport, pressed: false }).click()
    await expect(filters.getByRole("button", { ...sport, pressed: true })).toBeVisible()
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
  await expect(listed.or(page.getByText(/^Nothing on/))).toBeVisible()
  const toggle = page.getByRole("button", { name: /^\d+ already on events?\b/ })
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
  expect(robotsText).toContain("Disallow: /relay")
  expect(robotsText).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/)

  // An index of three files (lib/sitemap.ts): pages, societies, events.
  const sitemap = await request.get("/sitemap.xml")
  expect(sitemap.status()).toBe(200)
  const index = await sitemap.text()
  expect(index).toContain("<sitemapindex")
  expect(index).toContain("/sitemaps/societies.xml</loc>")

  const societies = await request.get("/sitemaps/societies.xml")
  expect(societies.status()).toBe(200)
  const societiesXml = await societies.text()
  expect(societiesXml).toContain("<urlset")
  expect(societiesXml).toContain(`/societies/${PROFILES["profile-university"]}</loc>`)
  expect(societiesXml).toContain("/categories/")

  // No talks page in any sitemap outside /talks (owner decision G1).
  const events = await request.get("/sitemaps/events.xml")
  expect(events.status()).toBe(200)
  expect(await events.text()).not.toContain("/talks")

  const image = await request.get("/opengraph-image")
  expect(image.status()).toBe(200)
  expect(image.headers()["content-type"]).toBe("image/png")
})

test("an unknown talk's 404 leads back to the talks", async ({ page }) => {
  const response = await page.goto("/talks/talk-00000000000000000000")
  expect(response?.status()).toBe(404)
  await expect(page.getByRole("link", { name: "Upcoming talks" })).toHaveAttribute("href", "/talks")
})

test("the talks feed is a calendar, and AI crawlers are kept off talks", async ({ request }) => {
  const feed = await request.get("/talks.ics")
  expect(feed.status()).toBe(200)
  expect(feed.headers()["content-type"]).toContain("text/calendar")
  expect(await feed.text()).toContain("BEGIN:VCALENDAR")

  const robots = await (await request.get("/robots.txt")).text()
  const aiGroup = robots.slice(robots.indexOf("User-Agent: GPTBot"))
  expect(aiGroup).toContain("Disallow: /talks")
})

test("closing the search palette returns focus to the header button", async ({ page }) => {
  await page.goto("/talks")
  // The page streams in after the header: a palette opened before it has
  // hydrated marks it aria-hidden, and React reports that as a mismatch.
  await page.waitForLoadState("networkidle")
  // The header pill on desktop, the icon button on a phone: whichever shows.
  const button = page.locator("header button:visible", { hasText: "Search" }).first()
  await expect(button).toBeVisible()
  await button.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Search camsocs" })
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()
})
