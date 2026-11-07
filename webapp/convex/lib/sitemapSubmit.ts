import {
  accessToken,
  errorDetail,
  GSC_API,
  REQUEST_TIMEOUT_MS,
  request,
  type SearchConsoleConfig,
  TrafficSourceError,
} from "./traffic"

/**
 * Telling Google the sitemaps changed (event indexing, 2026-11-07, Joshua's
 * OK). Google retired its sitemap "ping" in 2023; the supported ways are
 * Search Console's UI, its API (`sitemaps.submit`) and robots.txt. This uses
 * the API, with the refresh token the traffic card reads through
 * (`GSC_REFRESH_TOKEN`, scope `webmasters` since 7 Nov: `submit` needs more
 * than read-only).
 *
 * A submission is a hint, so it is only sent when it says something: when a
 * file has never been submitted, when an event was stored since its last
 * submission (the feed and the events sitemap then list a new page), or once
 * a week regardless (society profiles change without new events). Google
 * documents no penalty for resubmitting; it simply gains nothing from an
 * unchanged file, which is why an unchanged one is left alone. Its last
 * submission date comes from Search Console itself, so no state is kept here.
 */

/** The files submitted: the sitemap index and the new-events feed. */
export const SUBMITTED_FILES = ["sitemap.xml", "events.atom"] as const

/** Resubmitted after this long even when no event was stored. */
export const RESUBMIT_EVERY_MS = 7 * 24 * 60 * 60 * 1000

export type SubmitOutcome = {
  file: string
  action: "submitted" | "unchanged" | "failed"
  detail?: string
}

/** Whether a file should be submitted now (see the module comment). */
export function shouldSubmit(
  lastSubmitted: number | null,
  newestChangeAt: number | null,
  now: number,
): boolean {
  if (lastSubmitted === null) return true
  if (newestChangeAt !== null && newestChangeAt > lastSubmitted) return true
  return now - lastSubmitted >= RESUBMIT_EVERY_MS
}

/** The site's origin for the file URLs: a URL-prefix property is one; a
 * domain property (`sc-domain:`) needs `siteOrigin`. */
export function fileUrl(config: SearchConsoleConfig, siteOrigin: string, file: string): string {
  const base = config.siteUrl.startsWith("sc-domain:") ? `${siteOrigin}/` : config.siteUrl
  return new URL(file, base).toString()
}

function sitemapEndpoint(config: SearchConsoleConfig, url: string): string {
  return `${GSC_API}/sites/${encodeURIComponent(config.siteUrl)}/sitemaps/${encodeURIComponent(url)}`
}

/** When Search Console last had this file submitted; null if never. */
async function lastSubmitted(
  config: SearchConsoleConfig,
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const response = await request(
    fetchImpl,
    sitemapEndpoint(config, url),
    { headers: { Authorization: `Bearer ${token}` } },
    REQUEST_TIMEOUT_MS,
  )
  if (response.status === 404) return null
  if (!response.ok) throw new TrafficSourceError(`get ${await errorDetail(response)}`)
  const body = (await response.json()) as { lastSubmitted?: unknown }
  const at = typeof body.lastSubmitted === "string" ? Date.parse(body.lastSubmitted) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/**
 * Submits each of `SUBMITTED_FILES` that `shouldSubmit` says has news.
 * Never throws: each file's outcome is reported (a failed token read fails
 * them all), and the next day's run tries again.
 */
export async function resubmitSitemaps(
  config: SearchConsoleConfig,
  siteOrigin: string,
  newestChangeAt: number | null,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitOutcome[]> {
  let token: string
  try {
    token = await accessToken(config, fetchImpl, REQUEST_TIMEOUT_MS)
  } catch (error) {
    const detail = error instanceof TrafficSourceError ? error.message : "token failed"
    return SUBMITTED_FILES.map((file) => ({ file, action: "failed" as const, detail }))
  }
  const outcomes: SubmitOutcome[] = []
  for (const file of SUBMITTED_FILES) {
    const url = fileUrl(config, siteOrigin, file)
    try {
      const last = await lastSubmitted(config, url, token, fetchImpl)
      if (!shouldSubmit(last, newestChangeAt, now)) {
        outcomes.push({ file, action: "unchanged" })
        continue
      }
      const response = await request(
        fetchImpl,
        sitemapEndpoint(config, url),
        { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
        REQUEST_TIMEOUT_MS,
      )
      if (!response.ok) throw new TrafficSourceError(`submit ${await errorDetail(response)}`)
      outcomes.push({ file, action: "submitted" })
    } catch (error) {
      const detail =
        error instanceof TrafficSourceError
          ? error.message
          : error instanceof Error && error.name === "AbortError"
            ? "timed out"
            : "request failed"
      outcomes.push({ file, action: "failed", detail })
    }
  }
  return outcomes
}
