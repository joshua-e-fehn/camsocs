import { v } from "convex/values"
import { sha1Hex } from "../../lib/hash"
import { isHttpUrl } from "../../lib/syntax"
import { TALK_KINDS, TALK_SCHOOLS, type TalkSchool } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { speakerValidator } from "./fields"
import { carriesSuppressedName, nameHash, scrubAddresses } from "./suppressions"
import { literalUnion } from "./validators"

/**
 * The talks pillar's shared pieces (talks-redesign-spec §3–§4, decision D7):
 * the wire caps the ingest enforces, the derived fields it computes, and the
 * public projection convex/talks.ts and the `.ics` feed return.
 *
 * Talks are not claims. A talk listing is the provenance unit — one source URL
 * and one read time per talk — so a row is written whole, never field by field.
 */

/** Field caps, the server's copy of `LIMITS` in pipeline talks/model.py. */
export const TALK_LIMITS = {
  title: 500,
  series: 300,
  venue: 300,
  abstract: 4000,
  specialMessage: 1000,
  speakerName: 200,
  speakerAffiliation: 300,
  /** A canonical URL can be one; as long as `url`. */
  externalId: 2048,
  source: 200,
  url: 2048,
} as const
export const MAX_SPEAKERS = 10
/** More than any talk is co-listed by. */
export const MAX_TALK_DEPARTMENTS = 10

/** The department slug that selects talks with no department ("Other
 * series": an unmapped talks.cam series). Never a registry slug. */
export const OTHER_SERIES_SLUG = "other-series"
export const OTHER_SERIES_NAME = "Other series"

/** `talk-` + the first 20 hex digits of sha1(`sourceType:externalId`), as the
 * pipeline mints it (talks/model.py `talk_key`). */
export function talkKey(sourceType: string, externalId: string): string {
  return `talk-${sha1Hex(`${sourceType}:${externalId}`).slice(0, 20)}`
}

/** The searchable text of a talk, lower case: title, speakers and their
 * affiliations, series, venue and department short names. */
export function talkSearchText(
  talk: {
    title: string
    speakers: readonly { name: string; affiliation?: string }[]
    series?: string
    venue?: string | null
  },
  departmentShortNames: readonly string[],
): string {
  const parts = [
    talk.title,
    ...talk.speakers.flatMap((speaker) => [speaker.name, speaker.affiliation ?? ""]),
    talk.series ?? "",
    talk.venue ?? "",
    ...departmentShortNames,
  ]
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim()
}

// --- suppressions -----------------------------------------------------------------------

/** The texts of a talk a suppression reaches (everything a reader is shown
 * that a person's name or address can be in). */
export type TalkText = {
  title: string
  speakers: { name: string; affiliation?: string }[]
  series?: string
  venue?: string | null
  abstract?: string
  specialMessage?: string
}

/**
 * The texts of `talk` with the suppression list applied (convex/lib/
 * suppressions.ts): a speaker whose name was suppressed is dropped (by the
 * name's hash, whatever its case, or a suppressed name inside it, as in
 * "Prof. Anna Smith"), and every suppressed name and contact address is cut
 * out of the other texts. Talks are not claims, so this is how `name` and
 * `contact` suppressions reach them: the ingest stores what this returns (so
 * `searchText` never holds a removed name) and the public queries apply it
 * again as a backstop.
 */
export function scrubTalkText<T extends TalkText>(
  talk: T,
  contacts: ReadonlySet<string>,
  names: ReadonlySet<string>,
): T {
  if (contacts.size === 0 && names.size === 0) return talk
  const speakers = talk.speakers.filter(
    (speaker) => !names.has(nameHash(speaker.name)) && !carriesSuppressedName(speaker, names),
  )
  const texts = scrubAddresses(
    {
      title: talk.title,
      speakers,
      series: talk.series,
      venue: talk.venue,
      abstract: talk.abstract,
      specialMessage: talk.specialMessage,
    },
    contacts,
    names,
  )
  const out = { ...talk, title: texts.title, speakers: texts.speakers, venue: texts.venue }
  // Absent stays absent (a replaced row keeps no `undefined` field).
  if (talk.series !== undefined) out.series = texts.series
  if (talk.abstract !== undefined) out.abstract = texts.abstract
  if (talk.specialMessage !== undefined) out.specialMessage = texts.specialMessage
  return out
}

