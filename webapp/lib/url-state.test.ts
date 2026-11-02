import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import {
  activeDirectoryFilterCount,
  activeEventFilterCount,
  directoryCursor,
  directoryFilters,
  directoryListArgs,
  EMPTY_DIRECTORY,
  EMPTY_EVENTS,
  effectiveDirectorySort,
  eventListArgs,
  eventsHref,
  eventsWindow,
  isEventKey,
  MAX_LIST_WEEKS,
  parseDirectoryParams,
  parseEventsParams,
  serializeDirectoryState,
  serializeEventsState,
} from "./url-state"

describe("directory URL state", () => {
  test("an empty URL is the empty state, and serialises to nothing", () => {
    expect(parseDirectoryParams({})).toEqual({ ...EMPTY_DIRECTORY, q: undefined })
    expect(serializeDirectoryState(EMPTY_DIRECTORY)).toBe("")
  })

  test("round-trips every filter", () => {
    const url =
      "?q=chess&cat=hobbies_games,music&level=university&college=org-trinity-college" +
      "&activity=socials&audience=beginners&status=active&blue=half&gender=women" +
      "&beginner=yes&page=3"
    const state = parseDirectoryParams(Object.fromEntries(new URLSearchParams(url)))
    expect(state).toEqual({
      q: "chess",
      categories: ["music", "hobbies_games"],
      levels: ["university"],
      collegeKeys: ["org-trinity-college"],
      activityTypes: ["socials"],
      audiences: ["beginners"],
      statuses: ["active"],
      blueStatus: ["half"],
      gender: ["women"],
      beginnerFriendly: true,
      page: 3,
    })
    expect(serializeDirectoryState(state)).toBe(url)
    expect(parseDirectoryParams(Object.fromEntries(new URLSearchParams(url)))).toEqual(state)
  })

  test("drops unknown values and malformed keys instead of failing", () => {
    const state = parseDirectoryParams({
      cat: "music,not-a-category,,music",
      college: ["org-kings", "Trinity", "org-"],
      beginner: "maybe",
      page: "-4",
    })
    expect(state.categories).toEqual(["music"])
    expect(state.collegeKeys).toEqual(["org-kings"])
    expect(state.beginnerFriendly).toBeUndefined()
    expect(state.page).toBe(1)
  })

  test("serialising is canonical: value order does not change the URL", () => {
    const a = serializeDirectoryState({ ...EMPTY_DIRECTORY, categories: ["sport", "music"] })
    const b = serializeDirectoryState({ ...EMPTY_DIRECTORY, categories: ["music", "sport"] })
    expect(a).toBe(b)
    expect(a).toBe("?cat=music,sport")
  })

  test("a long query is trimmed, and whitespace-only is no query", () => {
    expect(parseDirectoryParams({ q: "  " }).q).toBeUndefined()
    expect(parseDirectoryParams({ q: "x".repeat(500) }).q?.length).toBe(200)
  })

  test("maps to Convex filter args without undefined members", () => {
    const state = { ...EMPTY_DIRECTORY, categories: ["music" as const], beginnerFriendly: false }
    expect(directoryFilters(state)).toEqual({
      categories: ["music"],
      sport: { beginnerFriendly: false },
    })
    expect(directoryFilters(EMPTY_DIRECTORY)).toEqual({})
    expect(activeDirectoryFilterCount(state)).toBe(2)
    expect(directoryCursor({ ...state, page: 3 })).toBe("48")
  })
})

