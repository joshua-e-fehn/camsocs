import { mock } from "bun:test"
import assert from "node:assert/strict"
import { getFunctionName } from "convex/server"
import type { Metadata } from "next"

/**
 * An event page's title when another of its name starts at another time that
 * day (SEO re-check 2026-11-03, duplicate-event-titles), run by
 * `app/event-metadata.test.ts` in its own process (module mocks would leak
 * into the rest of the suite). Both routes' `generateMetadata` and
 * lib/event-page.ts `loadRepeatsThatDay` are real; Convex is a stub with
 * invented events whose `events.list` filters as the real one does (the
 * window, every word of `q` in the title, the organiser).
 */

const reads: { name: string; args: Record<string, unknown> }[] = []

type Invented = {
  key: string
  title: string
  startsAt: number
  allDay: boolean
  talksDerived: boolean
  organisers: { key: string; slug: string; name: string; role: string }[]
}

const PLAYERS = {
  key: "org-invented-players",
  slug: "invented-players",
  name: "Invented Players",
  role: "organiser",
}
const SPONSOR = {
  key: "org-invented-sponsor",
  slug: "invented-sponsor",
  name: "Invented Sponsor",
  role: "sponsor",
}

/** A synthetic `events.get` result: what the metadata reads of it. */
function invented(letter: string, fields: Partial<Invented>) {
  return {
    key: `evt-${letter.repeat(40)}`,
    // An emoji between two words: the search must still find the twin.
    title: "Invented Film🎬Night",
    startsAt: 0,
    allDay: false,
    organisers: [PLAYERS, SPONSOR],
    speakers: [],
    visibility: "public",
    eventType: "performance",
    cancelled: false,
    status: "confirmed",
    source: "website",
    sourceUrl: "https://example.org/whats-on",
    hosting: "hosts",
    talksDerived: false,
    fromUniversity: false,
    lastSeenAt: Date.UTC(2027, 3, 1),
    confidence: 1,
    meta: {},
    ...fields,
  }
}

// Saturday 15 May 2027, British Summer Time: London's day starts at 23:00 UTC
// the evening before, so a UTC window would miss the matinee's twin.
const MATINEE = invented("a", { startsAt: Date.UTC(2027, 4, 15, 13, 30) }) // 14:30 BST
const EVENING = invented("b", { startsAt: Date.UTC(2027, 4, 15, 18, 30) }) // 19:30 BST
const ALL_DAY = invented("c", {
  title: "Invented open day",
  startsAt: Date.UTC(2027, 4, 14, 23),
  allDay: true,
})
const TALK = invented("d", { title: "Invented seminar", talksDerived: true })
const EVENTS = [MATINEE, EVENING, ALL_DAY, TALK]

function result(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "events:get":
      return EVENTS.find((event) => event.key === args.key) ?? null
    case "events:list": {
      const words = String(args.q ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      return EVENTS.filter(
        (event) =>
          event.startsAt >= (args.from as number) &&
          event.startsAt < (args.to as number) &&
          words.every((word) => event.title.toLowerCase().includes(word)) &&
          (!args.orgKey || event.organisers.some((org) => org.key === args.orgKey)),
      )
    }
    default:
      throw new Error(`unexpected query ${name}`)
  }
}

mock.module("@/lib/public-data", () => ({
  PUBLIC_DATA_REVALIDATE: 300,
  publicPreload: async () => {
    throw new Error("no preloads in an event's metadata")
  },
  publicQuery: async (query: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(query as never)
    reads.push({ name, args })
    return result(name, args)
  },
}))

const events = await import("./(site)/events/[key]/page")
const talks = await import("./(site)/talks/events/[key]/page")
const params = (key: string) => ({ params: Promise.resolve({ key }) })
const titleOf = (metadata: Metadata) =>
  typeof metadata.title === "object" && metadata.title && "absolute" in metadata.title
    ? metadata.title.absolute
    : String(metadata.title)
const listReads = (from: number) => reads.slice(from).filter((read) => read.name === "events:list")

{
  const before = reads.length
  const matinee = await events.generateMetadata(params(MATINEE.key))
  assert.match(titleOf(matinee), /, 14:30$/)
  const [read, ...more] = listReads(before)
  assert.equal(more.length, 0)
  // The London day, the title's words (the emoji a gap), the first organiser.
  assert.deepEqual(read.args, {
    from: Date.UTC(2027, 4, 14, 23),
    to: Date.UTC(2027, 4, 15, 23),
    q: "Invented Film Night",
    orgKey: PLAYERS.key,
  })
  const evening = await events.generateMetadata(params(EVENING.key))
  assert.match(titleOf(evening), /, 19:30$/)
}
{
  // An all-day event never needs the time: no read.
  const before = reads.length
  const allDay = await events.generateMetadata(params(ALL_DAY.key))
  assert.doesNotMatch(titleOf(allDay), /\d\d:\d\d$/)
  assert.equal(listReads(before).length, 0)
}
{
  // A talks.cam-derived event (its page is under /talks) is not looked up.
  const before = reads.length
  await talks.generateMetadata(params(TALK.key))
  assert.equal(listReads(before).length, 0)
}
{
  // The talks route reads twins as the events route does.
  const matinee = await talks.generateMetadata(params(MATINEE.key))
  assert.match(titleOf(matinee), /, 14:30$/)
}
