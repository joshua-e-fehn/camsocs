import { isTalksCamUrl } from "./talks-boundary"

/**
 * The talks invariant on the society pages (owner decision G1, SEO audit
 * 2026-11-02 talks-side-door): no talks.cam-derived text or talks.cam URL
 * may reach the server HTML, flight payload or JSON-LD of any URL outside
 * `/talks`, for any user agent. talks.cam's robots.txt blocks AI agents and
 * only `/talks` carries that block on camsocs (robots.ts, every AI group), so a
 * society profile, a hub or the directory must never become a side door.
 *
 * A listing can carry such data in five ways, and this strips each:
 *  - an event read from talks.cam (`source: "talks_cam"`, or a source or
 *    external page on talks.cam): dropped from the list whole;
 *  - a URL field (a website, a social, a source, a piece of evidence) on
 *    talks.cam: an array entry holding one is dropped, an object field is
 *    removed (a SourceLine then says "private source", which is true here);
 *  - free text quoting a talks.cam link: the link is cut to its text;
 *  - a field whose shown value was read from talks.cam (its `meta` entry's
 *    `sourceUrl` is on talks.cam): the value goes too, and the entry says
 *    "not published", so text a future source copies from talks.cam cannot
 *    stay behind once its URL is cut (strings become absent, lists empty;
 *    see KEPT_FIELDS for the few that stay);
 *  - a relationship whose only evidence was a talks.cam page: dropped whole,
 *    since "co-hosted events with X" would then rest on talks.cam alone.
 *
 * Pure and deep, like `scrubAddresses` (convex/lib/suppressions.ts), so it
 * covers fields added later without a change here. Applied inside Convex by
 * `orgs.getBySlug` and the `orgs.*` card queries, so every caller is
 * covered, and again by the profile page (twice is harmless).
 */

/** Whether a listed event is talks.cam-derived (G1). An event projection
 * carries Convex's verdict, `talksDerived` (lib/talks-boundary.ts, which
 * reads every stored field); anything else is judged by what it shows: read
 * from talks.cam, or its source or external page is on it. */
export function isTalksCamEvent(event: {
  source?: string
  sourceUrl?: string
  externalUrl?: string
  talksDerived?: boolean
}): boolean {
  return (
    event.talksDerived === true ||
    event.source === "talks_cam" ||
    isTalksCamUrl(event.sourceUrl) ||
    isTalksCamUrl(event.externalUrl)
  )
}

const MARKDOWN_LINK =
  /\[([^\]]*)\]\(\s*<?(?:https?:\/\/)?(?:[a-z0-9-]+\.)*talks\.cam\.ac\.uk[^)]*\)/gi
const BARE_LINK = /<?(?:https?:\/\/)?(?:[a-z0-9-]+\.)*talks\.cam\.ac\.uk(?:[/?#][^\s<>)\]]*)?>?/gi

/** Free text with every talks.cam link cut to its text and bare talks.cam
 * URLs removed. */
export function stripTalksCamText(text: string): string {
  if (!/talks\.cam\.ac\.uk/i.test(text)) return text
  return text
    .replace(MARKDOWN_LINK, "$1")
    .replace(BARE_LINK, "")
    .replace(/[ \t]{2,}/g, " ")
}

function looksLikeEvent(item: unknown): item is { source?: string } {
  return (
    item !== null &&
    typeof item === "object" &&
    "source" in item &&
    typeof (item as { source: unknown }).source === "string" &&
    "startsAt" in item
  )
}

function holdsTalksCamUrl(item: unknown): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false
  return Object.values(item).some((value) => typeof value === "string" && isTalksCamUrl(value))
}

/**
 * Fields kept even when their `meta` names talks.cam: the identity strings
 * the public projections require (convex/lib/projections.ts, a Convex
 * validator would reject the page without them; none is read from talks.cam
 * today), the required `registrations` object (its parts are still walked)
 * and vocabulary values, which are camsocs's own words, not a source's text.
 */
const KEPT_FIELDS = new Set([
  "key",
  "slug",
  "name",
  "title",
  "status",
  "source",
  "visibility",
  "hosting",
  "eventType",
  "type",
  "orgType",
  "level",
  "platform",
  "role",
  "registrations",
])

const isRecord = (item: unknown): item is Record<string, unknown> =>
  item !== null && typeof item === "object" && !Array.isArray(item)

/** The fields of `item` whose `meta` entry names a talks.cam source. */
function fieldsReadFromTalksCam(item: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  if (!isRecord(item.meta)) return out
  for (const [field, meta] of Object.entries(item.meta)) {
    if (isRecord(meta) && typeof meta.sourceUrl === "string" && isTalksCamUrl(meta.sourceUrl)) {
      out.add(field)
    }
  }
  return out
}

/** `value` read from talks.cam, emptied: text goes, a list empties, a
 * number or flag (no text) stays. Undefined means "leave the field out". */
function emptied(value: unknown): unknown {
  if (Array.isArray(value)) return []
  return typeof value === "string" || isRecord(value) ? undefined : value
}

/** Marks an array entry to leave out (a relationship left without evidence). */
const DROP = Symbol("drop")

/** `value` without anything from talks.cam (see the module comment). */
export function withoutTalksCam<T>(value: T): T {
  const walk = (item: unknown, inList: boolean): unknown => {
    if (typeof item === "string") return stripTalksCamText(item)
    if (Array.isArray(item)) {
      return item
        .filter((entry) => !(looksLikeEvent(entry) && isTalksCamEvent(entry)))
        .filter((entry) => !holdsTalksCamUrl(entry))
        .filter((entry) => !(typeof entry === "string" && isTalksCamUrl(entry)))
        .map((entry) => walk(entry, true))
        .filter((entry) => entry !== DROP)
    }
    if (isRecord(item)) {
      const fromTalks = fieldsReadFromTalksCam(item)
      const out: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(item)) {
        if (typeof entry === "string" && isTalksCamUrl(entry)) continue
        if (fromTalks.has(name) && !KEPT_FIELDS.has(name)) {
          const left = emptied(entry)
          if (left !== undefined) out[name] = left
          continue
        }
        out[name] = walk(entry, false)
      }
      if (isRecord(out.meta)) {
        const meta = out.meta
        for (const field of fromTalks) {
          // A dotted field ("sport.sport") names part of an object.
          const [head, tail] = field.split(".")
          if (KEPT_FIELDS.has(tail === undefined ? head : tail)) continue
          if (tail !== undefined && isRecord(out[head])) {
            const part = { ...(out[head] as Record<string, unknown>) }
            const left = emptied(part[tail])
            if (left === undefined) delete part[tail]
            else part[tail] = left
            out[head] = part
          }
          meta[field] = { status: "missing", missingReason: "not_published" }
        }
      }
      // A relationship whose evidence was all talks.cam pages: nothing left
      // to rest on, so it leaves its list.
      if (
        inList &&
        Array.isArray(item.evidence) &&
        item.evidence.length > 0 &&
        Array.isArray(out.evidence) &&
        out.evidence.length === 0
      ) {
        return DROP
      }
      // A conflict whose other readings all went is no conflict (as
      // scrubAddresses does): the shown value's own status, by confidence.
      const conflict = out as { status?: string; conflicts?: unknown[]; confidence?: number }
      if (conflict.status === "conflicting" && conflict.conflicts?.length === 0) {
        conflict.status = (conflict.confidence ?? 0) < 0.75 ? "inferred" : "found"
        delete conflict.conflicts
      }
      return out
    }
    return item
  }
  return walk(value, false) as T
}
