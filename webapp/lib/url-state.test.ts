import { describe, expect, test } from "bun:test"
import {
  activeDirectoryFilterCount,
  directoryCursor,
  directoryFilters,
  EMPTY_DIRECTORY,
  eventListArgs,
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

describe("events URL state", () => {
  test("defaults to the list view anchored on today", () => {
    expect(parseEventsParams({})).toEqual({
      view: "list",
      date: undefined,
      q: undefined,
      categories: [],
      eventTypes: [],
      collegeKeys: [],
      org: undefined,
      takingPart: true,
      event: undefined,
    })
    expect(serializeEventsState(parseEventsParams({}))).toBe("")
  })

  test("round-trips view, anchor, filters and the open event", () => {
    const event = `evt-${"a".repeat(40)}`
    const url = `?view=month&date=2026-10-08&q=jazz&cat=music&type=performance,social&org=cu-jazz&external=hide&event=${event}`
    const state = parseEventsParams(Object.fromEntries(new URLSearchParams(url)))
    expect(state.view).toBe("month")
    expect(state.eventTypes).toEqual(["social", "performance"])
    expect(serializeEventsState(state)).toBe(url)
  })

  test("rejects bad views, dates, slugs and event keys", () => {
    const state = parseEventsParams({
      view: "year",
      date: "2026-02-30",
      org: "../admin",
      event: "evt-xyz",
    })
    expect(state).toMatchObject({ view: "list", date: undefined, org: undefined, event: undefined })
  })

  test("maps to events.list args", () => {
    const state = parseEventsParams({ org: "cu-jazz", type: "talk" })
    expect(eventListArgs(state, { from: 1, to: 2 })).toEqual({
      from: 1,
      to: 2,
      eventTypes: ["talk"],
      orgKey: "org-cu-jazz",
    })
  })

  test("events societies only take part in are listed unless hidden (D6)", () => {
    expect(parseEventsParams({ external: "anything" }).takingPart).toBe(true)
    const hidden = parseEventsParams({ external: "hide" })
    expect(hidden.takingPart).toBe(false)
    expect(eventListArgs(hidden, { from: 1, to: 2 })).toEqual({
      from: 1,
      to: 2,
      includeTakingPart: false,
    })
    expect(serializeEventsState(hidden)).toBe("?external=hide")
  })
})
