/**
 * The browser's own note of its Finder feed (ENG-129): the feed id and the
 * edit token, so the student can change the list later without an account.
 * Strictly necessary for the service the student asked for (PECR reg. 6(4));
 * /privacy says so. Never sent anywhere but to CAMsocs' own feed functions.
 */

export const FEED_STORAGE_KEY = "camsocs.finder.feed"

export type StoredFeed = { feedId: string; editToken: string }

export function readStoredFeed(): StoredFeed | null {
  try {
    const raw = window.localStorage.getItem(FEED_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredFeed>
    return typeof value.feedId === "string" && typeof value.editToken === "string"
      ? { feedId: value.feedId, editToken: value.editToken }
      : null
  } catch {
    return null
  }
}

export function writeStoredFeed(feed: StoredFeed): void {
  try {
    window.localStorage.setItem(FEED_STORAGE_KEY, JSON.stringify(feed))
  } catch {
    // Private mode: the feed still works; it just cannot be edited later here.
  }
}

export function clearStoredFeed(): void {
  try {
    window.localStorage.removeItem(FEED_STORAGE_KEY)
  } catch {}
}

/** The feed's links: https, webcal, and the Google and Outlook "add" pages. */
export function feedLinks(siteUrl: string, feedId: string) {
  const https = `${siteUrl}/events.ics?f=${feedId}`
  const webcal = `webcal://${new URL(siteUrl).host}/events.ics?f=${feedId}`
  return {
    https,
    webcal,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent("My CAMsocs calendar")}`,
  }
}
