import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EventDetails } from "@/components/molecules/event-details"
import { EventChip, EventItem } from "@/components/molecules/event-item"
import type { EventListItem, EventPublic } from "@/lib/public-api"

/**
 * Decision D6 on the page: someone else's event a society only takes part in
 * (a CTF on its calendar) says so in words, is dashed, links its own page
 * off-site, and never reads "organised by".
 */

const STARTS = Date.UTC(2026, 9, 17, 14, 0)

const listed: EventListItem = {
  key: `evt-${"c".repeat(40)}`,
  title: "🚩 DEADFACE CTF 2026",
  startsAt: STARTS,
  allDay: false,
  organisers: [
    {
      key: "org-cyber-security-society",
      slug: "cyber-security-society",
      name: "Cyber Security Society",
      role: "organiser",
    },
  ],
  visibility: "public",
  eventType: "competition",
  cancelled: false,
  status: "confirmed",
  source: "google_calendar",
  hosting: "takes_part",
  externalUrl: "https://ctf.deadface.io/",
}

const details: EventPublic = {
  ...listed,
  speakers: [],
  lastSeenAt: STARTS - 86_400_000,
  confidence: 0.95,
  meta: {
    hosting: {
      status: "inferred",
      confidence: 0.5,
      sourceUrl: "https://calendar.google.com/calendar/ical/x/public/basic.ics",
      sourceType: "ics_feed",
      retrievedAt: STARTS - 86_400_000,
      method: "parser",
    },
  },
}

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

describe("events societies take part in (D6)", () => {
  test("a list item says who takes part, dashed, with the label", async () => {
    const page = await render(<EventItem event={listed} href="/events" />)
    expect(page.textContent).toContain("Taking part")
    expect(page.textContent).toContain("Cyber Security Society takes part")
    expect(page.querySelector("a")?.className).toContain("border-dashed")

    const hosted = await render(
      <EventItem event={{ ...listed, hosting: "hosts" }} href="/events" />,
    )
    expect(hosted.textContent).not.toContain("Taking part")
    expect(hosted.textContent).not.toContain("takes part")
  })

  test("a calendar chip marks it with words for screen readers", async () => {
    const chip = await render(<EventChip event={listed} href="/events" />)
    expect(chip.querySelector("[aria-label^='Taking part']")).not.toBeNull()
    expect(chip.querySelector("a")?.getAttribute("title")).toContain("takes part")
  })

  test("the details never say organised by, and link the event's own page", async () => {
    const sheet = await render(<EventDetails event={details} />)
    expect(sheet.textContent).not.toMatch(/organised by/i)
    expect(sheet.textContent).toContain("takes part")
    const external = [...sheet.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "https://ctf.deadface.io/",
    )
    expect(external?.getAttribute("target")).toBe("_blank")
    expect(external?.getAttribute("rel")).toContain("noopener")
    expect(external?.textContent).toContain("ctf.deadface.io")
  })

  test("a hosted event still names its organisers", async () => {
    const sheet = await render(
      <EventDetails event={{ ...details, hosting: "hosts", externalUrl: undefined }} />,
    )
    expect(sheet.textContent).not.toContain("takes part")
    expect(sheet.textContent).toContain("Cyber Security Society")
  })
})
