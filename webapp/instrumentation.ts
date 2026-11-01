import type { Instrumentation } from "next"

/**
 * Server instrumentation (Next.js `instrumentation.ts`). Reports request
 * errors to PostHog (ENG-6) through lib/posthog-server.ts, with the route,
 * method and Next's router facts only: never headers, cookies, bodies, query
 * strings, IP addresses or user agents. Without `NEXT_PUBLIC_POSTHOG_KEY` it
 * sends nothing.
 *
 * Node.js runtime only: posthog-node's error tracking needs Node APIs, and the
 * import stays out of any edge bundle. Returns at once; the report goes out in
 * the background (`waitUntil`), so the error response never waits for it.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { reportRequestError } = await import("./lib/posthog-server")
  reportRequestError(error, request, context)
}
