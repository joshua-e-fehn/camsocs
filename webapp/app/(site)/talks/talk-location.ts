import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { api } from "@/convex/_generated/api"
import type { ItemLocation } from "@/lib/public-api"
import { publicQuery } from "@/lib/public-data"

/**
 * A talk's resolved place (`locations.forItem({kind: "talk"})`,
 * docs/locations-and-map.md §3), for its page's "Where" row and JSON-LD geo:
 * one anonymous, cached read. It lives under app/(site)/talks/ because a
 * talk's room can come from talks.cam's venue text (G1, lib/talks-boundary.ts):
 * app/talks-boundary.test.tsx refuses any other server module that reads it.
 * Decoration: a failed read is null, and the row shows the source's words.
 */
export const loadTalkLocation = cache(async (itemKey: string): Promise<ItemLocation> => {
  try {
    return await publicQuery(api.locations.forItem, { kind: "talk", itemKey })
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
})
