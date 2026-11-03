"use client"

import { LockIcon } from "lucide-react"
import { CamOnlyHint, ProfileEventRow } from "@/components/molecules/profile-event-row"
import { useSignedInEventWindow } from "@/hooks/convex/events"
import { groupRuns } from "@/lib/event-runs"
import type { EventListItem } from "@/lib/public-api"

/** A society's Cambridge-only events in a list `events.list` returned: only a
 * reader who may see them gets any. */
export function camOnlyEvents(events: readonly EventListItem[] | undefined): EventListItem[] {
  return (events ?? []).filter((event) => event.visibility === "cam_only")
}

/**
 * The end of a society profile's "Coming up", in the browser: the profile is
 * one cached, anonymous page for everyone (docs/webapp.md "Caching"), so it
 * says how many Cambridge-only events a signed-out reader cannot see; once
 * a signed-in reader's session reaches the Convex client, the ones they may
 * see (a verified @cam.ac.uk address, or the broker) replace that hint.
 * Talks.cam-derived events stay out, as on the server's list (owner decision
 * G1).
 *
 * The server's render and the first client render are the hint, so nothing
 * changes at hydration.
 */
export function ProfileCamOnlyEvents({
  orgKey,
  path,
  window,
  hiddenEvents,
}: {
  orgKey: string
  /** The profile's path, where the sign-in link brings the reader back. */
  path: string
  /** The server's window for the hint, from the start of its day. */
  window: { from: number; to: number }
  /** The server's anonymous count; null when unknown. */
  hiddenEvents: number | null
}) {
  const events = camOnlyEvents(useSignedInEventWindow({ ...window, orgKey, talksCam: "exclude" }))
  if (events.length === 0) return <CamOnlyHint count={hiddenEvents} path={path} />
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LockIcon aria-hidden className="size-4" />
        Cambridge-only, shown because you are signed in
      </p>
      <ul className="flex flex-col gap-2">
        {groupRuns(events).map((run) => (
          <li key={run.key} className="min-w-0">
            <ProfileEventRow run={run} href={`/events/${run.key}`} />
          </li>
        ))}
      </ul>
    </div>
  )
}
