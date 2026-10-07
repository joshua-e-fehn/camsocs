import type { NeedOfferItem } from "../vocab"

/**
 * "Who could meet whom": pairs of organisations whose needs and offers
 * complement each other (PLAN §2.4). Pure; convex/broker/graph.ts feeds it
 * the broker profiles, the organisations' categories and the `sponsors`
 * edges.
 *
 * Two kinds of match:
 *  - **offer**: A needs X, B offers something that meets X (`MEETS`), e.g.
 *    needs speakers ↔ offers expertise;
 *  - **past sponsor**: A needs sponsorship or funding, and B has sponsored a
 *    society that shares a category with A.
 *
 * Rejected entries never match. A confirmed need or offer counts for more than
 * an inferred one, as does sharing categories. The score only orders the list;
 * it is not a probability.
 */

/** For each need, the offers that meet it. */
export const MEETS: Record<NeedOfferItem, readonly NeedOfferItem[]> = {
  sponsorship: ["sponsorship", "funding"],
  funding: ["funding", "sponsorship"],
  speakers: ["speakers", "expertise"],
  expertise: ["expertise", "speakers", "mentoring"],
  mentoring: ["mentoring", "expertise"],
  co_hosting: ["co_hosting"],
  venue: ["venue"],
  members: ["members", "media_coverage"],
  volunteers: ["volunteers", "members"],
  media_coverage: ["media_coverage"],
  equipment: ["equipment"],
  careers_access: ["careers_access"],
}

type Entry = { item: NeedOfferItem; status: "inferred" | "confirmed" | "rejected" }

export type MatchProfile = { orgKey: string; needs: readonly Entry[]; offers: readonly Entry[] }
export type MatchOrg = { key: string; name: string; categories: readonly string[] }
/** `fromKey` sponsors `toKey`. */
export type SponsorEdge = { fromKey: string; toKey: string }

export type Match = {
  needKey: string
  needName: string
  offerKey: string
  offerName: string
  /** What A needs. */
  need: NeedOfferItem
  kind: "offer" | "past_sponsor"
  /** For `offer`: what B offers. */
  offer?: NeedOfferItem
  /** For `past_sponsor`: the society B sponsored. */
  sponsoredKey?: string
  sponsoredName?: string
  sharedCategories: string[]
  score: number
}

function shared(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  if (!a || !b) return []
  const set = new Set(a)
  return [...new Set(b.filter((item) => set.has(item)))]
}

const live = (entries: readonly Entry[]) => entries.filter((entry) => entry.status !== "rejected")

export function complementaryMatches(
  profiles: readonly MatchProfile[],
  orgs: ReadonlyMap<string, MatchOrg>,
  sponsorEdges: readonly SponsorEdge[],
  limit = 200,
): Match[] {
  const best = new Map<string, Match>()
  const keep = (match: Match) => {
    const id = `${match.needKey}|${match.offerKey}|${match.need}`
    const previous = best.get(id)
    if (!previous || previous.score < match.score) best.set(id, match)
  }

  // Who offers each item.
  const offerers = new Map<NeedOfferItem, { orgKey: string; confirmed: boolean }[]>()
  for (const profile of profiles) {
    for (const offer of live(profile.offers)) {
      const list = offerers.get(offer.item) ?? []
      list.push({ orgKey: profile.orgKey, confirmed: offer.status === "confirmed" })
      offerers.set(offer.item, list)
    }
  }

  for (const profile of profiles) {
    const needer = orgs.get(profile.orgKey)
    if (!needer) continue
    for (const need of live(profile.needs)) {
      const needBonus = need.status === "confirmed" ? 1 : 0
      for (const offerItem of MEETS[need.item]) {
        for (const offerer of offerers.get(offerItem) ?? []) {
          if (offerer.orgKey === profile.orgKey) continue
          const other = orgs.get(offerer.orgKey)
          if (!other) continue
          const common = shared(needer.categories, other.categories)
          keep({
            needKey: needer.key,
            needName: needer.name,
            offerKey: other.key,
            offerName: other.name,
            need: need.item,
            kind: "offer",
            offer: offerItem,
            sharedCategories: common,
            score:
              1 +
              needBonus +
              (offerer.confirmed ? 1 : 0) +
              (offerItem === need.item ? 0.5 : 0) +
              Math.min(common.length, 3) * 0.5,
          })
        }
      }

      if (need.item !== "sponsorship" && need.item !== "funding") continue
      for (const edge of sponsorEdges) {
        if (edge.fromKey === profile.orgKey || edge.toKey === profile.orgKey) continue
        const sponsor = orgs.get(edge.fromKey)
        const sponsored = orgs.get(edge.toKey)
        if (!sponsor || !sponsored) continue
        const common = shared(needer.categories, sponsored.categories)
        if (common.length === 0) continue
        keep({
          needKey: needer.key,
          needName: needer.name,
          offerKey: sponsor.key,
          offerName: sponsor.name,
          need: need.item,
          kind: "past_sponsor",
          sponsoredKey: sponsored.key,
          sponsoredName: sponsored.name,
          sharedCategories: common,
          score: 1.5 + needBonus + Math.min(common.length, 3) * 0.5,
        })
      }
    }
  }

  return [...best.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.needName.localeCompare(b.needName, "en") ||
        a.offerName.localeCompare(b.offerName, "en"),
    )
    .slice(0, limit)
}
