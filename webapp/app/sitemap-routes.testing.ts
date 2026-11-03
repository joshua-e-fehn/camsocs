import { mock } from "bun:test"
import assert from "node:assert/strict"
import { getFunctionName } from "convex/server"

/**
 * The sitemap route handlers, run by `app/sitemap-routes.test.ts` in its own
 * process (module mocks would leak into the rest of the suite). Convex is a
 * stub; the handlers and lib/sitemap.ts are real.
 */

let convexDown = false
let pagesRead = 0
/** `orgs.sitemap` takes an offset cursor of its own; `sitemap.events` a
 * paginationOpts. */
const orgsArgs = (args: unknown) => args as { cursor?: string; numItems: number }
mock.module("convex/nextjs", () => ({
  fetchQuery: async (query: unknown, args: unknown) => {
    if (convexDown) throw new Error("Convex unreachable")
    pagesRead++
    switch (getFunctionName(query as never)) {
      case "orgs:sitemap":
        return orgsArgs(args).cursor === "2"
          ? {
              page: [
                {
                  slug: "chess",
                  kind: "listing",
                  updatedAt: Date.UTC(2026, 9, 1),
                  indexable: true,
                },
                {
                  slug: "empty",
                  kind: "listing",
                  updatedAt: Date.UTC(2026, 9, 1),
                  indexable: false,
                },
              ],
              isDone: true,
              continueCursor: "3",
            }
          : {
              page: [
                {
                  slug: "bridge",
                  kind: "listing",
                  updatedAt: Date.UTC(2026, 9, 2),
                  indexable: true,
                },
              ],
              isDone: false,
              continueCursor: "2",
            }
      case "sitemap:events":
        return {
          page: [{ key: `evt-${"a".repeat(40)}`, updatedAt: Date.UTC(2026, 10, 1) }],
          isDone: true,
          continueCursor: "",
        }
      default:
        throw new Error(`unexpected query ${getFunctionName(query as never)}`)
    }
  },
}))

const index = await import("./sitemap.xml/route")
const files = await import("./sitemaps/[file]/route")
const file = (name: string) => files.GET({} as never, { params: Promise.resolve({ file: name }) })

{
  const response = index.GET()
  assert.equal(response.status, 200)
  assert.equal(
    response.headers.get("cache-control"),
    "public, s-maxage=3600, stale-while-revalidate=86400",
  )
  assert.match(await response.text(), /<loc>https:\/\/camsocs\.uk\/sitemaps\/events\.xml<\/loc>/)
}
{
  const response = await file("societies.xml")
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /^application\/xml/)
  const body = await response.text()
  // Every page is read, in order.
  assert.ok(body.indexOf("/societies/bridge") < body.indexOf("/societies/chess"))
  assert.match(body, /<lastmod>2026-10-01T00:00:00\.000Z<\/lastmod>/)
  assert.equal(pagesRead, 2)
  // The category hubs ride along; a thin profile (G3) does not.
  assert.match(body, /<loc>https:\/\/camsocs\.uk\/categories<\/loc>/)
  assert.match(body, /<loc>https:\/\/camsocs\.uk\/categories\/science-tech<\/loc>/)
  assert.doesNotMatch(body, /\/societies\/empty/)
}
{
  const body = await (await file("events.xml")).text()
  assert.match(body, new RegExp(`/events/evt-${"a".repeat(40)}</loc><lastmod>`))
  const pages = await (await file("pages.xml")).text()
  assert.match(pages, /<loc>https:\/\/camsocs\.uk\/events<\/loc>/)
  assert.match(pages, /<loc>https:\/\/camsocs\.uk\/term-dates<\/loc>/)
  assert.doesNotMatch(pages, /\/talks\/talk-|\/talks\/events\//)
}
assert.equal((await file("talks.xml")).status, 404)
// A backend failure is a 503 that no cache keeps, never a partial file; the
// handler logs which file failed.
const logged: unknown[][] = []
console.error = (...args: unknown[]) => logged.push(args)
convexDown = true
for (const name of ["societies.xml", "events.xml"]) {
  const response = await file(name)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("cache-control"), "no-store")
}
assert.deepEqual(
  logged.map((args) => args[0]),
  ["sitemap societies.xml failed", "sitemap events.xml failed"],
)
// The static pages need no backend.
assert.equal((await file("pages.xml")).status, 200)
convexDown = false
