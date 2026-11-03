import { mock } from "bun:test"
import assert from "node:assert/strict"
import { getFunctionName } from "convex/server"
import { convexToJson, type Value } from "convex/values"
import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

/**
 * The /events page's metadata and its ItemList JSON-LD, run by
 * `app/events-metadata.test.ts` in its own process (module mocks would leak
 * into the rest of the suite): one society's calendar is indexable only
 * while it lists an event and its profile is not thin, an empty one keeps
 * its own canonical, and only an indexable one carries the ItemList (SEO
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

/** The busy society's one event, in a couple of hours (inside any window
 * the calendar loads from today). */
const BUSY_EVENT = {
  key: `evt-${"b".repeat(40)}`,
  title: "Invented open night",
  startsAt: Date.now() + 2 * 3_600_000,
  visibility: "public",
  cancelled: false,
  talksDerived: false,
}

function result(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "orgs:getBySlug":
      return ORGS[args.slug as string] ?? null
    case "events:list":
      // As `events.list`: the organisation's events that start in the window.
      return [BUSY_EVENT].filter(
        (event) =>
          args.orgKey === "org-invented-busy" &&
          event.startsAt >= (args.from as number) &&
          event.startsAt < (args.to as number),
      )
    case "termDates:list":
    case "orgs:colleges":
      return []
    case "events:restrictedCount":
      return 0
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

const { default: EventsPage, generateMetadata } = await import("./(site)/events/page")
const metadata = (params: Record<string, string>) =>
  generateMetadata({ searchParams: Promise.resolve(params) })
const listReads = () => reads.filter((read) => read.name === "events:list").length
const listArgs = (from: number) =>
  reads
    .slice(from)
    .filter((read) => read.name === "events:list")
    .map((read) => JSON.stringify(read.args))

/** The page's JSON-LD, rendered alone: the calendar beside it is a client
 * component that needs a Convex client. */
async function pageJsonLd(params: Record<string, string>): Promise<string> {
  const page = (await EventsPage({ searchParams: Promise.resolve(params) })) as ReactElement<{
    children: ReactElement[]
  }>
  const [jsonLd] = page.props.children.filter(
    (child) => (child.type as { name?: string }).name === "ListJsonLd",
  )
  assert.ok(jsonLd, "the page has its ListJsonLd")
  return renderToStaticMarkup(jsonLd)
}

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
{
  // The metadata and the page read a society's calendar with the same
  // arguments (one React-cache key: a single read per request), so the
  // metadata's "has events" is what the page lists, and only an indexable
  // calendar carries the ItemList.
  for (const [org, listed] of [
    ["invented-busy", true],
    ["invented-quiet", false],
  ] as const) {
    const before = reads.length
    await metadata({ org })
    const metadataArgs = listArgs(before)
    const between = reads.length
    const html = await pageJsonLd({ org })
    const pageArgs = listArgs(between)
    assert.equal(metadataArgs.length, 1)
    assert.deepEqual(pageArgs, metadataArgs)
    assert.equal(html.includes('"@type":"ItemList"'), listed, org)
    assert.equal(html.includes(BUSY_EVENT.key), listed, org)
  }
  // Nothing listed outside its window: the stub answers by the dates asked.
  const later = { from: BUSY_EVENT.startsAt + 1, to: BUSY_EVENT.startsAt + 86_400_000 }
  assert.deepEqual(result("events:list", { orgKey: "org-invented-busy", ...later }), [])
}