describe("directory sort", () => {
  test("round-trips a sort; the default and junk leave the URL alone", () => {
    expect(parseDirectoryParams({ sort: "active" }).sort).toBe("active")
    expect(parseDirectoryParams({ sort: "name", q: "rowing" }).sort).toBe("name")
    expect(parseDirectoryParams({ sort: "relevance" }).sort).toBeUndefined()
    expect(parseDirectoryParams({ sort: "random" }).sort).toBeUndefined()
    expect(serializeDirectoryState({ ...EMPTY_DIRECTORY, sort: "active", page: 2 })).toBe(
      "?sort=active&page=2",
    )
    expect(serializeDirectoryState({ ...EMPTY_DIRECTORY, sort: "relevance" })).toBe("")
  })

  test("relevance is A–Z without a text query", () => {
    expect(effectiveDirectorySort(EMPTY_DIRECTORY)).toBe("name")
    expect(effectiveDirectorySort({ ...EMPTY_DIRECTORY, q: "chess" })).toBe("relevance")
    expect(effectiveDirectorySort({ ...EMPTY_DIRECTORY, q: "chess", sort: "active" })).toBe(
      "active",
    )
  })

  test("list args carry `sort` only when it is not the default", () => {
    expect(directoryListArgs(EMPTY_DIRECTORY)).toEqual({
      paginationOpts: { numItems: 24, cursor: "0" },
    })
    expect(directoryListArgs({ ...EMPTY_DIRECTORY, sort: "active", page: 2 })).toEqual({
      sort: "active",
      paginationOpts: { numItems: 24, cursor: "24" },
    })
  })
})

describe("events URL state", () => {
  test("defaults to one week of the list view from today, taking part off", () => {
    expect(parseEventsParams({})).toEqual({
      view: "list",
      date: undefined,
      preset: undefined,
      weeks: 1,
      q: undefined,
      categories: [],
      eventTypes: [],
      collegeKeys: [],
      org: undefined,
      takingPart: false,
      university: "all",
      event: undefined,
    })
    expect(serializeEventsState(parseEventsParams({}))).toBe("")
    expect(serializeEventsState(EMPTY_EVENTS)).toBe("")
  })

  test("round-trips view, anchor, preset, weeks, filters and the open event", () => {
    const event = `evt-${"a".repeat(40)}`
    const url = `?view=month&date=2026-10-08&preset=weekend&weeks=3&q=jazz&cat=music&type=performance,social&org=cu-jazz&external=show&event=${event}`
    const state = parseEventsParams(Object.fromEntries(new URLSearchParams(url)))
    expect(state.view).toBe("month")
    expect(state.preset).toBe("weekend")
    expect(state.weeks).toBe(3)
    expect(state.eventTypes).toEqual(["social", "performance"])
    expect(serializeEventsState(state)).toBe(url)
    expect(eventsHref(state)).toBe(`/events${url}`)
  })

  test("rejects bad views, dates, presets, weeks, slugs and event keys", () => {
    const state = parseEventsParams({
      view: "year",
      date: "2026-02-30",
      preset: "fortnight",
      weeks: "-2",
      org: "../admin",
      event: "evt-xyz",
    })
    expect(state).toMatchObject({
      view: "list",
      date: undefined,
      preset: undefined,
      weeks: 1,
      org: undefined,
      event: undefined,
    })
    expect(parseEventsParams({ weeks: "50" }).weeks).toBe(MAX_LIST_WEEKS)
    expect(parseEventsParams({ weeks: "two" }).weeks).toBe(1)
    expect(isEventKey(`evt-${"0".repeat(40)}`)).toBe(true)
    expect(isEventKey("talk-0123")).toBe(false)
  })

  test("maps to events.list args: no text query (matched in the browser)", () => {
    const state = parseEventsParams({ org: "cu-jazz", type: "talk", q: "jazz", external: "show" })
    expect(eventListArgs(state, { from: 1, to: 2 })).toEqual({
      from: 1,
      to: 2,
      eventTypes: ["talk"],
      orgKey: "org-cu-jazz",
    })
  })

  test("events societies only take part in are left out unless asked for (D6)", () => {
    expect(parseEventsParams({ external: "anything" }).takingPart).toBe(false)
    expect(parseEventsParams({ external: "hide" }).takingPart).toBe(false)
    const shown = parseEventsParams({ external: "show" })
    expect(shown.takingPart).toBe(true)
    expect(serializeEventsState(shown)).toBe("?external=show")
    expect(eventListArgs(EMPTY_EVENTS, { from: 1, to: 2 })).toEqual({
      from: 1,
      to: 2,
      includeTakingPart: false,
    })
    expect(eventListArgs(shown, { from: 1, to: 2 })).toEqual({ from: 1, to: 2 })
  })

  test("counts the filters that are on", () => {
    expect(activeEventFilterCount(EMPTY_EVENTS)).toBe(0)
    expect(
      activeEventFilterCount(
        parseEventsParams({
          cat: "music,sport",
          type: "social",
          org: "cu-jazz",
          external: "show",
          q: "x",
        }),
      ),
    ).toBe(5)
  })

  test("the University switch: all by default, hide or only (ENG-24)", () => {
    expect(parseEventsParams({ university: "everything" }).university).toBe("all")
    expect(parseEventsParams({ university: "all" }).university).toBe("all")
    const hide = parseEventsParams({ university: "hide", cat: "music" })
    expect(hide).toMatchObject({ university: "hide", categories: ["music"] })
    expect(serializeEventsState(hide)).toBe("?cat=music&university=hide")
    expect(eventListArgs(hide, { from: 1, to: 2 })).toEqual({
      from: 1,
      to: 2,
      categories: ["music"],
      includeTakingPart: false,
      university: "hide",
    })
    expect(activeEventFilterCount(hide)).toBe(2)
    // The default sends no argument, so the query also runs against a
    // deployment that predates it.
    expect(eventListArgs(EMPTY_EVENTS, { from: 1, to: 2 })).not.toHaveProperty("university")
  })

  test("the University view drops the filters that match through organiser cards", () => {
    const only = parseEventsParams({
      university: "only",
      cat: "music",
      college: "org-trinity",
      org: "cu-jazz",
      type: "talk",
    })
    expect(only).toMatchObject({
      university: "only",
      categories: [],
      collegeKeys: [],
      org: undefined,
      eventTypes: ["talk"],
    })
    expect(serializeEventsState(only)).toBe("?type=talk&university=only")
    expect(eventListArgs(only, { from: 1, to: 2 })).toEqual({
      from: 1,
      to: 2,
      eventTypes: ["talk"],
      includeTakingPart: false,
      university: "only",
    })
    expect(activeEventFilterCount(only)).toBe(2)
  })
})

