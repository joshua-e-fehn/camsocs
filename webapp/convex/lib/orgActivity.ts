import { addDays, isoDateMs, londonIsoDate, londonMidnight, startOfWeek } from "../../lib/calendar"
import { sha1Hex } from "../../lib/hash"
import type { EventHosting, EventOrganiserRole, EventVisibility } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { TermDates } from "./derived"

/**
 * How busy a listing is, for the directory's "active this term" order, its
 * cards' "4 events this term" line and the "Busy this week" shelf — as pure
 * functions over term dates and event rows, so they are unit-tested without a
 * database (convex/orgs.ts reads the rows).
 *
 * What counts: a public event the organisation organises or co-hosts. Events
 * it only takes part in (decision D6), sponsorships, cancelled, Cambridge-only
 * and members-only events and suppressed events do not — the order must be the
 * same for every visitor and never hint at what they cannot see.
 *
 * What is counted is **runs**, not rows: a show's six nights in one week are
 * one run (the same normalised title, `runKeyOf`, in the same Monday-to-Sunday
 * London week), so a theatre company with one production does not outrank a
 * society with six different events. A weekly "Jazz night" still counts once
 * a week.
 */

/** Outside term, "this term" is the next eight weeks instead. */
export const VACATION_WINDOW_DAYS = 56

export type ActivityWindow = {
  /** Epoch ms, inclusive. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  /** Whether the window is a term (Week 0 to the end of Full Term). */
  inTerm: boolean
}

/** The Thursday Week 1 starts on (lib/derived.ts `termWeekLabel`): a week
 * runs Thursday to Wednesday, from the first Thursday of Full Term. */
function firstThursday(term: TermDates): string {
  const weekday = new Date(isoDateMs(term.fullTermStart)).getUTCDay()
  return addDays(term.fullTermStart, (4 - weekday + 7) % 7)
}

/** A term's labelled weeks as ISO dates: Week 0's Thursday to the last day of
 * Full Term, inclusive. */
export function termSpan(term: TermDates): { start: string; end: string } {
  return { start: addDays(firstThursday(term), -7), end: term.fullTermEnd }
}

function termOf(terms: readonly TermDates[], today: string): TermDates | undefined {
  return terms.find((term) => {
    const span = termSpan(term)
    return today >= span.start && today <= span.end
  })
}

/** The term `now` falls in (Week 0 to the end of Full Term), else the next
 * eight weeks from the start of today (London). */
export function activityWindow(terms: readonly TermDates[], now: number): ActivityWindow {
  const today = londonIsoDate(now)
  const term = termOf(terms, today)
  if (term) {
    const span = termSpan(term)
    return {
      from: londonMidnight(span.start),
      to: londonMidnight(addDays(span.end, 1)),
      inTerm: true,
    }
  }
  return {
    from: londonMidnight(today),
    to: londonMidnight(addDays(today, VACATION_WINDOW_DAYS)),
    inTerm: false,
  }
}

/** The term week `now` falls in (Thursday to Wednesday), else the seven days
 * from the start of today (London). */
export function weekWindow(terms: readonly TermDates[], now: number): ActivityWindow {
  const today = londonIsoDate(now)
  const term = termOf(terms, today)
  if (term) {
    const week0 = termSpan(term).start
    const days = Math.floor((isoDateMs(today) - isoDateMs(week0)) / 86_400_000)
    const start = addDays(week0, days - (days % 7))
    return { from: londonMidnight(start), to: londonMidnight(addDays(start, 7)), inTerm: true }
  }
  return { from: londonMidnight(today), to: londonMidnight(addDays(today, 7)), inTerm: false }
}

/** The part of an `eventOrganisers` row the count reads. */
export type ActivityRow = {
  eventKey: string
  orgKey: string
  role: EventOrganiserRole
  visibility: EventVisibility
  hosting?: EventHosting
  startsAt: number
  /** `runKeyOf(title)`; absent on rows from before the copy (one run per event). */
  runKey?: string
  /** Absent on rows from before the copy (not cancelled, as far as we know). */
  cancelled?: boolean
}

/** The run a title belongs to: a short hash of it lower-cased, accents and
 * punctuation dropped, spaces collapsed ("Top Girls!" and "TOP GIRLS" are one
 * run). Stored on `eventOrganisers` rows, so counts never read the events. */
export function runKeyOf(title: string): string {
  const normalised = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
  return sha1Hex(normalised).slice(0, 16)
}

/** The run a row counts towards: its title's run in its London week (Monday
 * to Sunday, so a Tuesday-to-Saturday show is one run), else its event. */
