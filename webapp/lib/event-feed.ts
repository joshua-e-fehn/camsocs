import { formatDayShort, londonIsoDate, londonTime } from "./calendar"
import { UNIVERSITY_NAME } from "./events"
import { SITE_NAME, SITE_URL } from "./site"

/**
 * `/events.atom`: the newly listed events as an Atom 1.0 feed (event
 * indexing, 2026-11-07). Google reads an RSS or Atom feed as a sitemap and
 * fetches it more often than the full sitemap, which is why its guidance
 * pairs the two: the XML sitemap for every page, a feed for what is new
 * (Search Central, "Best practices for XML sitemaps and RSS/Atom feeds").
 * robots.txt names it beside the sitemap index, and /events advertises it as
 * its `application/atom+xml` alternate, so feed readers find it too.
 *
 * Each entry's `published` and `updated` are when the event was first stored
 * (`convex/eventFeed.ts`): a harvest never moves that date, so it never
 * claims a change that did not happen (Google trusts a feed's dates only
 * while they are accurate). The rows come already filtered to pages that may
 * be indexed: never a talks.cam-derived event (G1) or a Cambridge-only one.
 */

export const FEED_PATH = "/events.atom"
/** An hour at the edge, then the stale copy for an hour while it refreshes:
 * shorter than the sitemaps' day, since this file is what is new. */
export const FEED_CACHE = "public, s-maxage=3600, stale-while-revalidate=3600"

export const FEED_TITLE = `Newly listed Cambridge events · ${SITE_NAME}`

export type FeedEvent = {
  key: string
  title: string
  startsAt: number
  allDay: boolean
  listedAt: number
  host?: string
  fromUniversity: boolean
}

/** Characters XML 1.0 does not allow (a stray control code in a title). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

function escapeXml(text: string): string {
  return text
    .replace(NOT_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** "Sat 8 Nov 2026, 20:00 · Invented Society": when, then who. */
export function feedSummary(event: FeedEvent): string {
  const day = londonIsoDate(event.startsAt)
  const when = `${formatDayShort(day)} ${day.slice(0, 4)}${event.allDay ? "" : `, ${londonTime(event.startsAt)}`}`
  const who = event.fromUniversity ? UNIVERSITY_NAME : event.host
  return who ? `${when} · ${who}` : when
}

/** The feed document. `now` dates an empty feed; otherwise it is dated by
 * its newest entry, so an unchanged feed reads the same on every fetch. */
export function eventFeedXml(events: readonly FeedEvent[], now: number): string {
  const self = `${SITE_URL}${FEED_PATH}`
  const updated = events.length > 0 ? Math.max(...events.map((event) => event.listedAt)) : now
  const entries = events.map((event) => {
    const url = escapeXml(`${SITE_URL}/events/${event.key}`)
    return [
      "<entry>",
      `<id>${url}</id>`,
      `<title>${escapeXml(event.title)}</title>`,
      `<link rel="alternate" type="text/html" href="${url}"/>`,
      `<published>${iso(event.listedAt)}</published>`,
      `<updated>${iso(event.listedAt)}</updated>`,
      `<summary>${escapeXml(feedSummary(event))}</summary>`,
      "</entry>",
    ].join("")
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>${escapeXml(self)}</id>`,
    `<title>${escapeXml(FEED_TITLE)}</title>`,
    `<subtitle>Events added to the ${escapeXml(SITE_NAME)} calendar in the last two weeks, newest first.</subtitle>`,
    `<link rel="self" type="application/atom+xml" href="${escapeXml(self)}"/>`,
    `<link rel="alternate" type="text/html" href="${escapeXml(`${SITE_URL}/events`)}"/>`,
    `<updated>${iso(updated)}</updated>`,
    `<author><name>${escapeXml(SITE_NAME)}</name><uri>${escapeXml(SITE_URL)}</uri></author>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n")
}
