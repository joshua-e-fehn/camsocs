import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { startClickTracking, track as trackTyped } from "./analytics"
import { analyticsLoading, resetAnalyticsForTests, startAnalytics } from "./analytics-client"
import {
  ANALYTICS_EVENTS,
  allowedProps,
  analyticsAttrs,
  analyticsContext,
  readSignInMarker,
  withSignInMarker,
} from "./analytics-events"
import { clearConsent, setConsent } from "./consent"

/**
 * The event taxonomy (ENG-5; spec "Event taxonomy", hard rules 1-2,
 * docs/analytics.md): `track()` sends only taxonomy events, with only their
 * allowed properties and only key, enum, count or boolean values; it does
 * nothing until the consent-gated client runs; and the click tracker turns
 * server-rendered `analyticsAttrs` into the same checked events.
 *
 * posthog-js is replaced by a recorder handed to `startAnalytics({ load })`,
 * so nothing is downloaded or sent.
 */

const KEY = "phc_test_not_a_real_key"
const TALK = "talk-05f9cb992668bbf0c8dc"
const EVENT = `evt-${"a".repeat(40)}`

type Captured = { event: string; props: Record<string, unknown> }
const captured: Captured[] = []
let loads = 0

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

const load = async () => {
  loads++
  return { default: fakePostHog as never }
}

/** `track` for tests that hand it what a careless caller might. */
const track = trackTyped as (event: string, props: Record<string, unknown>) => void

async function settle() {
  await analyticsLoading()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function startWithKey() {
  startAnalytics({ key: KEY, environment: "test", load })
}

/** happy-dom reports an automated browser, which the client refuses. */
function setWebdriver(value: boolean | undefined) {
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => value })
}

beforeEach(() => {
  captured.length = 0
  loads = 0
  setWebdriver(false)
})

