import type { CollegeInfo } from "./colleges"
import type { OrgType } from "./vocab"

/**
 * What /colleges shows for each college, from the directory's listings
 * (`orgs.hub`): how many it lists there, and links to its student bodies,
 * JCR first, then MCR, then the boat club. Pure.
 */

type Card = { slug: string; name: string; orgType?: OrgType; collegeKeys: string[] }

const BODIES: readonly [OrgType, string][] = [
  ["jcr", "JCR"],
  ["mcr", "MCR"],
  ["college_boat_club", "Boat club"],
]

export type CollegeCard = {
  college: CollegeInfo
  count: number
  bodies: { slug: string; label: string }[]
}

export function collegeCards(
  colleges: readonly CollegeInfo[],
  cards: readonly Card[],
): CollegeCard[] {
  return colleges.map((college) => {
    const here = cards.filter((card) => card.collegeKeys.includes(college.key))
    const bodies = BODIES.flatMap(([orgType, label]) => {
      const matches = here.filter((card) => card.orgType === orgType)
      return matches.map((card) => ({
        slug: card.slug,
        label: matches.length > 1 ? `${label}: ${card.name}` : label,
      }))
    })
    return { college, count: here.length, bodies }
  })
}
