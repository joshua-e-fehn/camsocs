import { mock } from "bun:test"
import assert from "node:assert/strict"
import { getFunctionName } from "convex/server"

/**
 * The three `.ics` route handlers with the ENG-7 count, run by
 * `app/ics-routes.test.ts` in its own process (module mocks would leak into
 * the rest of the suite). Convex, the session, Next's `after()` and
 * `captureServerEvent` are stubs; the handlers and lib/ics-telemetry.ts are
 * real.
 */

const NOW = Date.UTC(2026, 10, 2, 12)
Date.now = () => NOW

const EVENT_KEY = `evt-${"a".repeat(40)}`
const TALK_KEY = `talk-${"b".repeat(20)}`

const talk = {
  key: TALK_KEY,
  title: "On Knots",
  speakers: [{ name: "A Speaker" }],
  series: null,
  departments: [{ shortName: "DPMMS", slug: "dpmms" }],
  startsAt: NOW + 86_400_000,
  endsAt: null,
  allDay: false,
  venue: null,
  online: false,
  cancelled: false,
  url: "https://talks.cam.ac.uk/talk/index/1",
  kind: "seminar",
}
const event = {
  key: EVENT_KEY,
  title: "Chess night",
  startsAt: NOW + 86_400_000,
  allDay: false,
  venueText: "The Old Library",
  cancelled: false,
  hosting: "hosts",
  organisers: [{ name: "CU Chess Club", role: "host" }],
  visibility: "public",
  source: "ics",
  sourceUrl: "https://example.org/chess",
  talksDerived: false,
}

/** What the Convex stub does: answer, or fail like an outage. */
let convexDown = false
let eventVisibility = "public"
/** Convex's talks-boundary verdict on the event (G1, lib/talks-boundary.ts). */
let eventTalksDerived = false
/** The arguments of the last `events.list` call. */
let listArgs: Record<string, unknown> | undefined
mock.module("convex/nextjs", () => ({
  fetchQuery: async (query: unknown, args?: Record<string, unknown>) => {
    if (convexDown) throw new Error("Convex unreachable")
    switch (getFunctionName(query as never)) {
      case "talks:list":
        return { page: [talk], isDone: true, continueCursor: "" }
      case "talks:search":
        return [talk]
      case "talks:get":
        return talk
      case "events:get":
        return { ...event, visibility: eventVisibility, talksDerived: eventTalksDerived }
      case "venues:get":
        return null
      case "venues:list":
        return [{ key: "ven-hall", name: "The Invented Hall", aliases: [] }]
      case "events:list":
        listArgs = args
        return [
          { ...event, venueText: undefined, venueKey: "ven-hall" },
          // Defence in depth: the feed drops these even if the list had them.
          {
            ...event,
            key: `evt-${"c".repeat(40)}`,
            title: "Invented seminar",
            source: "talks_cam",
            talksDerived: true,
          },
          {
            ...event,
            key: `evt-${"d".repeat(40)}`,
            title: "Members' drinks",
            visibility: "cam_only",
          },
        ]
      case "orgs:getBySlug":
        return { org: { name: "CU Chess Club" } }
      default:
        throw new Error(`unexpected query ${getFunctionName(query as never)}`)
    }
  },
}))
mock.module("../lib/auth-server", () => ({ getToken: async () => undefined }))

/** Tasks handed to `after()`, run by the test once the response is in hand. */
let deferred: (() => Promise<void>)[] = []
let afterThrows = false
mock.module("next/server", () => ({
  after: (task: () => Promise<void>) => {
    if (afterThrows) throw new Error("`after` was called outside a request scope")
    deferred.push(task)
  },
}))

/** Calls to `captureServerEvent`, and how it misbehaves. */
let captured: [string, unknown][] = []
let captureFails: "no" | "reject" | "throw" = "no"
mock.module("../lib/posthog-server", () => ({
  captureServerEvent: (name: string, props: unknown) => {
    captured.push([name, props])
    if (captureFails === "throw") throw new Error("sync failure")
    if (captureFails === "reject") return Promise.reject(new Error("PostHog down"))
    return Promise.resolve()
  },
}))

