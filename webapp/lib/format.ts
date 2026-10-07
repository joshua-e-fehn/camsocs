/**
 * Small display formatters for the public pages (money, languages, prose).
 * Pure; the date and time formatters live in lib/calendar.ts.
 */

/** 1200 → "£12", 1250 → "£12.50", 0 → "Free". */
export function formatPence(pence: number): string {
  if (pence === 0) return "Free"
  const pounds = pence / 100
  return `£${Number.isInteger(pounds) ? pounds : pounds.toFixed(2)}`
}

/** An event's price as published: free, a single price, a range, or the
 * organiser's own wording. Undefined when nothing is known. */
export function formatEventPrice(
  price: { free: boolean; minPence?: number; maxPence?: number; text?: string } | undefined,
): string | undefined {
  if (!price) return undefined
  if (price.free) return price.text ? `Free (${price.text})` : "Free"
  const { minPence: min, maxPence: max } = price
  const amount =
    min !== undefined && max !== undefined && max > min
      ? `${formatPence(min)}–${formatPence(max)}`
      : min !== undefined
        ? formatPence(min)
        : max !== undefined
          ? `up to ${formatPence(max)}`
          : undefined
  if (amount && price.text) return `${amount} (${price.text})`
  return amount ?? price.text
}

/** "de" → "German"; an unknown code is shown as given. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "language" }).of(code) ?? code
  } catch {
    return code
  }
}

/** Free text as paragraphs: split on blank lines, trimmed, empties dropped.
 * Descriptions are stored as plain text or light markdown; rendering them as
 * text (never HTML) means a scraped page cannot inject markup. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
}
