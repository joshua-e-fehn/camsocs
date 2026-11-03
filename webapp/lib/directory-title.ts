import { MAX_TITLE_LENGTH, TITLE_SUFFIX } from "./site"
import type { DirectoryState } from "./url-state"
import { CATEGORY_LABELS, type Category } from "./vocab"

/**
 * Page titles for the directory, its hubs and its profiles.
 *
 * Every one names Cambridge (SEO audit 2026-11-02, hub-page-titles-weak,
 * society-titles-no-cambridge): real searches are "<thing> society
 * cambridge", and a bare "Chess Club" is indistinguishable from every other
 * university's. "Cambridge" is said as a place only, never "University of
 * Cambridge …", which would read as an affiliation (AGENTS.md, DESIGN.md
 * "Never").
 */

/** Longer titles are cut in results; the suffix goes first (G2). */
export const MAX_TITLE = MAX_TITLE_LENGTH

/** The one title fitter (lib/page-metadata.ts), for the directory's callers. */
export { fitTitle } from "./page-metadata"

/** The text a `fitTitle` result shows in the browser tab. */
export function titleText(title: string | { absolute: string }): string {
  return typeof title === "string" ? `${title}${TITLE_SUFFIX}` : title.absolute
}

/** The title itself, without the suffix: for Open Graph and JSON-LD. */
export function titleBase(title: string | { absolute: string }): string {
  return typeof title === "string" ? title : title.absolute
}

/** The directory's title with nothing filtered. */
export const DIRECTORY_TITLE = "Cambridge societies & clubs: A–Z directory"

/** The directory's page title for a state (also set in place when the
 * filters change without a page load). */
export function directoryTitle(
  state: Pick<DirectoryState, "q" | "categories"> & { page?: number },
): string {
  if (state.q) return `“${state.q}” — Cambridge societies and clubs`
  if (state.categories.length === 1) return categoryHubTitle(state.categories[0])
  if (state.page && state.page > 1) return `Cambridge societies & clubs, page ${state.page}`
  return DIRECTORY_TITLE
}

/** Categories whose members call themselves clubs more than societies. */
const CLUB_CATEGORIES: ReadonlySet<Category> = new Set(["sport", "outdoors"])

/** A category hub's title and H1: "Sport & Fitness clubs in Cambridge",
 * "Music societies in Cambridge". */
export function categoryHubTitle(category: Category): string {
  const noun = CLUB_CATEGORIES.has(category) ? "clubs" : "societies"
  return `${CATEGORY_LABELS[category]} ${noun} in Cambridge`
}

/** A college hub's title and H1 (the college's own page, /societies/<slug>):
 * "Societies and clubs at Christ's College, Cambridge". */
export function collegeHubTitle(college: string): string {
  return /\bCambridge\b/.test(college)
    ? `Societies and clubs at ${college}`
    : `Societies and clubs at ${college}, Cambridge`
}
