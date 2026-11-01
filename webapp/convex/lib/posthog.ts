/**
 * Server-side counts from Convex to PostHog's capture API (ENG-7; spec
 * "Server-side events without consent", research-api §5, law report §7,
 * record of processing P12). Convex runs in its own runtime, so this is a
 * plain `fetch` rather than posthog-node (`webapp/lib/posthog-server.ts` is the
 * Next.js sender), with the same rules:
 *
 *  - one fixed distinct id, `camsocs-server`, `$process_person_profile: false`
 *    and `$geoip_disable: true`: no person, no device, no location (PostHog
 *    would only ever see Convex's address anyway);
 *  - IDs and enums only, never an email, a name or form text;
 *  - one short attempt; a failure is logged by HTTP status or error type and
 *    swallowed, never retried.
 *
 * Off until both env vars are set; they are set on the production deployment
 * only (docs/deploy.md), so dev and preview builds send nothing:
 *
 *   bunx convex env set --prod POSTHOG_KEY       (the project token, phc_…)
 *   bunx convex env set --prod POSTHOG_HOST https://eu.i.posthog.com
 *
 * `environment` is `production`, because only production has the key; set
 * `POSTHOG_ENV=development` on a deployment given a key for a test, and the
 * project's internal/test filter hides its events.
 *
 * ⚠ Never log the key or the request body.
 */

/** The documented single-event capture path (research-api §5). */
export const CAPTURE_PATH = "/i/v0/e/"

/** The distinct id every server event carries (as in lib/posthog-server.ts). */
export const SERVER_DISTINCT_ID = "camsocs-server"

/** How long one capture may take before it is abandoned. */
export const CAPTURE_TIMEOUT_MS = 3_000

export type PostHogConfig = {
  key: string
  host: string
  environment: "production" | "development"
}

/** The sender's settings, or null when it is switched off. Read per call, so
 * setting the env vars takes effect without a deploy. */
export function posthogConfig(
  env: Record<string, string | undefined> = process.env,
): PostHogConfig | null {
  const key = env.POSTHOG_KEY?.trim()
  const host = env.POSTHOG_HOST?.trim().replace(/\/+$/, "")
  if (!key || !host) return null
  return {
    key,
    host,
    environment: env.POSTHOG_ENV?.trim() === "development" ? "development" : "production",
  }
}

export type CaptureProps = Readonly<Record<string, string | number | boolean>>

/** The capture API's body for one event. Pure. */
export function captureBody(config: PostHogConfig, event: string, props: CaptureProps) {
  return {
    api_key: config.key,
    event,
    distinct_id: SERVER_DISTINCT_ID,
    properties: {
      ...props,
      environment: config.environment,
      $process_person_profile: false,
      $geoip_disable: true,
    },
  }
}

/**
 * Sends one event. Resolves whatever happens: a refusal, a network error or
 * the timeout is logged (status or error name only) and swallowed, so a count
 * can never fail or retry the work it counts.
 */
export async function sendCapture(
  config: PostHogConfig,
  event: string,
  props: CaptureProps,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${config.host}${CAPTURE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(captureBody(config, event, props)),
      signal: controller.signal,
    })
    if (!response.ok) console.error(`PostHog refused ${event} (HTTP ${response.status})`)
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error
    console.error(`PostHog capture of ${event} failed (${name})`)
  } finally {
    clearTimeout(timer)
  }
}
