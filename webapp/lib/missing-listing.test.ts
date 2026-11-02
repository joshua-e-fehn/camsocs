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
  rememberFound,
  withTimeout,
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

/** File conventions that give a section a static URL of their own, e.g.
 * `societies/opengraph-image.tsx` serves `/societies/opengraph-image`. */
const ROUTE_FILE =
  /^(opengraph-image|twitter-image|icon|apple-icon|sitemap|manifest|robots|route)(\d*)\.\w+$/

/** Static route segments beside each section's dynamic one, in every route
 * group (`app/(site)/talks/departments`, …), and URLs a metadata or route
 * file in the section itself serves: the proxy runs before routing. */
function staticSiblings(section: string): string[] {
  const app = path.join(import.meta.dir, "..", "app")
  const found = new Set<string>()
  const entries = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  const childDirs = (dir: string) => entries(dir).filter((entry) => entry.isDirectory())
  const scanSection = (dir: string) => {
    for (const entry of entries(dir)) {
      const { name } = entry
      if (entry.isDirectory()) {
        if (name.startsWith("(")) scanSection(path.join(dir, name))
        else if (!/^[[_@]/.test(name)) found.add(name)
      } else {
        const file = ROUTE_FILE.exec(name)
        // `route.ts` serves the section's own URL, not a sibling of [key].
        if (file && file[1] !== "route") found.add(`${file[1]}${file[2]}`)
      }
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
    // Router prefetches never reach the proxy (its matcher); a browser's
    // speculative prefetch is also caught here.
    const prefetch = { "sec-purpose": "prefetch" }
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

describe("withTimeout", () => {
  test("passes an answer through and fails a check slower than the limit", async () => {
    const listing = { kind: "society" as const, key: SLUG }
    expect(await withTimeout(async () => true, 50)(listing)).toBe(true)
    const slow = withTimeout(() => new Promise<boolean>((r) => setTimeout(() => r(false), 200)), 10)
    await expect(slow(listing)).rejects.toThrow("timed out")
    // …which missingListing treats like an outage: the page answers.
    expect(await missingListing(get(`/societies/${SLUG}`), slow)).toBeNull()
  })
})

describe("rememberFound", () => {
  const society = (key: string) => ({ kind: "society" as const, key })

  test("remembers a found listing for the TTL, never a missing one", async () => {
    let clock = 0
    const known = new Set(["a"])
    const exists = mock<ListingExists>(async ({ key }) => known.has(key))
    const cached = rememberFound(exists, { ttlMs: 1000, max: 10, now: () => clock })
    expect(await cached(society("a"))).toBe(true)
    known.delete("a")
    expect(await cached(society("a"))).toBe(true)
    expect(exists).toHaveBeenCalledTimes(1)
    clock = 1001
    expect(await cached(society("a"))).toBe(false)
    expect(await cached(society("b"))).toBe(false)
    known.add("b")
    expect(await cached(society("b"))).toBe(true)
    expect(exists).toHaveBeenCalledTimes(4)
  })

  test("keys by kind and drops the oldest past the cap", async () => {
    const exists = mock<ListingExists>(async () => true)
    const cached = rememberFound(exists, { ttlMs: 1000, max: 2, now: () => 0 })
    await cached(society("a"))
    await cached({ kind: "talk", key: "a" })
    await cached(society("b"))
    expect(exists).toHaveBeenCalledTimes(3)
    await cached(society("a"))
    expect(exists).toHaveBeenCalledTimes(4)
  })

  test("a failed check is not remembered", async () => {
    const cached = rememberFound(
      async () => {
        throw new Error("down")
      },
      { ttlMs: 1000, max: 2 },
    )
    await expect(cached(society("a"))).rejects.toThrow("down")
  })
})

describe("isPrefetch / missingListingKind", () => {
  test("recognises browser prefetches", () => {
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
