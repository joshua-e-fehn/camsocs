/**
 * Ranks and badges of the formal tracker (/formals/tracker, ENG-272): pure
 * functions over how many colleges a member has ticked, and which. Keys are
 * the colleges' organisation keys (lib/data/colleges.json `key`).
 */

export const TOTAL_COLLEGES = 31

export type FormalRank = { min: number; title: string }

/** From nobody to all 31, in order. */
export const FORMAL_RANKS: readonly FormalRank[] = [
  { min: 0, title: "Hall-curious" },
  { min: 1, title: "First sitting" },
  { min: 3, title: "Gown borrower" },
  { min: 6, title: "Swap regular" },
  { min: 10, title: "Formal fiend" },
  { min: 16, title: "Grand tourist" },
  { min: 24, title: "Nearly there" },
  { min: 31, title: "Full house" },
]

/** The rank a member holds with `colleges` ticked. */
export function rankFor(colleges: number): FormalRank {
  let rank = FORMAL_RANKS[0]
  for (const candidate of FORMAL_RANKS) if (colleges >= candidate.min) rank = candidate
  return rank
}

/** The next rank and how many colleges it needs, or null at Full house. */
export function nextRank(colleges: number): { rank: FormalRank; needed: number } | null {
  const rank = FORMAL_RANKS.find((candidate) => candidate.min > colleges)
  return rank ? { rank, needed: rank.min - colleges } : null
}

/**
 * The five richest colleges by endowment, for the "Old money" badge: the top
 * five of the 2024-25 ranking on /colleges/wealth (lib/data/college-wealth.json,
 * balance-sheet investments at market value). lib/college-wealth.test.ts holds
 * this list to that data.
 */
export const OLD_MONEY_COLLEGE_KEYS: readonly string[] = [
  "org-trinity-college",
  "org-st-johns-college",
  "org-trinity-hall",
  "org-emmanuel-college",
  "org-gonville-and-caius-college",
]

export type FormalBadge = {
  id: string
  title: string
  /** One line on what earns it. */
  description: string
  collegeKeys: readonly string[]
}

export const FORMAL_BADGES: readonly FormalBadge[] = [
  {
    id: "the-backs",
    title: "The Backs",
    description:
      "Every college along the river: Queens’, King’s, Clare, Trinity Hall, Trinity, St John’s and Magdalene.",
    collegeKeys: [
      "org-queens-college",
      "org-kings-college",
      "org-clare-college",
      "org-trinity-hall",
      "org-trinity-college",
      "org-st-johns-college",
      "org-magdalene-college",
    ],
  },
  {
    id: "up-the-hill",
    title: "Up the Hill",
    description: "Churchill, Fitzwilliam, Murray Edwards, St Edmund’s and Lucy Cavendish.",
    collegeKeys: [
      "org-churchill-college",
      "org-fitzwilliam-college",
      "org-murray-edwards-college",
      "org-st-edmunds-college",
      "org-lucy-cavendish-college",
    ],
  },
  {
    id: "girton-trek",
    title: "Girton trek",
    description: "A formal at Girton, two and a half miles out.",
    collegeKeys: ["org-girton-college"],
  },
  {
    id: "grad-colleges",
    title: "Grad colleges",
    description: "The graduate colleges’ halls: Clare Hall, Darwin and Wolfson.",
    collegeKeys: ["org-clare-hall", "org-darwin-college", "org-wolfson-college"],
  },
  {
    id: "old-money",
    title: "Old money",
    description: "The five richest colleges by endowment.",
    collegeKeys: OLD_MONEY_COLLEGE_KEYS,
  },
]

export type BadgeProgress = { badge: FormalBadge; have: number; total: number; earned: boolean }

/** Each badge with how many of its colleges are ticked. */
export function badgeProgress(ticked: ReadonlySet<string>): BadgeProgress[] {
  return FORMAL_BADGES.map((badge) => {
    const have = badge.collegeKeys.filter((key) => ticked.has(key)).length
    const total = badge.collegeKeys.length
    return { badge, have, total, earned: have === total }
  })
}

/** Whole-number percentage of the colleges ticked. */
export function percentDone(colleges: number): number {
  return Math.round((Math.min(colleges, TOTAL_COLLEGES) / TOTAL_COLLEGES) * 100)
}
