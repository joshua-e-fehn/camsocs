/**
 * The talks boundary (owner decision G1, SEO audit 2026-11-02 "talks-side-door"):
 * nothing read from talks.cam (a talk's title, speakers, abstract, a
 * department's talk listing, a talks.cam URL) may appear in the server HTML,
 * the RSC payload, JSON-LD, a sitemap or a feed of any URL outside the
 * `/talks` prefix, for any user agent. robots.txt keeps AI agents out of
 * `/talks` only (lib/crawlers.ts), so anything talks-derived elsewhere would
 * be the side door the block exists to close — talks.cam's own robots.txt
 * keeps those agents out.
 *
 * Society events can come from talks.cam too: a society's talks.cam series is
 * one of its feeds (`source: "talks_cam"`, convex/ingest/orgInternal.ts), and
 * an event read from elsewhere can still point at talks.cam. Such an event:
 *  - is left out of `events.list` unless the caller asks (convex/events.ts
 *    `talksCam`), so no server render outside /talks lists it;
 *  - lives at `/talks/events/<key>`; `/events/<key>` answers 308 there
 *    (proxy.ts), so its page sits behind the /talks robots rule;
 *  - never gets JSON-LD, a sitemap entry or a place in /events.ics.
 *
 * The rule runs once, in Convex, over the stored event (`isTalksDerivedEvent`);
 * the filter, `events.locate` (the proxy's gate) and the `talksDerived` flag on
 * every projection all come from that one answer, so the pages, links and
 * feeds cannot disagree with the proxy.
 */

/** talks.cam and its subdomains (www.talks.cam.ac.uk). */
const TALKS_CAM_HOST = /^(?:[a-z0-9-]+\.)*talks\.cam\.ac\.uk$/i

/** A talks.cam URL in free text (a description that links a talk). */
const TALKS_CAM_IN_TEXT = /\btalks\.cam\.ac\.uk\b/i

/**
 * Whether `url` is on talks.cam (any scheme, any subdomain; a bare
 * `talks.cam.ac.uk/…` without a scheme too, as free-text fields hold it).
 * Judged by host, so a look-alike (`talks.cam.ac.uk.example.org`, a query
 * naming talks.cam) is not. Not a URL: false. The one predicate for both
 * the stored-event rule here and the deep guard of the directory
 * (lib/directory-talks-guard.ts).
 */
export function isTalksCamUrl(url: string | undefined | null): boolean {
  const text = url?.trim()
  if (!text || !TALKS_CAM_IN_TEXT.test(text)) return false
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    return TALKS_CAM_HOST.test(parsed.hostname.replace(/\.$/, ""))
  } catch {
    return false
  }
}

/** One field's provenance as stored (`meta[field]`): where the value and
 * each disagreeing reading came from. */
type BoundaryMeta = {
  sourceUrl?: string | null
  conflicts?: ReadonlyArray<{ sourceUrl?: string | null }> | null
}

/**
 * What the rule reads: a stored event (`Doc<"events">`), every field of it.
 * Only Convex holds all of these — a projection drops some (a list item has
 * no description or booking link; `externalUrl` goes with `takes_part` only;
 * `sourceUrl` never leaves for a mailing-list event) — so the rule runs in
 * Convex alone and its answer travels as `talksDerived` on every event
 * projection (convex/lib/projections.ts). Running it again on a projection
 * could disagree with Convex and send `/events/<k>` and `/talks/events/<k>`
 * round in a 308 loop (review of 2026-11-02).
 */
export type TalksBoundaryRecord = {
  source: string
  sourceUrl?: string | null
  externalUrl?: string | null
  bookingUrl?: string | null
  description?: string | null
  meta?: Readonly<Record<string, BoundaryMeta>>
}

/** Whether any field's value, or a reading that disagrees with it, was read
 * from talks.cam: a camdram or manual event that absorbed a talks.cam
 * duplicate carries talks.cam provenance (and maybe its text) in `meta`. */
function hasTalksCamProvenance(meta: TalksBoundaryRecord["meta"]): boolean {
  for (const entry of Object.values(meta ?? {})) {
    if (isTalksCamUrl(entry.sourceUrl)) return true
    if (entry.conflicts?.some((reading) => isTalksCamUrl(reading.sourceUrl))) return true
  }
  return false
}

/**
 * Whether a stored event is talks.cam-derived: read from a talks.cam feed, or
 * its listing, own page or booking link is on talks.cam, its description
 * links talks.cam, or any field's provenance is talks.cam. Such an event
 * stays inside `/talks`. Convex only (see `TalksBoundaryRecord`); everything
 * else reads the projection's `talksDerived`.
 */
export function isTalksDerivedEvent(event: TalksBoundaryRecord): boolean {
  return (
    event.source === "talks_cam" ||
    isTalksCamUrl(event.sourceUrl) ||
    isTalksCamUrl(event.externalUrl) ||
    isTalksCamUrl(event.bookingUrl) ||
    (event.description != null && TALKS_CAM_IN_TEXT.test(event.description)) ||
    hasTalksCamProvenance(event.meta)
  )
}

/** The page of a talks-derived society event, under the /talks prefix. */
export function talksEventPath(key: string): string {
  return `/talks/events/${key}`
}

/** What a page or link needs: the key, and Convex's verdict. */
export type BoundaryFlagged = { key: string; talksDerived: boolean }

/** An event's own page: `/events/<key>`, or `/talks/events/<key>` for a
 * talks-derived one (the old URL redirects there; linking it directly saves
 * the hop). */
export function eventPath(event: BoundaryFlagged): string {
  return event.talksDerived ? talksEventPath(event.key) : `/events/${event.key}`
}

/**
 * Where an event's page (or `.ics`) must send the reader instead of answering:
 * the talks side for a talks.cam-derived event asked for outside /talks, else
 * null. Outward only (owner decision G1 needs no more): an event of either
 * kind may be shown under /talks, so nothing is ever sent back from there.
 * The proxy reads `events.locate` fresh while the pages read Convex through
 * Next's Data Cache, and the two can disagree for a cache lifetime after an
 * event's verdict changes; two-way redirects then looped (review of the SEO
 * audit, talks-boundary-redirect-loop). The canonical URL is `eventPath`'s.
 */
export function talksBoundaryRedirect(event: BoundaryFlagged, underTalks: boolean): string | null {
  return event.talksDerived && !underTalks ? talksEventPath(event.key) : null
}

/** The `.ics` file of an event, beside its page. */
export function eventIcsPath(event: BoundaryFlagged): string {
  return `${eventPath(event)}/ics`
}
