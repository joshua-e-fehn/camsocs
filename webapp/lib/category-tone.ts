import type { Category } from "./vocab"

/**
 * The tint family of each category, for monogram tiles and category tiles
 * (components/molecules/org-monogram.tsx draws them from the design tokens,
 * never raw colours). Seven families over sixteen categories, chosen so that
 * neighbours in a list rarely share one: sage (the societies pillar), teal
 * (sport, the river), indigo (study and belief), plum (music and the arts),
 * brick (stage and debate), gilt (food, games, the wider world) and neutral.
 */
export const CATEGORY_TONES = [
  "sage",
  "teal",
  "indigo",
  "plum",
  "brick",
  "gilt",
  "neutral",
] as const
export type CategoryTone = (typeof CATEGORY_TONES)[number]

export const CATEGORY_TONE: Record<Category, CategoryTone> = {
  academic: "indigo",
  science_tech: "teal",
  careers_professional: "neutral",
  entrepreneurship: "gilt",
  arts_creative: "plum",
  music: "plum",
  theatre_film_dance: "brick",
  media_publishing: "neutral",
  cultural_international: "gilt",
  faith: "indigo",
  politics_debate: "brick",
  causes_volunteering: "sage",
  identity_wellbeing: "plum",
  sport: "teal",
  outdoors: "sage",
  hobbies_games: "gilt",
}

/** A listing's tone: its first category's, else neutral. */
export function categoryTone(categories: readonly Category[] | Category | undefined): CategoryTone {
  const first = Array.isArray(categories) ? categories[0] : categories
  return first ? CATEGORY_TONE[first as Category] : "neutral"
}