const talksFeed = await import("./talks.ics/route")
const eventsFeed = await import("./events.ics/route")
const eventFile = await import("./events/[key]/ics/route")
const talkFile = await import("./talks/[key]/ics/route")
const talksEventFile = await import("./talks/events/[key]/ics/route")

type Snapshot = { status: number; headers: [string, string][]; body: string }

/** Runs one request: the response as received, then the deferred work. */
async function serve(call: () => Promise<Response>) {
  deferred = []
  captured = []
  const response = await call()
  // Nothing is sent while the response is being produced.
  assert.deepEqual(captured, [])
  const snapshot: Snapshot = {
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  }
  for (const task of deferred) await task()
  return { snapshot, deferredCount: deferred.length, captured }
}

const feed =
  (query = "") =>
  () =>
    talksFeed.GET({ nextUrl: new URL(`http://localhost:3000/talks.ics${query}`) } as never)
const eventsIcs =
  (query = "") =>
  () =>
    eventsFeed.GET({ nextUrl: new URL(`http://localhost:3000/events.ics${query}`) } as never)
const eventIcs = (key: string) => () =>
  eventFile.GET({} as never, { params: Promise.resolve({ key }) })
const talkIcs = (key: string) => () =>
  talkFile.GET({} as never, { params: Promise.resolve({ key }) })
const talksEventIcs = (key: string) => () =>
  talksEventFile.GET({} as never, { params: Promise.resolve({ key }) })

const header = (s: Snapshot, name: string) => s.headers.find(([k]) => k === name)?.[1]

// --- served responses are counted, with the allow-listed properties only -----------------------

{
  const { snapshot, captured } = await serve(feed("?dept=dpmms&kind=seminar"))
  assert.equal(snapshot.status, 200)
  assert.equal(
    header(snapshot, "cache-control"),
    "public, s-maxage=3600, stale-while-revalidate=86400",
  )
  assert.match(snapshot.body, /^BEGIN:VCALENDAR/)
  assert.deepEqual(captured, [["ics_feed_fetched", { feed: "talks" }]])
}
{
  // A search feed: the free-text `q` never goes with the count.
  const { snapshot, captured } = await serve(feed("?q=jane+doe"))
  assert.equal(snapshot.status, 200)
  assert.deepEqual(captured, [["ics_feed_fetched", { feed: "talks" }]])
}
{
  const { snapshot, captured } = await serve(eventIcs(EVENT_KEY))
  assert.equal(snapshot.status, 200)
  assert.equal(
    header(snapshot, "cache-control"),
    "public, s-maxage=3600, stale-while-revalidate=86400",
  )
  assert.deepEqual(captured, [["ics_feed_fetched", { feed: "event", key: EVENT_KEY }]])
}
{
  eventVisibility = "cam_only"
  const { snapshot, captured } = await serve(eventIcs(EVENT_KEY))
  eventVisibility = "public"
  assert.equal(header(snapshot, "cache-control"), "private, no-store")
  assert.deepEqual(captured, [["ics_feed_fetched", { feed: "event", key: EVENT_KEY }]])
}
{
  const { snapshot, captured } = await serve(talkIcs(TALK_KEY))
  assert.equal(snapshot.status, 200)
  assert.equal(header(snapshot, "content-disposition"), 'attachment; filename="on-knots.ics"')
  assert.deepEqual(captured, [["ics_feed_fetched", { feed: "talk", key: TALK_KEY }]])
}

