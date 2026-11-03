import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { api } from "@/convex/_generated/api"
import { publicQuery } from "@/lib/public-data"

/**
 * Whether the `@cam.ac.uk` sign-in link is switched on
 * (`auth.getSignInOptions`), for the server pages that offer it beside a
 * Cambridge-only event: the society page and the unavailable-event pages
 * (/events and /talks/events), as `useSignInOptions` does for /events and the
 * header (ENG-35). Anonymous and through Next's Data Cache
 * (lib/public-data.ts), so those pages stay cached: a switch reaches them
 * within a revalidation. Read once per request (React `cache`); false when
 * Convex cannot be read, so a page never offers a sign-in that may not be
 * there.
 */
export const camSignInOpen = cache(async (): Promise<boolean> => {
  try {
    return (await publicQuery(api.auth.getSignInOptions, {})).camEmail
  } catch (error) {
    // Next signals "this render is dynamic" by throwing; that must pass.
    unstable_rethrow(error)
    return false
  }
})
