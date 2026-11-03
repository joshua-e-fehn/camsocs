import { formatDayShort, londonIsoDate, londonTime } from "./calendar"
import { spokenTitle } from "./events"
import type { EventPublic, OrgPublic } from "./public-api"
import { CATEGORY_LABELS } from "./vocab"

/**
 * What a per-listing share card says (SEO audit 2026-11-02, og-share-cards):
 * the words app/_og/card.tsx draws for a society or an event, chosen here so
 * the rules are plain and tested. Pure.
 *
 * An event is drawn only when anyone may see it and nothing of it comes from
 * talks.cam (owner decision G1: no talks.cam-derived text outside /talks, an
 * image included); otherwise its card is the generic one. "Comes from
 * talks.cam" is Convex's verdict, `talksDerived` (lib/talks-boundary.ts):
 * the rule reads every stored field, and the proxy and pages go by the same
 * answer. A Cambridge-only
 * event never reaches here: the image route reads anonymously, and the
 * public API returns nothing for it.
 */

/** The words of one card: a small line above, the headline, a line below. */
export type CardText = {
  eyebrow?: string
  headline: string
  detail?: string
}

/** Longest headline drawn; a longer one is cut at a word. */
export const MAX_HEADLINE = 90

/** Cut at a word, with an ellipsis, to at most `max` characters. */
export function clip(text: string, max = MAX_HEADLINE): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`
}

/** A society's card: its kinds, its name, and its short name if it has one. */
export function societyCard(org: Pick<OrgPublic, "name" | "shortName" | "categories">): CardText {
  const kinds = org.categories.slice(0, 2).map((category) => CATEGORY_LABELS[category])
  return {
    eyebrow: kinds.length > 0 ? kinds.join(" · ") : "Society",
    headline: clip(org.name),
    detail: org.shortName && org.shortName !== org.name ? org.shortName : undefined,
  }
}

/** An event's card, or null when only the generic card may be drawn. */
export function eventCard(
  event: Pick<
    EventPublic,
    | "title"
    | "startsAt"
    | "allDay"
    | "cancelled"
    | "visibility"
    | "venueText"
    | "organisers"
    | "talksDerived"
    | "termWeekLabel"
  >,
): CardText | null {
  if (event.visibility !== "public" || event.talksDerived) return null
  const day = formatDayShort(londonIsoDate(event.startsAt))
  const when = event.allDay ? day : `${day} · ${londonTime(event.startsAt)}`
  const host = event.organisers.find((organiser) => organiser.role === "organiser")?.name
  const title = spokenTitle(event.title)
  return {
    eyebrow: [when, event.termWeekLabel].filter(Boolean).join(" · "),
    headline: clip(event.cancelled ? `Cancelled: ${title}` : title),
    detail: [host, event.venueText].filter(Boolean).join(" · ") || undefined,
  }
}
