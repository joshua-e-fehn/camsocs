import { initBotId } from "botid/client/core"
import { startClickTracking } from "@/lib/analytics"
import { startAnalytics } from "@/lib/analytics-client"
import { REQUEST_PATH } from "@/lib/request-client"

/**
 * Runs in the browser before the app hydrates (Next.js
 * `instrumentation-client`). Starts the consent-gated analytics client
 * (lib/analytics-client.ts): it clears leftover analytics storage unless the
 * visitor has accepted, and loads posthog-js only after "Accept analytics",
 * with a project key, outside automated browsers. Then listens for clicks on
 * links marked for the event taxonomy (lib/analytics.ts); without a running
 * client those clicks send nothing.
 *
 * On a Vercel build it also starts Vercel BotID's browser half (ENG-37): it
 * wraps `fetch` so a POST to the request form's route carries BotID's
 * challenge headers (lib/request-submit.ts). Elsewhere the flag is empty
 * (next.config.ts `botCheckClientFlag`) and nothing is wrapped. Everything
 * imported here ships on every page: `REQUEST_PATH` comes from the zod-free
 * lib/request-client.ts, never from the route's server module.
 */
startAnalytics()
startClickTracking()
if (process.env.NEXT_PUBLIC_BOT_CHECK === "1") {
  initBotId({ protect: [{ path: REQUEST_PATH, method: "POST" }] })
}
