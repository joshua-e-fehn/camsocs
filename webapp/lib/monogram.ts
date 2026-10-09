/**
 * The initials an organisation without a logo is shown with (only ~8% of
 * listings have a stored logo). One or two letters from the words that tell
 * groups apart — "Cambridge University", "Society", "Club" and the like are
 * on almost every name, so they are skipped: "ABBA Support Society" → "AS",
 * "Cambridge University Triathlon Club" → "T", "Ethics in Mathematics
 * Society" → "EM". A short acronym the organisation uses (≤ 4 characters)
 * wins.
 */

const SKIPPED = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "cambridge",
  "university",
  "cu",
  "society",
  "soc",
  "club",
  "association",
])

export function monogram(name: string, shortName?: string): string {
  const acronym = shortName?.trim()
  if (acronym && /^[\p{L}\p{N}]{2,4}$/u.test(acronym)) return acronym.toUpperCase()
  const words = name
    // "(Cambridge)", "(CUADC)": qualifiers, not the name.
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s/–—-]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
  const telling = words.filter((word) => !SKIPPED.has(word.toLowerCase()))
  const chosen = telling.length > 0 ? telling : words
  if (chosen.length === 0) return "?"
  return chosen
    .slice(0, 2)
    .map((word) => [...word][0])
    .join("")
    .toUpperCase()
}
