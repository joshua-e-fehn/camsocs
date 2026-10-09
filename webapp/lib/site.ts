/**
 * Site-wide facts the public pages, metadata and compliance pages state.
 *
 * ⚠ `ICO_REGISTRATION_NUMBER` is deliberately empty until Joshua fills it in
 * (PLAN.md J6 and the privacy notice); the pages leave the line out while it
 * is. Never put a guessed value here.
 */

export const SITE_NAME = "camsocs"

export const SITE_TAGLINE = "A sourced directory of Cambridge societies and sports clubs"

export const SITE_DESCRIPTION =
  "Browse Cambridge student societies and sports clubs and their events. Every fact links to the page it came from. Unofficial and independent."

/** The public origin, for absolute URLs in the sitemap and Open Graph tags. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://camsocs.vercel.app").replace(
  /\/+$/,
  "",
)

/** The data controller (UK GDPR Art 4(7)): an individual, not an organisation. */
export const CONTROLLER_NAME = "Joshua Fehn"

/** Contact address for privacy requests, takedowns and complaints, beside the
 * request form (PLAN.md decisions, 2026-10-08: an alias Joshua creates; it
 * forwards to him). The pages fall back to the form alone if this is empty. */
export const CONTACT_EMAIL = "camsocs@joshua-fehn.de"

/** The Information Commission data protection fee registration number, once
 * paid (PLAN.md J6). Empty until then. */
export const ICO_REGISTRATION_NUMBER = ""

/** When the privacy notice last changed in substance, `YYYY-MM-DD`. */
export const PRIVACY_NOTICE_UPDATED = "2026-10-09"

/** The User-Agent our harvester sends (docs/source-research.md, global rules). */
export const BOT_USER_AGENT = "camsocs-bot/0.1 (+https://camsocs.vercel.app/about)"

/** Where a visitor goes to unlock Cambridge-only events: the @cam.ac.uk
 * sign-in link (`cam=1` selects that option). */
export const CAM_SIGN_IN_HREF = "/sign-in?cam=1"

/** The @cam.ac.uk sign-in, landing back on `next` (a same-origin path). */
export function camSignInHref(next: string): string {
  return `${CAM_SIGN_IN_HREF}&next=${encodeURIComponent(next)}`
}

/** The one-line non-affiliation statement shown in the footer and on About. */
export const DISCLAIMER =
  "camsocs is an independent, unofficial project. It is not affiliated with, endorsed by or run by the University of Cambridge, any of its colleges or Cambridge SU."