/** A public talk projection (a list item or a talk page) with the
 * suppression list applied: the query-side backstop for rows stored before a
 * suppression was accepted, until its walk (convex/ingest/talks.ts
 * `scrubStored`) has rewritten them. */
export function scrubTalkItem<T extends { speakers: { name: string; affiliation?: string }[] }>(
  item: T,
  contacts: ReadonlySet<string>,
  names: ReadonlySet<string>,
): T {
  if (contacts.size === 0 && names.size === 0) return item
  const speakers = item.speakers.filter((speaker) => !names.has(nameHash(speaker.name)))
  return scrubAddresses({ ...item, speakers }, contacts, names)
}

// --- public projection -------------------------------------------------------------------

export const talkDepartmentRefValidator = v.object({
  key: v.string(),
  slug: v.string(),
  shortName: v.string(),
  /** The registry's full name ("Department of Computer Science and
   * Technology"), for a talk page's JSON-LD organizer (SEO audit
   * "talk-jsonld-details"). Optional only for rows built before it. */
  name: v.optional(v.string()),
  school: literalUnion(TALK_SCHOOLS),
  /** The department's own website (the registry's), for the talk page's
   * JSON-LD `organizer.url` (Search Console, 2026-11-07). */
  website: v.optional(v.string()),
})

/** What a list, the week agenda and the `.ics` feed show of a talk. No abstract. */
export const talkListItemFields = {
  key: v.string(),
  title: v.string(),
  speakers: v.array(speakerValidator),
  series: v.union(v.string(), v.null()),
  /** Primary first. */
  departments: v.array(talkDepartmentRefValidator),
  startsAt: v.number(),
  endsAt: v.union(v.number(), v.null()),
  allDay: v.boolean(),
  venue: v.union(v.string(), v.null()),
  online: v.boolean(),
  kind: literalUnion(TALK_KINDS),
  cancelled: v.boolean(),
  url: v.string(),
}
export const talkListItemValidator = v.object(talkListItemFields)

/** One talk's page: the list item, its abstract and its provenance. */
export const talkPublicValidator = v.object({
  ...talkListItemFields,
  abstract: v.union(v.string(), v.null()),
  specialMessage: v.union(v.string(), v.null()),
  sourceUrl: v.string(),
  retrievedAt: v.number(),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
})

export type TalkDepartmentRef = {
  key: string
  slug: string
  shortName: string
  name?: string
  school: TalkSchool
  website?: string
}
export type TalkListItem = {
  key: string
  title: string
  speakers: { name: string; affiliation?: string }[]
  series: string | null
  departments: TalkDepartmentRef[]
  startsAt: number
  endsAt: number | null
  allDay: boolean
  venue: string | null
  online: boolean
  kind: Doc<"talks">["kind"]
  cancelled: boolean
  url: string
}

/** A memoised department lookup for one query: talks on a page share a few
 * departments, so each is read once. */
export function departmentCache(ctx: QueryCtx) {
  const cache = new Map<string, Promise<Doc<"departments"> | null>>()
  return (key: string): Promise<Doc<"departments"> | null> => {
    let hit = cache.get(key)
    if (!hit) {
      hit = ctx.db
        .query("departments")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique()
      cache.set(key, hit)
    }
    return hit
  }
}

/** `websites`: each department's own website too, on a talk's page only
 * (its JSON-LD organizer); a list leaves it out. */
export async function talkListItem(
  talk: Doc<"talks">,
  lookup: ReturnType<typeof departmentCache>,
  { websites = false }: { websites?: boolean } = {},
): Promise<TalkListItem> {
  const departments: TalkDepartmentRef[] = []
  for (const key of talk.departmentKeys) {
    const department = await lookup(key)
    if (department) {
      departments.push({
        key: department.key,
        slug: department.slug,
        shortName: department.shortName,
        name: department.name,
        school: department.school,
        ...(websites && isHttpUrl(department.website) ? { website: department.website } : {}),
      })
    }
  }
  return {
    key: talk.key,
    title: talk.title,
    speakers: talk.speakers,
    series: talk.series ?? null,
    departments,
    startsAt: talk.startsAt,
    endsAt: talk.endsAt,
    allDay: talk.allDay,
    venue: talk.venue,
    online: talk.online,
    kind: talk.kind,
    cancelled: talk.cancelled,
    url: talk.url,
  }
}
