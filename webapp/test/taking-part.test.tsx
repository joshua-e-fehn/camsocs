import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { EventDetails } from "@/components/molecules/event-details"
import { EventChip, EventRow } from "@/components/molecules/event-item"
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
  talksDerived: false,
  fromUniversity: false,
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

const PAGE = `https://camsocs.uk/events/${listed.key}`

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
    const page = await render(<EventRow event={listed} href="/events" />)
    expect(page.textContent).toContain("Taking part")
    expect(page.textContent).toContain("Cyber Security Society takes part")
    expect(page.querySelector(".border-dashed")?.textContent).toContain("Taking part")

    const hosted = await render(<EventRow event={{ ...listed, hosting: "hosts" }} href="/events" />)
    expect(hosted.textContent).not.toContain("Taking part")
    expect(hosted.textContent).not.toContain("takes part")
  })

  test("a calendar chip marks it with words for screen readers", async () => {
    const chip = await render(<EventChip event={listed} href="/events" />)
    expect(chip.querySelector("[aria-label^='Taking part']")).not.toBeNull()
    expect(chip.querySelector("a")?.getAttribute("title")).toContain("takes part")
  })

  test("the details never say organised by, and link the event's own page", async () => {
    const sheet = await render(<EventDetails event={details} pageUrl={PAGE} />)
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
      <EventDetails
        event={{ ...details, hosting: "hosts", externalUrl: undefined }}
        pageUrl={PAGE}
      />,
    )
    expect(sheet.textContent).not.toContain("takes part")
    expect(sheet.textContent).toContain("Cyber Security Society")
  })
})

describe("the University's own listings (ENG-24)", () => {
  // An invented listing from the University's public events programme.
  const university: EventListItem = {
    ...listed,
    key: `evt-${"d".repeat(40)}`,
    title: "Lantern lecture",
    organisers: [],
    eventType: "talk",
    source: "uni_events_api",
    sourceUrl: "https://events.example.ac.uk/whats-on/lantern-lecture",
    hosting: "hosts",
    externalUrl: undefined,
    fromUniversity: true,
  }

  test("a list item names the University and carries the badge", async () => {
    const row = await render(<EventRow event={university} href="/events" />)
    expect(row.textContent).toContain("University of Cambridge")
    expect(row.textContent).toContain("University")
    expect(row.textContent).not.toContain("Taking part")
    const chip = await render(<EventChip event={university} href="/events" />)
    expect(chip.querySelector("[aria-label='Listed by the University']")).not.toBeNull()
  })

  test("the details say the University lists it, with no society link", async () => {
    const sheet = await render(
      <EventDetails event={{ ...details, ...university, meta: {} }} pageUrl={PAGE} />,
    )
    expect(sheet.textContent).toContain("University of Cambridge")
    expect(sheet.textContent).toContain("From its public events programme")
    expect(sheet.textContent).toContain("Listed by")
    expect(sheet.textContent).not.toContain("Organiser")
    expect(sheet.querySelector("a[href^='/societies/']")).toBeNull()
  })
})

describe("emoji in titles", () => {
  test("stay on screen but out of the link's spoken name", async () => {
    const row = await render(<EventRow event={listed} href="/events" />)
    const link = row.querySelector("a")
    expect(link?.textContent).toContain("🚩")
    const hidden = link?.querySelector("[aria-hidden]")
    expect(hidden?.textContent).toBe("🚩")
    expect(link?.querySelector("span:not([aria-hidden])")?.textContent?.trim()).toBe(
      "DEADFACE CTF 2026",
    )
  })

  test("a chip's tooltip leaves them out", async () => {
    const chip = await render(<EventChip event={listed} href="/events" />)
    expect(chip.querySelector("a")?.getAttribute("title")).not.toContain("🚩")
  })
})

describe("calendar links", () => {
  test("a venue known only by its key is still the location", async () => {
    const { eventCalendarLinks } = await import("@/components/molecules/event-details")
    const keyed = { ...details, venueText: undefined, venueKey: "venue-adc-theatre" }
    const links = eventCalendarLinks(keyed, PAGE, "ADC Theatre")
    expect(new URL(links.google).searchParams.get("location")).toBe("ADC Theatre")
    expect(new URL(links.outlook).searchParams.get("location")).toBe("ADC Theatre")
    expect(new URL(eventCalendarLinks(keyed, PAGE).google).searchParams.has("location")).toBe(false)
  })
})
