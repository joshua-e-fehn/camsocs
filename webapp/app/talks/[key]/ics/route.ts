import { fetchQuery } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import type { NextRequest } from "next/server"
import { api } from "@/convex/_generated/api"
import { talkIcsFile } from "@/lib/ics"
import { isTalkKey } from "@/lib/talks-url-state"

/**
 * `GET /talks/<key>/ics` — one talk as an `.ics` file ("Add to calendar" →
 * Apple Calendar / Outlook on the desktop). The same VEVENT as the
 * `/talks.ics` feed (UID `<key>@camsocs.uk`), as a one-off event rather than
 * a feed. An unknown or unlisted talk is a 404.
 */

export const dynamic = "force-dynamic"

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params
  if (!isTalkKey(key)) return plain("Not a talk.", 404)
  let talk: FunctionReturnType<typeof api.talks.get>
  try {
    talk = await fetchQuery(api.talks.get, { key })
  } catch {
    return plain("The talk could not be read just now. Try again later.", 503)
  }
  if (!talk) return plain("This talk is no longer listed.", 404)
  const { body, filename } = talkIcsFile(talk, Date.now())
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  })
}
