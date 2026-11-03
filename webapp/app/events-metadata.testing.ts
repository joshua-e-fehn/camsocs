import { mock } from "bun:test"
import assert from "node:assert/strict"
import { getFunctionName } from "convex/server"
import { convexToJson, type Value } from "convex/values"

/**
 * The /events page's metadata, run by `app/events-metadata.test.ts` in its
 * own process (module mocks would leak into the rest of the suite): one
 * society's calendar is indexable only while it lists an event and its
 * profile is not thin, and an empty one keeps its own canonical (SEO
 * re-check 2026-11-03, events-param-urls). Convex is a stub with invented
 * societies; the page and lib/url-state.ts are real.
 */

const reads: { name: string; args: Record<string, unknown> }[] = []

/** A synthetic `orgs.getBySlug` page: what the metadata reads of it. */
function orgPage(slug: string, fields: { description?: string }, hasPublicEvents: boolean) {
  return {
    org: { key: `org-${slug}`, slug, name: `Invented ${slug}`, ...fields },
    teams: [],
    sessions: [],
    events: [],
    relationships: [],
    hasPublicEvents,
  }
}

const ORGS: Record<string, unknown> = {
  "invented-busy": orgPage("invented-busy", { description: "We meet." }, true),
  "invented-quiet": orgPage("invented-quiet", { description: "We meet." }, false),
  "invented-thin": orgPage("invented-thin", {}, false),
}

function result(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "orgs:getBySlug":
      return ORGS[args.slug as string] ?? null
    case "events:list":
      return args.orgKey === "org-invented-busy"
        ? [{ key: `evt-${"b".repeat(40)}`, title: "Invented open night" }]
        : []
    case "termDates:list":
      return []
    default:
      throw new Error(`unexpected query ${name}`)
  }
}

async function publicPreload(query: unknown, args: Record<string, unknown>) {
  const name = getFunctionName(query as never)
  reads.push({ name, args })
  return {
    _name: name,
    _argsJSON: convexToJson(args as Value),
    _valueJSON: convexToJson(result(name, args) as Value),
  }
}

mock.module("@/lib/public-data", () => ({
  PUBLIC_DATA_REVALIDATE: 300,
  publicPreload,
  publicQuery: async (query: unknown, args: Record<string, unknown>) => {
    await publicPreload(query, args)
    return result(getFunctionName(query as never), args)
  },
}))

const { generateMetadata } = await import("./(site)/events/page")
const metadata = (params: Record<string, string>) =>
  generateMetadata({ searchParams: Promise.resolve(params) })
const listReads = () => reads.filter((read) => read.name === "events:list").length

{
  const busy = await metadata({ org: "invented-busy" })
  assert.equal(busy.robots, undefined)
  assert.match(String(busy.alternates?.canonical), /\/events\?org=invented-busy$/)
}
{
  const quiet = await metadata({ org: "invented-quiet" })
  assert.deepEqual(quiet.robots, { index: false, follow: true })
  // Its own canonical, not its profile's.
  assert.match(String(quiet.alternates?.canonical), /\/events\?org=invented-quiet$/)
}
{
  const thin = await metadata({ org: "invented-thin" })
  assert.deepEqual(thin.robots, { index: false, follow: true })
}
{
  const unknown = await metadata({ org: "invented-nobody" })
  assert.deepEqual(unknown.robots, { index: false, follow: true })
}
{
  const before = listReads()
  const all = await metadata({})
  assert.equal(all.robots, undefined)
  assert.match(String(all.alternates?.canonical), /\/events$/)
  // The whole calendar is indexed as is: no events read for it.
  assert.equal(listReads(), before)
}
{
  const before = listReads()
  const slice = await metadata({ org: "invented-busy", weeks: "8" })
  assert.deepEqual(slice.robots, { index: false, follow: true })
  // A slice is noindex whatever it lists: no events read for it.
  assert.equal(listReads(), before)
}