afterEach(() => {
  setWebdriver(undefined)
  resetAnalyticsForTests()
  clearConsent()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe("the allow-list", () => {
  const allowed = (event: string, props: Record<string, unknown>) =>
    allowedProps(ANALYTICS_EVENTS, event, props)

  test("drops unknown events and unknown properties", () => {
    expect(allowed("page_title_viewed", { title: "x" })).toBeNull()
    expect(allowed("toString", {})).toBeNull()
    expect(
      allowed("outbound_link_clicked", {
        kind: "website",
        url: "https://example.org/?name=me",
        href: "https://example.org",
        text: "Our website",
      }),
    ).toEqual({ kind: "website" })
  })

  test("drops text where a key or an enum belongs", () => {
    // A required property that fails: the event is not sent.
    expect(allowed("society_viewed", { orgKey: "Chess Society", categories: [] })).toBeNull()
    expect(allowed("outbound_link_clicked", { kind: "Instagram" })).toBeNull()
    // An optional one that fails: the property goes, the event stays.
    expect(allowed("outbound_link_clicked", { kind: "social", orgKey: "CU Chess Club" })).toEqual({
      kind: "social",
    })
    expect(
      allowed("society_viewed", { orgKey: "org-chess", categories: ["sport", "Chess for all"] }),
    ).toBeNull()
    expect(allowed("society_viewed", { orgKey: "org-chess", categories: ["sport"] })).toEqual({
      orgKey: "org-chess",
      categories: ["sport"],
    })
  })

  test("talk events take the talk's and department's keys and nothing else", () => {
    expect(
      allowed("talk_viewed", {
        talkKey: TALK,
        departmentKey: "dept-engineering",
        title: "Single-cell atlases of the developing heart",
        speaker: "Luca Demo",
        series: "Engineering Lunchtime Talks",
      }),
    ).toEqual({ talkKey: TALK, departmentKey: "dept-engineering" })
    expect(allowed("talk_viewed", { talkKey: "Single-cell atlases" })).toBeNull()
    expect(allowed("talk_viewed", { talkKey: `${TALK} Single-cell` })).toBeNull()
    expect(allowed("talk_viewed", { talkKey: TALK, departmentKey: "Engineering" })).toEqual({
      talkKey: TALK,
    })
    expect(
      allowed("calendar_subscribe_clicked", { feed: "talk", key: "Single-cell atlases" }),
    ).toEqual({ feed: "talk" })
  })

  test("search events carry the query's length, never its text", () => {
    const props = { surface: "talks", queryLength: 5, resultCount: 0, query: "smith", q: "smith" }
    expect(allowed("search_performed", props)).toEqual({
      surface: "talks",
      queryLength: 5,
      resultCount: 0,
    })
    expect(allowed("search_zero_results", props)).toEqual({ surface: "talks", queryLength: 5 })
    // The text passed where the length belongs is not a count.
    expect(allowed("search_zero_results", { surface: "talks", queryLength: "smith" })).toBeNull()
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", 1_000_001]) {
      expect(allowed("search_performed", { ...props, resultCount: bad })).toBeNull()
    }
  })

  test("the request and sign-in events carry their kind or method only", () => {
    expect(
      allowed("listing_request_submitted", {
        kind: "claim",
        orgKey: "org-chess",
        email: "president@example.org",
        message: "Please add our new committee",
      }),
    ).toEqual({ kind: "claim" })
    expect(allowed("sign_in_completed", { method: "cam", email: "ab123@cam.ac.uk" })).toEqual({
      method: "cam",
    })
    expect(allowed("sign_in_completed", { method: "ab123@cam.ac.uk" })).toBeNull()
    expect(allowed("finder_completed", { finder: "societies", resultCount: 15 })).toEqual({
      finder: "societies",
      resultCount: 15,
    })
    expect(allowed("finder_completed", { finder: "music, beginner", resultCount: 3 })).toBeNull()
  })
})

describe("track", () => {
  test("does nothing without consent: nothing loads, nothing is captured", async () => {
    startWithKey()
    track("society_viewed", { orgKey: "org-chess", categories: [] })
    await settle()
    expect(loads).toBe(0)
    expect(captured).toEqual([])
  })

  test("does nothing without a key, even with consent", async () => {
    setConsent("granted")
    startAnalytics({ key: undefined, environment: "test", load })
    track("society_viewed", { orgKey: "org-chess", categories: [] })
    await settle()
    expect(loads).toBe(0)
    expect(captured).toEqual([])
  })

  test("does nothing after a withdrawal", async () => {
    setConsent("granted")
    startWithKey()
    await settle()
    setConsent("denied")
    track("society_viewed", { orgKey: "org-chess", categories: [] })
    await settle()
    expect(captured).toEqual([])
  })

  test("sends the allowed properties once the client runs", async () => {
    setConsent("granted")
    startWithKey()
    await settle()
    track("event_viewed", {
      eventKey: EVENT,
      orgKeys: ["org-chess"],
      hosting: "hosts",
      title: "Freshers' blitz",
    })
    expect(captured).toEqual([
      {
        event: "event_viewed",
        props: { eventKey: EVENT, orgKeys: ["org-chess"], hosting: "hosts" },
      },
    ])
  })

  test("an event fired while the package loads is sent once it has loaded", async () => {
    setConsent("granted")
    startWithKey()
    // Before the lazy import settles: a view fired on the landing page.
    track("talk_viewed", { talkKey: TALK })
    expect(captured).toEqual([])
    await settle()
    expect(captured).toEqual([{ event: "talk_viewed", props: { talkKey: TALK } }])
  })

  test("an event the taxonomy refuses is never sent", async () => {
    setConsent("granted")
    startWithKey()
    await settle()
    track("talk_viewed", { talkKey: "A talk title" })
    track("search_performed", { surface: "talks", query: "smith" })
    expect(captured).toEqual([])
  })
})

describe("the click tracker", () => {
  let stop: () => void = () => {}

  beforeEach(async () => {
    setConsent("granted")
    startWithKey()
    await settle()
    stop = startClickTracking()
    // Keep happy-dom from following the links.
    document.addEventListener("click", preventDefault)
  })

  afterEach(() => {
    stop()
    document.removeEventListener("click", preventDefault)
  })

  function preventDefault(event: Event) {
    event.preventDefault()
  }

  function link(attrs: Record<string, string | undefined>, parent: HTMLElement = document.body) {
    const anchor = document.createElement("a")
    anchor.href = "https://example.org/?who=me"
    anchor.textContent = "Our website"
    for (const [name, value] of Object.entries(attrs)) {
      if (value !== undefined) anchor.setAttribute(name, value)
    }
    const icon = document.createElement("span")
    anchor.append(icon)
    parent.append(anchor)
    return { anchor, icon }
  }

  test("sends the marked event with the surrounding context, never the address", () => {
    const article = document.createElement("article")
    for (const [name, value] of Object.entries(analyticsContext({ orgKey: "org-chess" }))) {
      if (value) article.setAttribute(name, value)
    }
    document.body.append(article)
    const { icon } = link(analyticsAttrs("outbound_link_clicked", { kind: "website" }), article)
    icon.click()
    expect(captured).toEqual([
      { event: "outbound_link_clicked", props: { kind: "website", orgKey: "org-chess" } },
    ])
  })

  test("a context property the event does not allow is dropped", () => {
    const section = document.createElement("section")
    for (const [name, value] of Object.entries(analyticsContext({ orgKey: "org-chess" }))) {
      if (value) section.setAttribute(name, value)
    }
    document.body.append(section)
    const { anchor } = link(
      analyticsAttrs("calendar_subscribe_clicked", { feed: "talks", key: "dept-engineering" }),
      section,
    )
    anchor.click()
    expect(captured).toEqual([
      { event: "calendar_subscribe_clicked", props: { feed: "talks", key: "dept-engineering" } },
    ])
  })

  test("a middle click counts; a right click and unmarked links do not", () => {
    const { anchor } = link(analyticsAttrs("outbound_link_clicked", { kind: "source" }))
    anchor.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }))
    anchor.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 }))
    link({}).anchor.click()
    expect(captured).toEqual([{ event: "outbound_link_clicked", props: { kind: "source" } }])
  })

  test("forged or broken markup sends nothing it should not", () => {
    link({
      "data-analytics-event": "outbound_link_clicked",
      "data-analytics-props": "{",
    }).anchor.click()
    link({
      "data-analytics-event": "outbound_link_clicked",
      "data-analytics-props": JSON.stringify({ kind: "other", url: "https://example.org/?who=me" }),
    }).anchor.click()
    link({ "data-analytics-event": "$identify", "data-analytics-props": "{}" }).anchor.click()
    expect(captured).toEqual([{ event: "outbound_link_clicked", props: { kind: "other" } }])
  })
})

describe("the sign-in marker", () => {
  test("is added to the callback path, keeping its query and fragment", () => {
    expect(withSignInMarker("/", "cam")).toBe("/?signed_in=cam")
    expect(withSignInMarker("/events?weeks=4#top", "cam")).toBe("/events?weeks=4&signed_in=cam#top")
  })

  test("is read and removed from the landing URL; an unknown method is only removed", () => {
    expect(readSignInMarker("https://camsocs.uk/events?weeks=4&signed_in=cam")).toEqual({
      method: "cam",
      cleaned: "/events?weeks=4",
    })
    expect(readSignInMarker("https://camsocs.uk/?signed_in=someone%40cam.ac.uk")).toEqual({
      method: null,
      cleaned: "/",
    })
    expect(readSignInMarker("https://camsocs.uk/events")).toEqual({ method: null, cleaned: null })
  })
})
