/**
 * A venue's name as we print it (docs/locations-and-map.md §1a). Names from
 * OpenStreetMap often carry the institution or the city as a suffix
 * ("Trinity Hall (University of Cambridge)", "…, University of Cambridge",
 * "Corn Exchange, Cambridge"); every venue here is in or near Cambridge, so
 * the suffix says nothing. A name that is only the suffix ("University of
 * Cambridge", "Cambridge") is left whole.
 *
 * Display only: keys are never minted from the result. The pipeline posts
 * new venues' names through the same rule (`locate/venue_name.py`); both
 * implementations are held to `venue-name.fixtures.json`.
 */

/** Whitespace, spelled out: JS's `\s` / `trim()` and Python's `\s` /
 * `str.strip()` disagree on a few characters (U+FEFF, U+001C–U+001F, U+0085),
 * so both helpers use this set (JS's own) and nothing else. */
const WS = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`
const TRIM = new RegExp(`^${WS}+|${WS}+$`, "g")
const trim = (text: string) => text.replace(TRIM, "")

const PLACE = `(?:the${WS}+)?(?:university${WS}+of${WS}+cambridge|cambridge${WS}+university|cambridge)`

/** One trailing suffix: " (University of Cambridge)", ", University of
 * Cambridge", " - University of Cambridge" (or an en / em dash), and the same
 * with "Cambridge University" or "Cambridge" alone. */
const SUFFIX = new RegExp(
  String.raw`(?:${WS}*\(${WS}*${PLACE}${WS}*\)|${WS}*,${WS}*${PLACE}|${WS}+[-–—]${WS}*${PLACE})${WS}*$`,
  "i",
)

export function venueDisplayName(name: string): string {
  let shown = trim(name)
  for (;;) {
    const match = SUFFIX.exec(shown)
    if (!match) return shown
    const rest = trim(shown.slice(0, match.index))
    // The suffix is the whole name, or all that is left of it.
    if (!rest || !/[\p{L}\p{N}]/u.test(rest)) return shown
    shown = rest
  }
}
