import type { DirectoryState } from "./url-state"
import { CATEGORY_LABELS } from "./vocab"

/** The directory's page title for a state (also set in place when the
 * filters change without a page load). */
export function directoryTitle(state: Pick<DirectoryState, "q" | "categories">): string {
  if (state.q) return `“${state.q}” — societies and clubs`
  if (state.categories.length === 1)
    return `${CATEGORY_LABELS[state.categories[0]]} societies and clubs`
  return "Societies and clubs"
}
