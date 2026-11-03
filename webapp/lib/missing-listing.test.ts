import { describe, expect, mock, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  FOUND_TTL_MS,
  isPrefetch,
  LISTING_SECTIONS,
  type ListingGate,
  type ListingKind,
  type ListingLookup,
  type ListingState,
  listingGate,
  listingPath,
  rememberFound,
  withTimeout,
} from "./missing-listing"
import { talksBoundaryRedirect } from "./talks-boundary"

/**
 * The request-time 404 gate (ENG-20): which paths it checks, which it
 * answers without Convex, and that it never 404s a static route or, on a
 * failed check, a real listing — plus the talks boundary's one-way 308 from
 * /events/<key> to /talks/events/<key> (owner decision G1).
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
    expect(listingPath(`/talks/events/${EVENT}`)).toEqual({
      kind: "event",
      key: EVENT,
      wellFormed: true,
      underTalks: true,
    })
    expect(listingPath("/talks/events/evt-1")?.wellFormed).toBe(false)
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
      "/talks/events",
      `/events/${EVENT}/ics`,
      `/talks/events/${EVENT}/ics`,
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

describe("listingGate", () => {
  const answering = (value: ListingState | Error) =>
    mock<ListingLookup>(async () => {
      if (value instanceof Error) throw value
      return value
    })
  const missing = (kind: ListingKind): ListingGate => ({ action: "missing", kind })
  const next: ListingGate = { action: "next" }

  test("asks Convex about a well-formed key and 404s only a missing one", async () => {
    const absent = answering("missing")
    expect(await listingGate(get(`/events/${EVENT}`), absent)).toEqual(missing("event"))
    expect(absent).toHaveBeenCalledWith({ kind: "event", key: EVENT })
    expect(await listingGate(get(`/talks/${TALK}`), absent)).toEqual(missing("talk"))
    expect(await listingGate(get(`/talks/events/${EVENT}`), absent)).toEqual(missing("event"))
    expect(await listingGate(get(`/societies/${SLUG}`), answering("found"))).toEqual(next)
  })

  test("a talks.cam-derived event's page is under /talks: a 308 there, never back (G1)", async () => {
    expect(await listingGate(get(`/events/${EVENT}`), answering("talks"))).toEqual({
      action: "redirect",
      path: `/talks/events/${EVENT}`,
    })
    expect(await listingGate(get(`/talks/events/${EVENT}`), answering("talks"))).toEqual(next)
    // Any other event renders under /talks too (canonical /events/<key>).
    expect(await listingGate(get(`/talks/events/${EVENT}`), answering("found"))).toEqual(next)
    expect(await listingGate(get(`/events/${EVENT}`), answering("found"))).toEqual(next)
  })

  test("a fresh proxy and a stale page that disagree never loop (talks-boundary-redirect-loop)", async () => {
    // Follows redirects from `start` the way a browser would: the proxy
    // first (its verdict, `proxyState`), then the page's own fallback with
    // the page's verdict (`pageTalksDerived`), which may be a cache behind.
    async function follow(start: string, proxyState: ListingState, pageTalksDerived: boolean) {
      const visited = [start]
      let at = start
      for (let hop = 0; hop < 5; hop++) {
        const gate = await listingGate(get(at), answering(proxyState))
        const underTalks = at.startsWith("/talks/")
        const next =
          gate.action === "redirect"
            ? gate.path
            : talksBoundaryRedirect({ key: EVENT, talksDerived: pageTalksDerived }, underTalks)
        if (next === null) return visited
        visited.push(next)
        at = next
      }
      throw new Error(`redirect loop: ${visited.join(" → ")}`)
    }
    // A harvest made the event talks.cam-derived; the page's cache has not seen it.
    expect(await follow(`/events/${EVENT}`, "talks", false)).toEqual([
      `/events/${EVENT}`,
      `/talks/events/${EVENT}`,
    ])
    // The other way round: the proxy's memo is behind, the page's cache is fresh.
    expect(await follow(`/events/${EVENT}`, "found", true)).toEqual([
      `/events/${EVENT}`,
      `/talks/events/${EVENT}`,
    ])
    for (const state of ["found", "talks"] as const) {
      for (const derived of [false, true]) {
        expect(await follow(`/talks/events/${EVENT}`, state, derived)).toEqual([
          `/talks/events/${EVENT}`,
        ])
      }
    }
  })

  test("a malformed key is missing without a Convex round trip", async () => {
    const lookup = answering("found")
    expect(await listingGate(get("/societies/Bad_Slug!"), lookup)).toEqual(missing("society"))
    expect(await listingGate(get("/events/not-an-event"), lookup)).toEqual(missing("event"))
    expect(await listingGate(get("/talks/events/not-an-event"), lookup)).toEqual(missing("event"))
    expect(await listingGate(get("/talks/nope"), lookup)).toEqual(missing("talk"))
    expect(lookup).not.toHaveBeenCalled()
  })

  test("lets through static routes, prefetches and other methods unchecked", async () => {
    const lookup = answering("missing")
    expect(await listingGate(get("/talks/departments"), lookup)).toEqual(next)
    expect(await listingGate(get("/talks/events"), lookup)).toEqual(next)
    expect(await listingGate(get("/societies"), lookup)).toEqual(next)
    // Router prefetches never reach the proxy (its matcher); a browser's
    // speculative prefetch is also caught here.
    const prefetch = { "sec-purpose": "prefetch" }
    expect(await listingGate(get(`/societies/${SLUG}`, prefetch), lookup)).toEqual(next)
    const post = { ...get(`/societies/${SLUG}`), method: "POST" }
    expect(await listingGate(post, lookup)).toEqual(next)
    expect(lookup).not.toHaveBeenCalled()
    expect(await listingGate({ ...get(`/talks/${TALK}`), method: "HEAD" }, lookup)).toEqual(
      missing("talk"),
    )
  })

  test("a failed check lets the page answer: an outage never 404s a real listing", async () => {
    const down = answering(new Error("Convex unreachable"))
    expect(await listingGate(get(`/societies/${SLUG}`), down)).toEqual(next)
    expect(await listingGate(get(`/events/${EVENT}`), down)).toEqual(next)
  })
})

describe("withTimeout", () => {
  test("passes an answer through and fails a check slower than the limit", async () => {
    const listing = { kind: "society" as const, key: SLUG }
    expect(await withTimeout(async () => "found", 50)(listing)).toBe("found")
    const slow = withTimeout(
      () => new Promise<ListingState>((r) => setTimeout(() => r("missing"), 200)),
      10,
    )
    await expect(slow(listing)).rejects.toThrow("timed out")
    // …which listingGate treats like an outage: the page answers.
    expect(await listingGate(get(`/societies/${SLUG}`), slow)).toEqual({ action: "next" })
  })
})

describe("rememberFound", () => {
  const society = (key: string) => ({ kind: "society" as const, key })

  test("remembers a found listing for the TTL, never a missing one", async () => {
    let clock = 0
    const known = new Set(["a"])
    const lookup = mock<ListingLookup>(async ({ key }) => (known.has(key) ? "found" : "missing"))
    const cached = rememberFound(lookup, { ttlMs: 1000, max: 10, now: () => clock })
    expect(await cached(society("a"))).toBe("found")
    known.delete("a")
    expect(await cached(society("a"))).toBe("found")
    expect(lookup).toHaveBeenCalledTimes(1)
    clock = 1001
    expect(await cached(society("a"))).toBe("missing")
    expect(await cached(society("b"))).toBe("missing")
    known.add("b")
    expect(await cached(society("b"))).toBe("found")
    expect(lookup).toHaveBeenCalledTimes(4)
  })

  test("remembers which side of the talks boundary an event is on", async () => {
    const lookup = mock<ListingLookup>(async () => "talks")
    const cached = rememberFound(lookup, { ttlMs: 1000, max: 10, now: () => 0 })
    const event = { kind: "event" as const, key: EVENT }
    expect(await cached(event)).toBe("talks")
    expect(await cached(event)).toBe("talks")
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  test("keys by kind and drops the oldest past the cap", async () => {
    const lookup = mock<ListingLookup>(async () => "found")
    const cached = rememberFound(lookup, { ttlMs: 1000, max: 2, now: () => 0 })
    await cached(society("a"))
    await cached({ kind: "talk", key: "a" })
    await cached(society("b"))
    expect(lookup).toHaveBeenCalledTimes(3)
    await cached(society("a"))
    expect(lookup).toHaveBeenCalledTimes(4)
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

describe("isPrefetch", () => {
  test("recognises browser prefetches", () => {
    expect(isPrefetch(new Headers({ "sec-purpose": "prefetch;prerender" }))).toBe(true)
    expect(isPrefetch(new Headers({ purpose: "prefetch" }))).toBe(true)
    expect(isPrefetch(new Headers({ rsc: "1" }))).toBe(false)
  })
})

describe("FOUND_TTL_MS", () => {
  test("is as long as a public page is cached at the edge", () => {
    const layout = readFileSync(
      path.join(import.meta.dir, "..", "app", "(site)", "layout.tsx"),
      "utf8",
    )
    const revalidate = /export const revalidate = (\d+)/.exec(layout)?.[1]
    expect(revalidate).toBeDefined()
    expect(FOUND_TTL_MS).toBe(Number(revalidate) * 1000)
  })
})
