import type { Page } from "@playwright/test"
import { accessibilityViolations, checkAndCapture, expect, test } from "./fixtures"

/**
 * The analytics consent banner as a first visitor meets it (spec "Consent
 * model"; lib/consent.ts, organisms/consent-banner.tsx): on the home page
 * until a choice, axe-clean while open, Reject and Accept each stored and
 * remembered across a reload, the footer's "Cookie settings" bringing it
 * back, and never shown on the untracked sign-in page. No PostHog key is set
 * in e2e, so nothing is sent whatever is chosen.
 */

test.use({ consent: null })

const KEY = "camsocs-consent"

function banner(page: Page) {
  return page.getByRole("region", { name: "Analytics cookies" })
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
  await page.reload()
  await expect(page.locator("main")).toBeVisible()
  await expect(banner(page)).toBeHidden()
})

test("Accept hides the banner and stores consent", async ({ page }) => {
  await page.goto("/")
  await banner(page).getByRole("button", { name: "Accept analytics" }).click()
  await expect(banner(page)).toBeHidden()
  expect(await stored(page)).toMatchObject({ v: 1, choice: "granted" })
})

test("Cookie settings in the footer reopens the banner", async ({ page }) => {
  await page.goto("/about")
  await banner(page).getByRole("button", { name: "Reject" }).click()
  await expect(banner(page)).toBeHidden()
  const settings = page.getByRole("contentinfo").getByRole("button", { name: "Cookie settings" })
  await settings.click()
  await expect(banner(page)).toBeVisible()
  await expect(banner(page)).toBeFocused()
  await expect(banner(page)).toContainText("You currently refuse analytics.")
  await banner(page).getByRole("button", { name: "Accept analytics" }).click()
  await expect(banner(page)).toBeHidden()
  await expect(settings).toBeFocused()
  expect(await stored(page)).toMatchObject({ choice: "granted" })
})

test("the banner is not shown on sign-in, which is never tracked", async ({ page }) => {
  await page.goto("/sign-in")
  await expect(page.locator("main")).toBeVisible()
  // The banner mounts on hydration; wait for that before asserting absence.
  await page.waitForLoadState("networkidle")
  await expect(page.locator("[data-consent-banner]")).toHaveCount(0)
})
