import { startAnalytics } from "@/lib/analytics-client"

/**
 * Runs in the browser before the app hydrates (Next.js
 * `instrumentation-client`). Starts the consent-gated analytics client
 * (lib/analytics-client.ts): it clears leftover analytics storage unless the
 * visitor has accepted, and loads posthog-js only after "Accept analytics",
 * with a project key, outside automated browsers.
 */
startAnalytics()
