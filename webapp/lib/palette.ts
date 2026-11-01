/**
 * Opening the ⌘K palette (components/organisms/command-palette.tsx) from
 * anywhere — the header's search pill, the home hero's "All" scope — without
 * a shared React context: a window event the palette listens for.
 */

export const PALETTE_SCOPES = ["all", "societies", "events", "talks", "colleges"] as const
export type PaletteScope = (typeof PALETTE_SCOPES)[number]

export const PALETTE_EVENT = "camsocs:palette"

export type PaletteRequest = { query?: string; scope?: PaletteScope }

/** Opens the palette, optionally with a query typed in and a scope chosen. */
export function openPalette(request: PaletteRequest = {}): void {
  window.dispatchEvent(new CustomEvent<PaletteRequest>(PALETTE_EVENT, { detail: request }))
}

/** Whether a key press is aimed at a text field (so `/` types a slash). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

/** Case- and accent-insensitive "every word appears" match, for the
 * palette's local groups (colleges, categories, pages). */
export function matchesWords(text: string, query: string): boolean {
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
  const haystack = fold(text)
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

const RECENT_KEY = "camsocs:recent-searches"
const RECENT_MAX = 5

/** The last few palette searches, newest first; empty when storage is
 * unavailable (private windows, blocked site data). */
export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

/** Remembers `query` at the front of the recent list (a no-op without storage). */
export function rememberRecent(query: string): string[] {
  const text = query.trim().slice(0, 100)
  if (!text) return readRecent()
  const next = [
    text,
    ...readRecent().filter((item) => item.toLowerCase() !== text.toLowerCase()),
  ].slice(0, RECENT_MAX)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Storage blocked: recents are a convenience only.
  }
  return next
}

/** Forgets one recent search. */
export function forgetRecent(query: string): string[] {
  const next = readRecent().filter((item) => item !== query)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // As above.
  }
  return next
}

// --- the palette's rows ---------------------------------------------------------------------

const RECENT_PREFIX = "recent:"

/** The cmdk value of a recent-search row. */
export function recentValue(query: string): string {
  return `${RECENT_PREFIX}${query}`
}

/** The search a recent-search row stands for, or undefined for any other row. */
export function recentOf(value: string): string | undefined {
  return value.startsWith(RECENT_PREFIX) ? value.slice(RECENT_PREFIX.length) : undefined
}

/** Whether a key press asks to forget the highlighted recent search: Delete,
 * or Shift+Backspace (a Mac keyboard has no Delete key), as in a browser's
 * address bar. Plain Backspace edits the query instead. */
export function isForgetKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "Delete" || (event.shiftKey && event.key === "Backspace")
}

/**
 * The row the palette highlights when its results change: the first row of
 * the first group that has one, given each shown group's row values in
 * render order. Results arrive after the list mounts, so cmdk cannot pick it
 * itself; "" when nothing is shown.
 */
export function firstPaletteValue(groups: readonly (readonly (string | undefined)[])[]): string {
  for (const group of groups) {
    const first = group.find((value) => value)
    if (first) return first
  }
  return ""
}
