"use client"

import { useEffect, useRef } from "react"
import { track } from "@/lib/analytics"
import { readSignInMarker } from "@/lib/analytics-events"
import { authClient } from "@/lib/auth-client"

/**
 * Sends `sign_in_completed` (ENG-5) on the page a Cambridge sign-in link
 * lands on: the link's callback carries `?signed_in=cam`
 * (lib/analytics-events.ts `withSignInMarker`). Once the session has
 * resolved, a real session sends the event (the method only; the visitor is
 * never identified), and the marker leaves the address bar either way, so a
 * reload or a shared link does not count again. Without analytics consent
 * nothing is sent (lib/analytics.ts); on /dashboard the client drops it.
 */
export function SignInTracker() {
  const { data: session, isPending } = authClient.useSession()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || isPending) return
    const { method, cleaned } = readSignInMarker(window.location.href)
    if (cleaned === null) return
    done.current = true
    if (method && session) track("sign_in_completed", { method })
    window.history.replaceState(window.history.state, "", cleaned)
  }, [isPending, session])
  return null
}
