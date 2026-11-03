import type { NextRequest } from "next/server"
import { eventIcsResponse } from "@/lib/event-ics-response"

/**
 * `GET /talks/events/<key>/ics` — a talks.cam-derived society event as an
 * `.ics` file (owner decision G1, lib/event-ics-response.ts); any other
 * event's file is at `/events/<key>/ics`, and this answers 308 there.
 */

export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  return await eventIcsResponse((await params).key, true)
}
