import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import PrivacyPage from "@/app/(site)/privacy/page"
import { formatDate } from "@/lib/calendar"
import { PRIVACY_NOTICE_UPDATED } from "@/lib/site"

/**
 * The privacy notice states what the analytics design does (ENG-3): the
 * Cookies section must name PostHog, the consent record `camsocs-consent` and
 * the footer's "Cookie settings" control, and no section may still claim the
 * site has no analytics. If the consent design changes (lib/consent.ts, the
 * banner, the footer control), change docs/compliance/ and this page with it.
 */

let root: Root | undefined

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(node))
  return container
}

afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ""
})

function section(page: HTMLElement, id: string): string {
  const element = page.querySelector(`section#${id}`)
  expect(element).not.toBeNull()
  return element?.textContent ?? ""
}

describe("Privacy notice", () => {
  test("the Cookies section names PostHog, the consent record and Cookie settings", async () => {
    const cookies = section(await render(<PrivacyPage />), "cookies")
    expect(cookies).toContain("PostHog")
    expect(cookies).toContain("camsocs-consent")
    expect(cookies).toContain("Cookie settings")
    expect(cookies).toContain("“Accept analytics”")
    expect(cookies).toContain("“Reject”")
    expect(cookies).toContain("ph_")
    expect(cookies).toContain("180 days")
  })

  test("no section still says the site has no analytics", async () => {
    const text = (await render(<PrivacyPage />)).textContent ?? ""
    expect(text).not.toMatch(/no analytics/i)
    expect(text).not.toContain("light and dark mode")
  })

  test("PostHog is a listed processor on EU Cloud, with its lawful bases and retention", async () => {
    const page = await render(<PrivacyPage />)
    const sharing = section(page, "sharing")
    expect(sharing).toContain("PostHog")
    expect(sharing).toContain("Frankfurt")
    expect(sharing).toContain("1 November 2026")
    const why = section(page, "why")
    expect(why).toContain("Site analytics in your browser")
    expect(why).toContain("Article 6(1)(a)")
    expect(why).toContain("Error reports and anonymous counts from our servers")
    expect(section(page, "retention")).toContain("up to one year")
    expect(section(page, "rights")).toContain("withdraw your consent")
  })

  test("shows the date the notice last changed", async () => {
    const text = (await render(<PrivacyPage />)).textContent ?? ""
    expect(text).toContain(`Last updated ${formatDate(PRIVACY_NOTICE_UPDATED)}`)
  })
})
