/**
 * Site-wide facts the public pages, metadata and compliance pages state.
 *
 * `CONTACT_EMAIL` is Joshua's decision D4 (PLAN.md, 2026-10-08); he creates the
 * alias. `ICO_REGISTRATION_NUMBER` is empty: no data protection fee is payable
 * (the regulator's self-assessment, PLAN.md J6, 2026-11-03), so there is no
 * number, and the pages leave the line out. Never put a guessed value here.
 */

export const SITE_NAME = "CAMsocs"

/** What the root layout's title template appends to a page's title
 * (app/layout.tsx). */
export const TITLE_SUFFIX = ` · ${SITE_NAME}`

/** The longest `<title>` a result shows in full (owner decision G2): every
 * page's title, suffix included, fits it, the suffix dropped first. One
 * limit for the directory, events, talks and the site's own pages. */
export const MAX_TITLE_LENGTH = 60

export const SITE_TAGLINE = "Cambridge societies, events and talks, sourced"

/** The home page's and the site's meta description: at most 155 characters,
 * so no result cuts it short (SEO audit 2026-11-02, meta-description-quality;
 * a test holds the limit). */
export const SITE_DESCRIPTION =
  "Cambridge student societies, sports clubs and their events, plus public academic talks, in one place. Every fact links to its source. Unofficial."

/** The home hero's first sentence: what the site is, said plainly for a
 * searcher and an AI answer that quotes the page (SEO audit 2026-11-02,
 * home-metadata). Unofficial and independent, never the University's: no
 * claim of affiliation (DISCLAIMER). The talks are public academic ones
 * (talks.cam), not the societies' own, as SITE_DESCRIPTION says (review of
 * 2026-11-03, site-intro-talks). */
export const SITE_INTRO =
  "CAMsocs is an unofficial, independent directory of Cambridge student societies and clubs, their events, and public academic talks."

/** The light theme's paper, the one colour the browser's chrome takes
 * (DESIGN.md "Light only"; app/globals.css `--background`): the viewport's
 * theme-color and the web manifest. */
export const THEME_COLOR = "#FFFFFF"

/** The public origin, for absolute URLs in the sitemap and Open Graph tags. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://camsocs.uk").replace(
  /\/+$/,
  "",
)

/** The data controller (UK GDPR Art 4(7)): an individual, not an organisation. */
export const CONTROLLER_NAME = "Joshua Fehn"

/** Contact address for privacy requests, takedowns and complaints, beside the
 * request form (D4: an alias Joshua creates; it forwards to him). The pages
 * fall back to the form alone if this is empty. */
export const CONTACT_EMAIL = "camsocs@joshua-fehn.de"

/** The data protection fee registration number from the Information
 * Commission (the ICO until 30 September 2026). Empty: no fee is payable
 * (PLAN.md J6); fill it in only if a fee is ever paid. */
export const ICO_REGISTRATION_NUMBER = ""

/** When the privacy notice last changed in substance, `YYYY-MM-DD`. */
export const PRIVACY_NOTICE_UPDATED = "2026-11-04"

/** When the terms of use (`/terms`) last changed in substance, `YYYY-MM-DD`. */
export const TERMS_UPDATED = "2026-11-03"

/** Where security problems and personal data breaches are reported (in
 * `public/.well-known/security.txt`, written from lib/security-txt.ts; what
 * happens next: docs/compliance/breach-procedure.md). The same alias as
 * CONTACT_EMAIL. */
export const SECURITY_CONTACT_EMAIL = CONTACT_EMAIL

/** When `/.well-known/security.txt` stops being valid (RFC 9116 §2.5.5: under
 * a year ahead). ⚠ Renew it in the July review, before it lapses. */
export const SECURITY_TXT_EXPIRES = "2027-09-01T00:00:00.000Z"

/** The User-Agent our harvester sends (docs/source-research.md, global rules). */
export const BOT_USER_AGENT = "camsocs-bot/0.1 (+https://camsocs.uk/about)"

/** Where a visitor goes to unlock Cambridge-only events: the @cam.ac.uk
 * sign-in link (`cam=1` selects that option). */
export const CAM_SIGN_IN_HREF = "/sign-in?cam=1"

/** The @cam.ac.uk sign-in, landing back on `next` (a same-origin path). */
export function camSignInHref(next: string): string {
  return `${CAM_SIGN_IN_HREF}&next=${encodeURIComponent(next)}`
}

/** What the generic share image shows, for its alt text
 * (app/opengraph-image.tsx draws exactly this). */
export const SHARE_IMAGE_ALT = `${SITE_NAME}: Everything on in Cambridge, in one place. Events, talks and societies. Unofficial.`

/** The one-line non-affiliation statement shown in the footer and on About. */
export const DISCLAIMER =
  "CAMsocs is an independent, unofficial project. It is not affiliated with, endorsed by or run by the University of Cambridge, any of its colleges or Cambridge SU."
