import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TalkRow } from "@/components/molecules/talk-row"
import type { TalkListItem } from "@/lib/talks"

/** 3 Nov 2026 is GMT: 13:00 UTC is 13:00 in London. */
const STARTS = Date.UTC(2026, 10, 3, 13, 0)

const talk: TalkListItem = {
  key: "talk-05f9cb992668bbf0c8dc",
  title: "Single-cell atlases of the developing heart",
  speakers: [{ name: "Luca Demo", affiliation: "University of Somewhere" }],
  series: "Engineering Lunchtime Talks",
  departments: [
    {
      key: "dept-engineering",
      slug: "engineering",
      shortName: "Engineering",
      school: "technology",
    },
  ],
  startsAt: STARTS,
  endsAt: STARTS + 3_600_000,
  allDay: false,
  venue: "Main Lecture Hall",
  online: false,
  kind: "seminar",
  cancelled: false,
  url: "https://example.org/talks/demo-1",
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

describe("TalkRow", () => {
  test("shows time, title, speaker, series, department and venue", async () => {
    const row = await render(<TalkRow talk={talk} href={`/talks/${talk.key}`} />)
    const text = row.textContent ?? ""
    expect(text).toContain("13:00")
    expect(text).toContain("14:00")
    expect(text).toContain("Single-cell atlases of the developing heart")
    expect(text).toContain("Luca Demo · University of Somewhere")
    expect(text).toContain("Engineering Lunchtime Talks")
    expect(text).toContain("Main Lecture Hall")
    // The department chip wears its School's colours.
    const chip = [...row.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Department"),
    )
    expect(chip?.className).toContain("bg-school-tech-tint")
    expect(text).not.toContain("Cancelled")
    expect(text).not.toContain("Online")
  })

  test("is one link to the talk's page, its title the link text", async () => {
    const row = await render(<TalkRow talk={talk} href={`/talks/${talk.key}`} />)
    const links = row.querySelectorAll("a")
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute("href")).toBe(`/talks/${talk.key}`)
    expect(links[0]?.textContent).toBe(talk.title)
    expect(row.querySelector("h3")).not.toBeNull()
  })

  test("a plain click can open the sheet instead", async () => {
    let opened = 0
    const row = await render(
      <TalkRow
        talk={talk}
        href={`/talks/${talk.key}`}
        onOpen={(event) => {
          event.preventDefault()
          opened += 1
        }}
      />,
    )
    await act(async () => row.querySelector("a")?.click())
    expect(opened).toBe(1)
  })

  test("marks cancelled and online talks in words", async () => {
    const row = await render(
      <TalkRow
        talk={{ ...talk, cancelled: true, online: true, venue: null }}
        href={`/talks/${talk.key}`}
      />,
    )
    const text = row.textContent ?? ""
    expect(text).toContain("Cancelled")
    expect(text).toContain("Online")
    expect(row.querySelector("a")?.className).toContain("line-through")
  })

  test("a talk in a room and online is hybrid; a lecture says so", async () => {
    const row = await render(
      <TalkRow talk={{ ...talk, online: true, kind: "lecture" }} href={`/talks/${talk.key}`} />,
    )
    expect(row.textContent).toContain("Hybrid")
    expect(row.textContent).toContain("Lecture")
  })

  test("says Now while a talk is on, and nothing before the clock is known", async () => {
    const before = await render(<TalkRow talk={talk} href="/talks/x" />)
    expect(before.textContent).not.toContain("Now")
    await act(async () => root?.unmount())
    const during = await render(<TalkRow talk={talk} href="/talks/x" now={STARTS + 600_000} />)
    expect(during.textContent).toContain("Now")
    await act(async () => root?.unmount())
    const soon = await render(<TalkRow talk={talk} href="/talks/x" now={STARTS - 25 * 60_000} />)
    expect(soon.textContent).toContain("in 25 min")
  })
})
