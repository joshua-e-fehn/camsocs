import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import PrivacyPage from "@/app/(site)/privacy/page"
import { ANALYTICS_EVENTS } from "@/lib/analytics-events"
import { formatDate } from "@/lib/calendar"
import { PRIVACY_NOTICE_UPDATED } from "@/lib/site"

/**
 * The privacy notice states what the analytics design does (ENG-3): the
 * Cookies section must name PostHog, the consent record `camsocs-consent` and
 * the footer's "Cookie settings" control, and no section may still claim the
 * site has no analytics. If the consent design changes (lib/consent.ts, the
 * banner, the footer control), change docs/compliance/ and this page with it.
 * The browsing section names every event of the taxonomy (ENG-5,
 * lib/analytics-events.ts): a new event fails here until the notice has it.
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
    expect(cookies).toContain("__ph_")
    expect(cookies).toContain("session storage")
    expect(cookies).toContain("180 days from your last visit")
    // posthog-js writes two cookies (ENG-5 wording fix).
    expect(cookies).toContain("two first-party cookies")
    expect(cookies).toContain("ph_<key>_posthog")
    expect(cookies).toContain("ph_<key>_posthog_cpm")
    expect(cookies).toContain("no longer reads or writes")
  })

  test("the browsing section names every kind of event and the browser data sent", async () => {
    const what = section(await render(<PrivacyPage />), "what")
    for (const event of Object.keys(ANALYTICS_EVENTS)) expect(what).toContain(event)
    expect(what).toContain("request form (listing_request_submitted): only its kind")
    expect(what).toContain("never what you typed")
    expect(what).toContain("never its title or speaker")
    expect(what).toContain("never the link’s address")
    expect(what).toContain("never who")
    expect(what).toContain("language and time zone")
    expect(what).toContain("change with each visit, browser tab and page view")
    expect(what).not.toContain("the random identifier")
    expect(what).toContain("without your IP address, cookies or browser identification string")
    expect(what).toContain("never identify you when you are signed in")
    expect(what).not.toContain("never stored")
    expect(what).toContain("built to contain no personal data")
    expect(what).toContain("which feed, and which event or talk")
    expect(what).toContain("could match the two")
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
    expect(sharing).not.toMatch(/accepted on/)
    expect(page.querySelector('a[href="https://posthog.com/dpa"]')).not.toBeNull()
    const why = section(page, "why")
    expect(why).toContain("Site analytics in your browser")
    expect(why).toContain("Article 6(1)(a)")
    expect(why).toContain("Error reports and anonymous counts from our servers")
    const retention = section(page, "retention")
    expect(retention).toContain("up to one year")
    expect(retention).not.toContain("deleted by PostHog")
    const rights = section(page, "rights")
    expect(rights).toContain("withdraw your consent")
    expect(rights).toContain("does not make the processing before it unlawful")
    expect(rights).toContain("Article 20")
  })

  test("database backups have their retention, as retention.md R14 sets it (ENG-44)", async () => {
    const retention = section(await render(<PrivacyPage />), "retention")
    expect(retention).toContain("Backups of our database")
    expect(retention).toContain("14 nights")
    expect(retention).toContain("we delete again whatever had been deleted since it was made")
  })

  test("the sources name the University's events programme and Meta Business Discovery", async () => {
    const what = section(await render(<PrivacyPage />), "what")
    expect(what).toContain("public events programme (What’s On, the Cambridge Festival")
    expect(what).toContain("Business Discovery API")
    // The published side of the Art 14(5)(e) assessment (dpia-lite §4).
    expect(what).toContain("If we have not written to you")
    expect(what).toContain("person named in the title of a University event")
    // The Art 14 notice to societies (J7) has not gone out yet.
    expect(what).toContain("We are writing to every society we list")
    // Group 5 of dpia-lite §4: societies with no address we can use (ENG-40).
    expect(what).toContain("Some societies publish no address we can write to")
    expect(what).toContain("this notice is how its committee is told")
  })

  test("names the VPS host, and says how the AI model is reached without implying a DPA", async () => {
    const sharing = section(await render(<PrivacyPage />), "sharing")
    expect(sharing).toContain("Hostinger")
    expect(sharing).toContain("ChatGPT subscription")
    expect(sharing).toContain("cliproxy")
    expect(sharing).toContain("We have no data processing agreement with OpenAI")
    // ENG-44 (record-of-processing, transfers): OpenAI's Europe terms give a
    // UK resident's subscription to OpenAI OpCo and an EEA resident's to
    // OpenAI Ireland; which holds the operator's is unconfirmed, so both are
    // named. OpenAI's own SCCs are not a safeguard we hold, and the notice
    // must not claim one under the subscription.
    expect(sharing).toContain("OpenAI OpCo, LLC")
    expect(sharing).toContain("OpenAI Ireland Ltd")
    expect(sharing).toContain("not yet confirmed")
    expect(sharing).toContain("give us no safeguard of our own")
    expect(sharing).toContain("OpenAI is the exception")
    expect(sharing).not.toMatch(/offer none|in the United\s+States, under/)
    // What the VPS holds includes list mail, not only page copies.
    expect(sharing).toContain("mailing-list messages being processed")
    // OpenAI is not in the list of providers that act on our behalf.
    const providers = sharing.slice(0, sharing.indexOf("The AI model"))
    expect(providers).not.toContain("OpenAI")
  })

  test("names the regulator one way: the Information Commission, formerly the ICO", async () => {
    // The ICO became the Information Commission on 30 September 2026
    // (landscape brief §5.2); every mention of the old name says "formerly".
    const text = (await render(<PrivacyPage />)).textContent ?? ""
    const full = "the Information Commission (formerly the Information Commissioner’s Office, ICO)"
    expect(text).toContain(full)
    expect(text.split("Information Commissioner’s Office").length).toBe(text.split(full).length)
  })

  test("shows the date the notice last changed", async () => {
    const text = (await render(<PrivacyPage />)).textContent ?? ""
    expect(text).toContain(`Last updated ${formatDate(PRIVACY_NOTICE_UPDATED)}`)
  })
})
