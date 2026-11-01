import type { Page } from "@playwright/test"
import { accessibilityViolations, checkAndCapture, expect, test } from "./fixtures"

/**
 * The analytics consent banner as a first visitor meets it (spec "Consent
 * model"; lib/consent.ts, organisms/consent-banner.tsx): on the home page
 * until a choice, axe-clean while open, Reject and Accept each stored and
 * remembered across a reload, the footer's "Cookie settings" bringing it
 * back, never hiding the end of the page or a focused control (WCAG 2.2
 * SC 2.4.11), readable at 400% zoom (SC 1.4.10), and never shown on the
 * untracked sign-in page. No PostHog key is set in e2e, so nothing is sent
 * whatever is chosen.
 */

test.use({ consent: null })

const KEY = "camsocs-consent"

function banner(page: Page) {
  return page.getByRole("region", { name: "Analytics cookies" })
}

function settingsButton(page: Page) {
  return page.getByRole("contentinfo").getByRole("button", { name: "Cookie settings" })
}

/** After a reload: the banner, reopened, reads back the stored choice. That
 * only passes once the page has hydrated and read storage, unlike checking
 * that the (never server-rendered) banner is hidden. */
async function expectRemembered(page: Page, text: string) {
  await page.reload()
  await settingsButton(page).click()
  await expect(banner(page)).toContainText(text)
}

async function stored(page: Page): Promise<{ v?: number; choice?: string; at?: string }> {
  return await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? "{}"), KEY)
}

test("a first visit shows the banner, axe-clean", async ({ page }, testInfo) => {
  await page.goto("/")
  const region = banner(page)
  await expect(region).toBeVisible()
  await expect(region.getByRole("button", { name: "Accept analytics" })).toBeVisible()
  await expect(region.getByRole("button", { name: "Reject" })).toBeVisible()
  await expect(region.getByRole("link", { name: "Cookies and privacy" })).toHaveAttribute(
    "href",
    "/privacy#cookies",
  )
  expect(await accessibilityViolations(page), "no axe-core violation with the banner open").toEqual(
    [],
  )
  await checkAndCapture(page, testInfo, "consent-banner", { fullPage: false })
})

test("Reject hides the banner and stores a refusal", async ({ page }) => {
  await page.goto("/")
  await banner(page).getByRole("button", { name: "Reject" }).click()
  await expect(banner(page)).toBeHidden()
  const record = await stored(page)
  expect(record).toMatchObject({ v: 1, choice: "denied" })
  expect(Number.isFinite(Date.parse(record.at ?? ""))).toBe(true)
  await expectRemembered(page, "You currently refuse analytics.")
})

test("Accept hides the banner and stores consent", async ({ page }) => {
  await page.goto("/")
  await banner(page).getByRole("button", { name: "Accept analytics" }).click()
  await expect(banner(page)).toBeHidden()
  expect(await stored(page)).toMatchObject({ v: 1, choice: "granted" })
  await expectRemembered(page, "You currently allow analytics.")
})

test("Cookie settings in the footer reopens the banner", async ({ page }) => {
  await page.goto("/about")
  await banner(page).getByRole("button", { name: "Reject" }).click()
  await expect(banner(page)).toBeHidden()
  const settings = settingsButton(page)
  await settings.click()
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toBeFocused()
  await expect(banner(page)).toContainText("You currently refuse analytics.")
  await banner(page).getByRole("button", { name: "Accept analytics" }).click()
  await expect(banner(page)).toBeHidden()
  await expect(settings).toBeFocused()
  expect(await stored(page)).toMatchObject({ choice: "granted" })
})

test("an open banner hides neither a focused control nor the end of the page", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto("/about")
  const region = banner(page)
  await expect(region).toBeVisible()
  // Tab from the top until focus reaches the banner: every control on the way
  // must show at least partly above it (SC 2.4.11 Focus Not Obscured).
  let reachedBanner = false
  for (let step = 0; step < 80 && !reachedBanner; step++) {
    await page.keyboard.press("Tab")
    const focus = await page.evaluate(() => {
      const active = document.activeElement
      const region = document.querySelector("[data-consent-banner]")
      if (!active || !region) return null
      const rect = active.getBoundingClientRect()
      return {
        inBanner: region.contains(active),
        top: rect.top,
        bannerTop: region.getBoundingClientRect().top,
        label: `${active.tagName} ${active.textContent?.trim().slice(0, 40) ?? ""}`,
      }
    })
    expect(focus, "the banner is still open").not.toBeNull()
    if (!focus) break
    reachedBanner = focus.inBanner
    if (!reachedBanner) {
      expect(focus.top, `"${focus.label}" is not hidden behind the banner`).toBeLessThan(
        focus.bannerTop,
      )
    }
  }
  expect(reachedBanner, "tabbing reaches the banner").toBe(true)
  // Scrolled to the very end, the footer clears the banner.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const footerBottom = await page
    .getByRole("contentinfo")
    .evaluate((footer) => footer.getBoundingClientRect().bottom)
  const bannerTop = await region.evaluate((element) => element.getBoundingClientRect().top)
  expect(footerBottom).toBeLessThanOrEqual(bannerTop + 1)
})

test("at 400% zoom the banner stays below the header and readable", async ({ page }) => {
  // 1280x1024 at 400% (SC 1.4.10 Reflow).
  await page.setViewportSize({ width: 320, height: 256 })
  await page.goto("/about")
  const region = banner(page)
  await expect(region).toBeVisible()
  const headerBottom = await page
    .getByRole("banner")
    .evaluate((header) => header.getBoundingClientRect().bottom)
  const heading = region.getByRole("heading", { name: "Analytics cookies" })
  const headingTop = await heading.evaluate((element) => element.getBoundingClientRect().top)
  expect(headingTop).toBeGreaterThanOrEqual(headerBottom)
  await expect(heading).toBeInViewport()
  // Taller content scrolls inside the banner, so both choices can be reached.
  for (const name of ["Accept analytics", "Reject"]) {
    const choice = region.getByRole("button", { name })
    await choice.scrollIntoViewIfNeeded()
    await expect(choice).toBeInViewport()
  }
  await region.getByRole("button", { name: "Reject" }).click()
  await expect(region).toBeHidden()
})

test("the banner is not shown on sign-in, which is never tracked", async ({ page }) => {
  await page.goto("/sign-in")
  await expect(page.locator("main")).toBeVisible()
  // The banner mounts on hydration; wait for that before asserting absence.
  await page.waitForLoadState("networkidle")
  await expect(page.locator("[data-consent-banner]")).toHaveCount(0)
})
