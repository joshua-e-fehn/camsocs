import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AddToCalendar } from "@/components/molecules/add-to-calendar"
import { useTrackSearch, useTrackView } from "@/hooks/use-analytics"
import { analyticsLoading, resetAnalyticsForTests, startAnalytics } from "@/lib/analytics-client"
import type { SearchSurface } from "@/lib/analytics-events"
import { clearConsent, setConsent } from "@/lib/consent"

/**
 * The taxonomy's hooks in rendered components (ENG-5): a search box sends one
 * `search_performed` per settled query (plus `search_zero_results` when
 * nothing matched) with the query's length, never its text; a view sends
 * once per item; "Add to calendar" sends `calendar_subscribe_clicked` with
 * the item's key. All only with consent, through a recorder in place of
 * posthog-js (`startAnalytics({ load })`).
 */

const KEY = "phc_test_not_a_real_key"
const TALK = "talk-05f9cb992668bbf0c8dc"
const QUERY = "jane smith"

type Captured = { event: string; props: Record<string, unknown> }
const captured: Captured[] = []

const fakePostHog = {
  init(_token: string, config: { loaded?: (client: unknown) => void }) {
    config.loaded?.(fakePostHog)
  },
  capture(event: string, props: Record<string, unknown>) {
    captured.push({ event, props })
  },
  register() {},
  has_opted_out_capturing: () => false,
  opt_in_capturing() {},
  opt_out_capturing() {},
  reset() {},
  set_config() {},
}

function setWebdriver(value: boolean | undefined) {
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => value })
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

async function rerender(node: React.ReactNode) {
  await act(async () => root?.render(node))
}

async function grant() {
  setConsent("granted")
  startAnalytics({
    key: KEY,
    environment: "test",
    load: async () => ({ default: fakePostHog as never }),
  })
  await analyticsLoading()
}

beforeEach(() => {
  captured.length = 0
  setWebdriver(false)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  setWebdriver(undefined)
  resetAnalyticsForTests()
  clearConsent()
  window.localStorage.clear()
})

function Search({
  surface = "talks",
  query,
  count,
}: {
  surface?: SearchSurface
  query?: string
  count?: number
}) {
  useTrackSearch(surface, query, count)
  return null
}

describe("useTrackSearch", () => {
  test("waits for the results, then sends once per query with its length only", async () => {
    await grant()
    await render(<Search query={QUERY} />)
    expect(captured).toEqual([])
    await rerender(<Search query={QUERY} count={3} />)
    // A live update of the same query's results is not a new search.
    await rerender(<Search query={QUERY} count={4} />)
    expect(captured).toEqual([
      {
        event: "search_performed",
        props: { surface: "talks", queryLength: QUERY.length, resultCount: 3 },
      },
    ])
    expect(JSON.stringify(captured)).not.toContain("jane")
  })

  test("a search that finds nothing also sends search_zero_results", async () => {
    await grant()
    await render(<Search surface="societies" query="zzz" count={0} />)
    expect(captured).toEqual([
      {
        event: "search_performed",
        props: { surface: "societies", queryLength: 3, resultCount: 0 },
      },
      { event: "search_zero_results", props: { surface: "societies", queryLength: 3 } },
    ])
  })

  test("a new query, or the same one after clearing the box, sends again", async () => {
    await grant()
    await render(<Search query="chess" count={2} />)
    await rerender(<Search query="chess club" />)
    await rerender(<Search query="chess club" count={1} />)
    await rerender(<Search query="" count={undefined} />)
    await rerender(<Search query="chess" count={2} />)
    expect(captured.map(({ props }) => props.queryLength)).toEqual([5, 10, 5])
  })

  test("sends nothing without consent", async () => {
    startAnalytics({
      key: KEY,
      environment: "test",
      load: async () => ({ default: fakePostHog as never }),
    })
    await render(<Search query={QUERY} count={0} />)
    await analyticsLoading()
    expect(captured).toEqual([])
  })
})

function TalkSheet({ talkKey }: { talkKey: string | null }) {
  useTrackView("talk_viewed", talkKey ? { talkKey, departmentKey: "dept-engineering" } : null)
  return null
}

describe("useTrackView", () => {
  test("sends once per item, nothing while nothing is open", async () => {
    await grant()
    await render(<TalkSheet talkKey={null} />)
    await rerender(<TalkSheet talkKey={TALK} />)
    await rerender(<TalkSheet talkKey={TALK} />)
    await rerender(<TalkSheet talkKey="talk-ffffffffffffffffffff" />)
    expect(captured).toEqual([
      { event: "talk_viewed", props: { talkKey: TALK, departmentKey: "dept-engineering" } },
      {
        event: "talk_viewed",
        props: { talkKey: "talk-ffffffffffffffffffff", departmentKey: "dept-engineering" },
      },
    ])
  })

  test("closing and reopening the same item is a new view", async () => {
    await grant()
    await render(<TalkSheet talkKey={TALK} />)
    await rerender(<TalkSheet talkKey={null} />)
    await rerender(<TalkSheet talkKey={TALK} />)
    expect(captured.map(({ event }) => event)).toEqual(["talk_viewed", "talk_viewed"])
  })
})

describe("Add to calendar", () => {
  const links = {
    google: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=A+talk",
    ics: `/talks/${TALK}/ics`,
    outlook: "https://outlook.live.com/calendar/0/deeplink/compose?subject=A+talk",
    office365: "https://outlook.office.com/calendar/0/deeplink/compose?subject=A+talk",
  }

  function preventDefault(event: Event) {
    event.preventDefault()
  }

  beforeEach(() => document.addEventListener("click", preventDefault))
  afterEach(() => document.removeEventListener("click", preventDefault))

  async function choose(name: RegExp) {
    const trigger = document.querySelector("button")
    if (!trigger) throw new Error("no trigger")
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    const item = [...document.querySelectorAll<HTMLAnchorElement>("[role=menuitem]")].find(
      (element) => name.test(element.textContent ?? ""),
    )
    if (!item) throw new Error(`no menu item ${name}`)
    await act(async () => item.click())
  }

  test("each choice sends calendar_subscribe_clicked with the item's key", async () => {
    await grant()
    await render(<AddToCalendar links={links} item={{ feed: "talk", key: TALK }} />)
    await choose(/\.ics/)
    expect(captured).toEqual([
      { event: "calendar_subscribe_clicked", props: { feed: "talk", key: TALK } },
    ])
    await choose(/Google/)
    expect(captured).toHaveLength(2)
    expect(JSON.stringify(captured)).not.toContain("calendar.google.com")
  })

  test("without an item, or without consent, nothing is sent", async () => {
    await render(<AddToCalendar links={links} item={{ feed: "talk", key: TALK }} />)
    await choose(/\.ics/)
    expect(captured).toEqual([])
    await grant()
    await rerender(<AddToCalendar links={links} />)
    await choose(/\.ics/)
    expect(captured).toEqual([])
  })
})