{
  // The events feed: public, not talks.cam-derived, venues named by key.
  const { snapshot, captured } = await serve(eventsIcs("?org=chess"))
  assert.equal(snapshot.status, 200)
  assert.equal(
    header(snapshot, "cache-control"),
    "public, s-maxage=3600, stale-while-revalidate=86400",
  )
  const unfolded = snapshot.body.replace(/\r\n /g, "")
  assert.ok(unfolded.includes("X-WR-CALNAME:CU Chess Club · camsocs"))
  assert.ok(unfolded.includes("LOCATION:The Invented Hall"))
  assert.ok(unfolded.includes(`URL:https://camsocs.uk/events/${EVENT_KEY}`))
  assert.ok(!unfolded.includes("Invented seminar"))
  assert.ok(!unfolded.includes("Members' drinks"))
  assert.deepEqual(captured, [["ics_feed_fetched", { feed: "events" }]])
  // The whole-site feed: every public event, the University's own listings
  // (ENG-24) too, as the calendar's default; named for that, not "society".
  const all = await serve(eventsIcs())
  assert.equal(all.snapshot.status, 200)
  assert.ok(all.snapshot.body.includes("X-WR-CALNAME:Cambridge events · camsocs\r\n"))
  assert.equal(listArgs?.university, undefined)
  assert.equal(listArgs?.orgKey, undefined)
  const bad = await serve(eventsIcs("?org=Not_A_Slug"))
  assert.equal(bad.snapshot.status, 400)
  assert.equal(bad.deferredCount, 0)
}

// --- the talks boundary (G1): a talks.cam-derived file under /talks only, a 308 (not counted) there

{
  eventTalksDerived = true
  const across = await serve(eventIcs(EVENT_KEY))
  assert.equal(across.snapshot.status, 308)
  // Site-relative: a preview or local deployment stays on its own host.
  assert.equal(header(across.snapshot, "location"), `/talks/events/${EVENT_KEY}/ics`)
  assert.equal(across.snapshot.body, "")
  assert.equal(across.deferredCount, 0)
  const served = await serve(talksEventIcs(EVENT_KEY))
  assert.equal(served.snapshot.status, 200)
  // RFC 5545 folds long lines; unfold before reading the URL.
  const unfolded = served.snapshot.body.replace(/\r\n /g, "")
  assert.ok(unfolded.includes(`URL:https://camsocs.uk/talks/events/${EVENT_KEY}\r\n`))
  assert.deepEqual(served.captured, [["ics_feed_fetched", { feed: "event", key: EVENT_KEY }]])
  // Never back (talks-boundary-redirect-loop): any other event's file is
  // served under /talks too, its URL the event's own page.
  eventTalksDerived = false
  const kept = await serve(talksEventIcs(EVENT_KEY))
  assert.equal(kept.snapshot.status, 200)
  assert.ok(
    kept.snapshot.body
      .replace(/\r\n /g, "")
      .includes(`URL:https://camsocs.uk/events/${EVENT_KEY}\r\n`),
  )
}

// --- refusals and failures are not counted ------------------------------------------------------

for (const [call, status] of [
  [feed("?kind=nonsense"), 400],
  [eventIcs("jane doe"), 404],
  [talkIcs("talk-xyz"), 404],
] as const) {
  const { snapshot, deferredCount } = await serve(call)
  assert.equal(snapshot.status, status)
  assert.equal(deferredCount, 0)
}
convexDown = true
for (const call of [feed(), eventIcs(EVENT_KEY), talkIcs(TALK_KEY)]) {
  const { snapshot, deferredCount } = await serve(call)
  assert.equal(snapshot.status, 503)
  assert.equal(deferredCount, 0)
}
convexDown = false

// --- the count never changes the response, whatever goes wrong ----------------------------------

for (const call of [feed("?dept=dpmms"), eventIcs(EVENT_KEY), talkIcs(TALK_KEY)]) {
  const baseline = (await serve(call)).snapshot
  for (const mode of ["reject", "throw"] as const) {
    captureFails = mode
    const { snapshot, captured } = await serve(call)
    assert.deepEqual(snapshot, baseline)
    assert.equal(captured.length, 1)
  }
  captureFails = "no"
  afterThrows = true
  const { snapshot, deferredCount } = await serve(call)
  afterThrows = false
  assert.deepEqual(snapshot, baseline)
  assert.equal(deferredCount, 0)
}
