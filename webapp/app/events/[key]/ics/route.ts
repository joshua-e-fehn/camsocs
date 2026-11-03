import type { NextRequest } from "next/server"
import { eventIcsResponse } from "@/lib/event-ics-response"

/**
 * `GET /events/<key>/ics` — one event as an `.ics` file
 * (lib/event-ics-response.ts; a University listing names the programme,
 * ENG-24); a talks.cam-derived event's file is at
 * `/talks/events/<key>/ics` (owner decision G1), and this answers 308 there.
 */

export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  return await eventIcsResponse((await params).key, false)
}
