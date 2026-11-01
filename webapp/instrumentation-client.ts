import { startClickTracking } from "@/lib/analytics"
import { startAnalytics } from "@/lib/analytics-client"

/**
 * Runs in the browser before the app hydrates (Next.js
 * `instrumentation-client`). Starts the consent-gated analytics client
 * (lib/analytics-client.ts): it clears leftover analytics storage unless the
 * visitor has accepted, and loads posthog-js only after "Accept analytics",
 * with a project key, outside automated browsers. Then listens for clicks on
 * links marked for the event taxonomy (lib/analytics.ts); without a running
 * client those clicks send nothing.
 */
startAnalytics()
startClickTracking()