describe("events window", () => {
  const TODAY = "2026-11-01" // a Sunday

  test("the list loads one week from today, then a week per `weeks`", () => {
    const one = eventsWindow(EMPTY_EVENTS, TODAY)
    expect(one.days).toHaveLength(7)
    expect(one.shown).toEqual({ first: "2026-11-01", last: "2026-11-07" })
    expect(one.from).toBe(londonMidnight("2026-11-01"))
    expect(one.to).toBe(londonMidnight("2026-11-08"))
    const three = eventsWindow({ ...EMPTY_EVENTS, weeks: 3, date: "2026-11-05" }, TODAY)
    expect(three.days).toHaveLength(21)
    expect(three.shown).toEqual({ first: "2026-11-05", last: "2026-11-25" })
  })

  test("a preset shows its days but loads at least a week", () => {
    const today = eventsWindow({ ...EMPTY_EVENTS, preset: "today" }, TODAY)
    expect(today.preset).toBe("today")
    expect(today.shown).toEqual({ first: TODAY, last: TODAY })
    expect(today.days).toHaveLength(7)
    const term = eventsWindow({ ...EMPTY_EVENTS, preset: "term" }, TODAY, "2026-12-04")
    expect(term.shown).toEqual({ first: TODAY, last: "2026-12-04" })
    expect(term.days).toHaveLength(34)
  })

  test("a preset with no range today falls back to the default week", () => {
    const window = eventsWindow({ ...EMPTY_EVENTS, preset: "term" }, TODAY, undefined)
    expect(window.preset).toBeUndefined()
    expect(window.shown).toEqual({ first: TODAY, last: "2026-11-07" })
  })

  test("week and month views keep their grids", () => {
    const week = eventsWindow({ ...EMPTY_EVENTS, view: "week" }, TODAY)
    expect(week.days[0]).toBe("2026-10-26")
    expect(week.shown).toEqual({ first: "2026-10-26", last: "2026-11-01" })
    const month = eventsWindow({ ...EMPTY_EVENTS, view: "month", date: "2026-11-15" }, TODAY)
    expect(month.days[0]).toBe("2026-10-26")
    expect(month.days.length % 7).toBe(0)
  })
})
