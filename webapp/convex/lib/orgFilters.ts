import { type Infer, v } from "convex/values"
import {
  ACTIVITY_TYPES,
  AUDIENCES,
  BLUE_STATUSES,
  CATEGORIES,
  GENDER_CATEGORIES,
  ORG_LEVELS,
  ORG_STATUSES,
  ORG_TYPES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { literalUnion } from "./validators"

/**
 * The directory filters (`orgs.list` / `orgs.facets`), as pure functions over
 * `orgCards` rows so they are unit-tested without a database.
 *
 * Semantics: **OR within a facet, AND across facets** — "music or theatre,
 * at university level". An absent or empty facet does not filter. `statuses`
 * defaults to everything except `archived`. Counterparts (colleges,
 * companies, offices that exist only as someone's partner) are never listed.
 *
 * Facet counts are disjunctive: the count for a value of facet F applies every
 * filter except F's own, so ticking a second category shows how many it adds.
 */

export const orgFiltersValidator = {
  q: v.optional(v.string()),
  categories: v.optional(v.array(literalUnion(CATEGORIES))),
  levels: v.optional(v.array(literalUnion(ORG_LEVELS))),
  orgTypes: v.optional(v.array(literalUnion(ORG_TYPES))),
  collegeKeys: v.optional(v.array(v.string())),
  activityTypes: v.optional(v.array(literalUnion(ACTIVITY_TYPES))),
  audiences: v.optional(v.array(literalUnion(AUDIENCES))),
  statuses: v.optional(v.array(literalUnion(ORG_STATUSES))),
  sport: v.optional(
    v.object({
      blueStatus: v.optional(v.array(literalUnion(BLUE_STATUSES))),
      beginnerFriendly: v.optional(v.boolean()),
      gender: v.optional(v.array(literalUnion(GENDER_CATEGORIES))),
    }),
  ),
}
const filtersObject = v.object(orgFiltersValidator)
export type OrgFilters = Infer<typeof filtersObject>

export const FACETS = [
  "categories",
  "levels",
  "orgTypes",
  "collegeKeys",
  "activityTypes",
  "audiences",
  "statuses",
  "blueStatus",
  "gender",
  "beginnerFriendly",
] as const
export type Facet = (typeof FACETS)[number]

type Card = Pick<
  Doc<"orgCards">,
  | "categories"
  | "level"
  | "orgType"
  | "collegeKeys"
  | "activityTypes"
  | "audiences"
  | "status"
  | "sport"
  | "beginnerFriendly"
  | "isCounterpart"
>

const DEFAULT_STATUSES = ["active", "dormant", "unknown"] as const

/** The values a card holds for each facet. */
export function facetValues(card: Card): Record<Facet, string[]> {
  return {
    categories: card.categories,
    levels: card.level ? [card.level] : [],
    orgTypes: card.orgType ? [card.orgType] : [],
    collegeKeys: card.collegeKeys,
    activityTypes: card.activityTypes,
    audiences: card.audiences,
    statuses: [card.status],
    blueStatus: card.sport?.blueStatus ? [card.sport.blueStatus] : [],
    gender: card.sport?.genderCategories ?? [],
    beginnerFriendly: card.beginnerFriendly === undefined ? [] : [String(card.beginnerFriendly)],
  }
}

/** The selected values per facet; undefined = no filter on that facet. */
export function selections(filters: OrgFilters): Record<Facet, readonly string[] | undefined> {
  const nonEmpty = (values: readonly string[] | undefined) =>
    values && values.length > 0 ? values : undefined
  return {
    categories: nonEmpty(filters.categories),
    levels: nonEmpty(filters.levels),
    orgTypes: nonEmpty(filters.orgTypes),
    collegeKeys: nonEmpty(filters.collegeKeys),
    activityTypes: nonEmpty(filters.activityTypes),
    audiences: nonEmpty(filters.audiences),
    statuses: nonEmpty(filters.statuses) ?? DEFAULT_STATUSES,
    blueStatus: nonEmpty(filters.sport?.blueStatus),
    gender: nonEmpty(filters.sport?.gender),
    beginnerFriendly:
      filters.sport?.beginnerFriendly === undefined
        ? undefined
        : [String(filters.sport.beginnerFriendly)],
  }
}

/** Whether a card passes every facet filter except `skip`. */
export function matches(
  card: Card,
  selected: Record<Facet, readonly string[] | undefined>,
  skip?: Facet,
): boolean {
  if (card.isCounterpart) return false
  const values = facetValues(card)
  for (const facet of FACETS) {
    if (facet === skip) continue
    const wanted = selected[facet]
    if (wanted && !values[facet].some((value) => wanted.includes(value))) return false
  }
  return true
}

export type FacetCounts = { total: number } & Record<Facet, Record<string, number>>

export function facetCounts(cards: readonly Card[], filters: OrgFilters): FacetCounts {
  const selected = selections(filters)
  const counts = Object.fromEntries(FACETS.map((facet) => [facet, {}])) as Record<
    Facet,
    Record<string, number>
  >
  let total = 0
  for (const card of cards) {
    if (matches(card, selected)) total++
    const values = facetValues(card)
    for (const facet of FACETS) {
      if (!matches(card, selected, facet)) continue
      for (const value of new Set(values[facet])) {
        counts[facet][value] = (counts[facet][value] ?? 0) + 1
      }
    }
  }
  return { total, ...counts }
}
