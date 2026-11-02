import { describe, expect, mock, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import {
  isPrefetch,
  LISTING_SECTIONS,
  type ListingExists,
  listingPath,
  missingListing,
  missingListingKind,
} from "./missing-listing"

/**
 * The request-time 404 gate (ENG-20): which paths it checks, which it
 * answers without Convex, and that it never 404s a static route or, on a
 * failed check, a real listing.
 */

const SLUG = "amateur-dramatic-club"
const EVENT = `evt-${"0".repeat(40)}`
const TALK = `talk-${"0".repeat(20)}`

const get = (pathname: string, headers: Record<string, string> = {}) => ({
  pathname,
  method: "GET",
  headers: new Headers(headers),
})

describe("listingPath", () => {
  test("names the listing of a society, event or talk URL", () => {
    expect(listingPath(`/societies/${SLUG}`)).toEqual({
      kind: "society",
      key: SLUG,
      wellFormed: true,
    })
    expect(listingPath(`/events/${EVENT}`)).toEqual({ kind: "event", key: EVENT, wellFormed: true })
    expect(listingPath(`/talks/${TALK}`)).toEqual({ kind: "talk", key: TALK, wellFormed: true })
  })

  test("marks keys of the wrong shape, decoded as the page would see them", () => {
    expect(listingPath("/societies/Bad_Slug!")?.wellFormed).toBe(false)
    expect(listingPath("/societies/%E2%9C%93")).toEqual({
      kind: "society",
      key: "✓",
      wellFormed: false,
    })
    expect(listingPath("/societies/%E0%A4%A")?.wellFormed).toBe(false)
    expect(listingPath("/events/evt-123")?.wellFormed).toBe(false)
    expect(listingPath("/talks/nope")?.wellFormed).toBe(false)
  })

  test("ignores every other path", () => {
    for (const pathname of [
      "/",
      "/societies",
      "/events",
      "/talks",
      "/talks/departments",
      `/events/${EVENT}/ics`,
      `/talks/${TALK}/ics`,
      "/talks.ics",
      "/dashboard/organisations",
      `/society/${SLUG}`,
    ]) {
      expect(listingPath(pathname)).toBeNull()
    }
  })
})

/** Static route segments beside each section's dynamic one, in every route
 * group (`app/(site)/talks/departments`, …): the proxy runs before routing. */
function staticSiblings(section: string): string[] {
  const app = path.join(import.meta.dir, "..", "app")
  const found = new Set<string>()
  const childDirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      return []
    }
  }
  const scanSection = (dir: string) => {
    for (const { name } of childDirs(dir)) {
      if (name.startsWith("(")) scanSection(path.join(dir, name))
      else if (!/^[[_@]/.test(name)) found.add(name)
    }
  }
  const scanGroups = (dir: string) => {
    scanSection(path.join(dir, section))
    for (const { name } of childDirs(dir))
      if (name.startsWith("(")) scanGroups(path.join(dir, name))
  }
  scanGroups(app)
  return [...found].sort()
}

describe("static routes beside a listing", () => {
  for (const [section, { siblings }] of Object.entries(LISTING_SECTIONS)) {
    test(`/${section}/* static routes are exactly the ones let through`, () => {
      expect(staticSiblings(section)).toEqual([...siblings].sort())
      for (const name of siblings) expect(listingPath(`/${section}/${name}`)).toBeNull()
    })
  }
})

describe("missingListing", () => {
  const answering = (value: boolean | Error) =>
    mock<ListingExists>(async () => {
      if (value instanceof Error) throw value
      return value
    })

  test("asks Convex about a well-formed key and 404s only a missing one", async () => {
    const absent = answering(false)
    expect(await missingListing(get(`/events/${EVENT}`), absent)).toBe("event")
    expect(absent).toHaveBeenCalledWith({ kind: "event", key: EVENT, wellFormed: true })
    expect(await missingListing(get(`/talks/${TALK}`), absent)).toBe("talk")
    expect(await missingListing(get(`/societies/${SLUG}`), answering(true))).toBeNull()
  })

  test("a malformed key is missing without a Convex round trip", async () => {
    const exists = answering(true)
    expect(await missingListing(get("/societies/Bad_Slug!"), exists)).toBe("society")
    expect(await missingListing(get("/events/not-an-event"), exists)).toBe("event")
    expect(await missingListing(get("/talks/nope"), exists)).toBe("talk")
    expect(exists).not.toHaveBeenCalled()
  })

  test("lets through static routes, prefetches and other methods unchecked", async () => {
    const exists = answering(false)
    expect(await missingListing(get("/talks/departments"), exists)).toBeNull()
    expect(await missingListing(get("/societies"), exists)).toBeNull()
    const prefetch = { "next-router-prefetch": "1", rsc: "1" }
    expect(await missingListing(get(`/societies/${SLUG}`, prefetch), exists)).toBeNull()
    const post = { ...get(`/societies/${SLUG}`), method: "POST" }
    expect(await missingListing(post, exists)).toBeNull()
    expect(exists).not.toHaveBeenCalled()
    expect(await missingListing({ ...get(`/talks/${TALK}`), method: "HEAD" }, exists)).toBe("talk")
  })

  test("a failed check lets the page answer: an outage never 404s a real listing", async () => {
    const down = answering(new Error("Convex unreachable"))
    expect(await missingListing(get(`/societies/${SLUG}`), down)).toBeNull()
  })
})

describe("isPrefetch / missingListingKind", () => {
  test("recognises router and browser prefetches", () => {
    expect(isPrefetch(new Headers({ "next-router-prefetch": "1" }))).toBe(true)
    expect(isPrefetch(new Headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true)
    expect(isPrefetch(new Headers({ purpose: "prefetch" }))).toBe(true)
    expect(isPrefetch(new Headers({ rsc: "1" }))).toBe(false)
  })

  test("reads only the three kinds from the header", () => {
    expect(missingListingKind("talk")).toBe("talk")
    expect(missingListingKind("society")).toBe("society")
    expect(missingListingKind("event")).toBe("event")
    expect(missingListingKind("dashboard")).toBeNull()
    expect(missingListingKind(null)).toBeNull()
  })
})