export function runIdOf(row: Pick<ActivityRow, "eventKey" | "runKey" | "startsAt">): string {
  return `${row.runKey ?? row.eventKey}|${startOfWeek(londonIsoDate(row.startsAt))}`
}

/** Whether one organiser row counts as the organisation's own public event.
 * A row without `hosting` predates D6 and hosts (lib/materialise.ts). */
export function countsAsActivity(row: ActivityRow, removed: ReadonlySet<string>): boolean {
  return (
    row.role !== "sponsor" &&
    row.visibility === "public" &&
    row.hosting !== "takes_part" &&
    row.cancelled !== true &&
    !removed.has(row.eventKey)
  )
}

/** Distinct runs among one organisation's counted rows. */
export function countRuns(rows: Iterable<Pick<ActivityRow, "eventKey" | "runKey" | "startsAt">>) {
  const runs = new Set<string>()
  for (const row of rows) runs.add(runIdOf(row))
  return runs.size
}

/** The organiser rows an event stands for (organisers and co-hosts, each
 * organisation once) — the same rows `eventOrganisers` holds for it. */
export function activityRows(
  event: Pick<
    Doc<"events">,
    | "key"
    | "organiserKeys"
    | "coHostKeys"
    | "visibility"
    | "hosting"
    | "sponsorKeys"
    | "title"
    | "startsAt"
    | "cancelled"
  >,
): ActivityRow[] {
  const seen = new Set<string>()
  const rows: ActivityRow[] = []
  const runKey = runKeyOf(event.title)
  const add = (orgKey: string, role: EventOrganiserRole) => {
    if (seen.has(orgKey)) return
    seen.add(orgKey)
    rows.push({
      eventKey: event.key,
      orgKey,
      role,
      visibility: event.visibility,
      hosting: event.hosting,
      startsAt: event.startsAt,
      runKey,
      cancelled: event.cancelled,
    })
  }
  for (const key of event.organiserKeys) add(key, "organiser")
  for (const key of event.coHostKeys) add(key, "co_host")
  return rows
}

/** Counted runs per organisation (`runIdOf`), each run once per organisation. */
export function activityCounts(
  rows: Iterable<ActivityRow>,
  removed: ReadonlySet<string>,
): Map<string, number> {
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!countsAsActivity(row, removed)) continue
    const id = `${row.orgKey}|${runIdOf(row)}`
    if (seen.has(id)) continue
    seen.add(id)
    counts.set(row.orgKey, (counts.get(row.orgKey) ?? 0) + 1)
  }
  return counts
}

/** Busiest first; equal counts keep their incoming order (name or search
 * rank), so the order is stable and shareable. */
export function sortByActivity<T extends { key: string }>(
  cards: readonly T[],
  counts: ReadonlyMap<string, number>,
): T[] {
  return cards
    .map((card, index) => ({ card, index, count: counts.get(card.key) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map((entry) => entry.card)
}

// --- related listings ------------------------------------------------------------------------

type RelatedCard = Pick<
  Doc<"orgCards">,
  "key" | "nameSort" | "categories" | "collegeKeys" | "level" | "status" | "isCounterpart"
>

/**
 * How closely `card` relates to `base`: a shared college weighs most (the
 * other societies of a student's own college), then each shared category,
 * with a bonus for the same main category; the same level and an active
 * status only break ties between related cards. 0 = unrelated.
 */
export function relatedScore(base: RelatedCard, card: RelatedCard): number {
  if (card.key === base.key || card.isCounterpart || card.status === "archived") return 0
  const sharedColleges = card.collegeKeys.filter((key) => base.collegeKeys.includes(key)).length
  const sharedCategories = card.categories.filter((c) => base.categories.includes(c)).length
  if (sharedColleges === 0 && sharedCategories === 0) return 0
  let score = (sharedColleges > 0 ? 4 : 0) + 2 * Math.min(sharedCategories, 2)
  if (base.categories[0] && card.categories[0] === base.categories[0]) score += 1
  if (base.level && card.level === base.level) score += 0.5
  if (card.status === "active") score += 0.25
  return score
}

/** The `limit` listings most related to `base`, closest first, then by name. */
export function relatedCards<T extends RelatedCard>(
  base: RelatedCard,
  cards: readonly T[],
  limit: number,
): T[] {
  return cards
    .map((card) => ({ card, score: relatedScore(base, card) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.card.nameSort.localeCompare(b.card.nameSort))
    .slice(0, limit)
    .map((entry) => entry.card)
}
