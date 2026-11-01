import { getPostHog, posthogReady } from "@/lib/analytics-client"
import {
  ANALYTICS_EVENTS,
  type AnalyticsEvent,
  allowedProps,
  CONTEXT_ATTR,
  EVENT_ATTR,
  type EventProps,
  PROPS_ATTR,
  type PropValue,
} from "@/lib/analytics-events"
import { getConsent } from "@/lib/consent"

/**
 * Product events (ENG-5; taxonomy in lib/analytics-events.ts, rules in
 * docs/analytics.md). `track()` is the only way our own events are sent:
 *
 *  - It does nothing unless the analytics client runs (lib/analytics-client.ts:
 *    the visitor accepted, a project key is set, not an automated browser).
 *    While a grant's package load is still under way (a view on the page the
 *    visitor landed on) it waits for that load, then checks again.
 *  - It sends only events in the taxonomy, with only their allowed properties
 *    and only values that pass their rules; an event missing a required
 *    property is not sent. `before_send` checks the same table again.
 *  - It never throws: analytics must not break a page.
 *
 * Signed-in visitors are never identified (no `identify()`, hard rule 2).
 */

export type { AnalyticsEvent, EventProps } from "@/lib/analytics-events"

/** Sends `event` with `props`, if analytics runs and the taxonomy allows it. */
export function track<E extends AnalyticsEvent>(event: E, props: EventProps<E>): void {
  trackUnchecked(event, props as Readonly<Record<string, unknown>>)
}

/** `track` for names and props read at runtime (the click tracker). */
function trackUnchecked(event: string, props: Readonly<Record<string, unknown>>): void {
  const clean = allowedProps(ANALYTICS_EVENTS, event, props)
  if (!clean) return
  const send = (client: ReturnType<typeof getPostHog>) => {
    try {
      client?.capture(event, clean as Record<string, PropValue>)
    } catch {
      // Analytics never breaks the page.
    }
  }
  const client = getPostHog()
  if (client) {
    send(client)
    return
  }
  if (getConsent() !== "granted") return
  posthogReady().then(send, () => {})
}

function parseObject(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Sends the event a clicked element's `analyticsAttrs` describe, with its
 * nearest `analyticsContext`. */
function onClick(event: MouseEvent): void {
  // A middle click opens a link too; other auxiliary buttons do not.
  if (event.type === "auxclick" && event.button !== 1) return
  const target = event.target
  if (!(target instanceof Element)) return
  const element = target.closest(`[${EVENT_ATTR}]`)
  const name = element?.getAttribute(EVENT_ATTR)
  if (!element || !name) return
  const context = parseObject(
    element.closest(`[${CONTEXT_ATTR}]`)?.getAttribute(CONTEXT_ATTR) ?? null,
  )
  trackUnchecked(name, { ...context, ...parseObject(element.getAttribute(PROPS_ATTR)) })
}

/**
 * Listens for clicks on elements marked with `analyticsAttrs` (links in
 * server-rendered markup). In the capture phase, so a component that stops
 * the click's propagation cannot hide it. Calling it again adds nothing (the
 * same listener). Returns the stop function (tests).
 */
export function startClickTracking(target: Document = document): () => void {
  target.addEventListener("click", onClick, true)
  target.addEventListener("auxclick", onClick, true)
  return () => {
    target.removeEventListener("click", onClick, true)
    target.removeEventListener("auxclick", onClick, true)
  }
}
