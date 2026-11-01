"use client"

import { useTrackView } from "@/hooks/use-analytics"
import type { AnalyticsEvent, EventProps } from "@/lib/analytics"

/**
 * A view event for a server-rendered page (ENG-5): a client island that
 * renders nothing and sends `event` once on mount (`useTrackView`), so the
 * page itself stays a server component. Sends nothing without analytics
 * consent (lib/analytics.ts).
 */
export function TrackView<E extends AnalyticsEvent>({
  event,
  props,
}: {
  event: E
  props: EventProps<E>
}) {
  useTrackView(event, props)
  return null
}
