import type { Page, TestInfo } from "@playwright/test"
import { axeViolations, expect, settle, test } from "./fixtures"

/**
 * The accessibility gate (ENG-37): axe-core over the main public pages and the
 * states a visitor reaches on them, at desktop and phone size. CI runs this
 * file alone (`.github/workflows/ci.yml`, job "accessibility"), against a
 * production build that reads the dev deployment's public data.
 *
 * A **serious or critical** violation fails the test. A moderate or minor one
 * is reported (an annotation on the test, a line in the log) without failing
 * it, so a best-practice nit in new data does not turn CI red; the smoke suite
 * (`checkAndCapture`) still asks for none at all when run by hand.
 *
 * Nothing here depends on a particular listing: the profile and event are the
 * first ones the directory and the calendar link to, so the file runs against
 * whatever data the deployment has. The same read-only guard as every e2e
 * test applies (fixtures.ts).
 */

const BLOCKING = new Set(["serious", "critical"])

/** Fails on serious and critical violations; reports the rest. */
async function expectAccessible(page: Page, testInfo: TestInfo, state: string) {
  const violations = await axeViolations(page)
  for (const violation of violations.filter((v) => !BLOCKING.has(v.impact))) {
    testInfo.annotations.push({ type: "axe", description: `${state}: ${violation.summary}` })
    console.log(`[axe] ${testInfo.project.name} ${state}: ${violation.summary}`)
  }
  expect(
    violations.filter((v) => BLOCKING.has(v.impact)).map((v) => v.summary),
    `no serious or critical axe-core violation on ${state}`,
  ).toEqual([])
}

/** Loads `path`, waits for it to render and settle, then checks it. */
async function check(page: Page, testInfo: TestInfo, path: string) {
  const response = await page.goto(path)
  expect(response?.status(), `${path} status`).toBeLessThan(500)
  await expect(page.locator("main").first()).toBeVisible()
  await settle(page)
  await expectAccessible(page, testInfo, path)
}

/** The first link in `main` whose path starts with `prefix`, or null. */
async function firstLink(page: Page, from: string, prefix: string): Promise<string | null> {
  await page.goto(from)
  const link = page.locator(`main a[href^="${prefix}"]`).first()
  await link.waitFor({ state: "attached", timeout: 15_000 }).catch(() => {})
  return await link.getAttribute("href").catch(() => null)
}

test.describe("accessibility @a11y", () => {
  const PAGES = [
    "/",
    "/societies",
    "/societies?cat=sport",
    "/events",
    "/events?view=week",
    "/events?view=month",
    "/talks",
    "/about",
    "/privacy",
    "/terms",
    "/request",
    "/request?kind=add",
    "/sign-in",
    "/societies/zzqx-no-such-society",
  ]
  for (const path of PAGES) {
    test(path, async ({ page }, testInfo) => {
      await check(page, testInfo, path)
    })
  }

  test("a society profile", async ({ page }, testInfo) => {
    const href = await firstLink(page, "/societies", "/societies/")
    test.skip(href === null, "the deployment lists no society")
    await check(page, testInfo, href as string)
  })

  test("an event page", async ({ page }, testInfo) => {
    const href = await firstLink(page, "/events", "/events/evt-")
    test.skip(href === null, "the deployment has no upcoming event")
    await check(page, testInfo, (href as string).split("?")[0])
  })

  test("the request form showing its errors", async ({ page }, testInfo) => {
    await page.goto("/request?kind=add")
    const send = page.getByRole("button", { name: "Send request" })
    await expect(send).toBeEnabled()
    await send.click()
    // The first invalid field takes focus and every error is on screen.
    await expect(page.locator("#request-newName")).toBeFocused()
    await expect(page.locator("[aria-invalid=true]").first()).toBeVisible()
    await expectAccessible(page, testInfo, "/request with errors")
  })

  test("the request form after sending (mocked)", async ({ page, guard }, testInfo) => {
    guard.answerRequestForm(200, { key: "req-e2e-a11y" })
    await page.goto("/request?kind=add")
    const send = page.getByRole("button", { name: "Send request" })
    await expect(send).toBeEnabled()
    await page.getByLabel("Society name").fill("E2E Accessibility Society")
    await page.getByLabel("Your email").fill("e2e-test@example.com")
    await page.getByLabel("Message").fill("Accessibility check of the sent state; never sent.")
    await send.click()
    const received = page.getByRole("status").filter({ hasText: "Request received" })
    await expect(received).toBeFocused()
    // Let the fade-in finish: mid-animation, axe measures text at part opacity.
    await settle(page)
    await expectAccessible(page, testInfo, "/request sent")
  })

  test("the search palette", async ({ page }, testInfo) => {
    await page.goto("/societies")
    await page.waitForLoadState("networkidle")
    await page.locator("header button:visible", { hasText: "Search" }).first().click()
    await expect(page.getByRole("dialog", { name: "Search CAMsocs" })).toBeVisible()
    await page.waitForTimeout(300)
    await expectAccessible(page, testInfo, "search palette")
  })

  test.describe("as a first visitor", () => {
    test.use({ consent: null })
    test("the consent banner", async ({ page }, testInfo) => {
      await page.goto("/about")
      await expect(page.getByRole("region", { name: "Analytics cookies" })).toBeVisible()
      await expectAccessible(page, testInfo, "consent banner")
    })
  })
})
