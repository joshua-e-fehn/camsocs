import { DISCLAIMER } from "./site"
import { breadcrumbList, PUBLISHER_ID, pageId, WEBSITE_ID } from "./structured-data"

/**
 * The guides (`/guides`, `/guides/<slug>`): editorial pages for students
 * finding, joining and starting societies. Drafted by Claude on 2026-11-04
 * from public primary sources (each fact on a page links its source below),
 * for Joshua to review and edit before they go live.
 *
 * Two rules hold the drafts honest:
 *  - Every fact a page states cites a `GuideSource` (`<Cite id>`), and the
 *    page lists its sources with the date they were read. A fact without one
 *    is not written, or is an editor's note.
 *  - Anything unconfirmed, and every first-hand tip still to write, is a
 *    `REVIEW_NOTES` entry shown on the page as "[Joshua: …]" (`<EditorNote>`).
 *    `lib/guides.test.ts` fails while the list is non-empty, so the guides
 *    cannot be merged unreviewed; while it is non-empty the pages also say
 *    they are drafts and ask not to be indexed.
 *
 * The guides are unofficial (DISCLAIMER): they describe what the SU, the
 * Proctors, the Sports Service and the colleges publish, and never speak for
 * any of them.
 */

export type GuideSlug = "join-a-society" | "start-a-society"

export type Guide = {
  slug: GuideSlug
  path: `/guides/${GuideSlug}`
  /** The page's name and h1; the `<title>` adds " · CAMsocs" while it fits. */
  title: string
  /** Meta description, at most 155 characters (a test holds it). */
  description: string
  /** One line for the guides index. */
  summary: string
  /** `YYYY-MM-DD`: when the page first went live (Article `datePublished`). */
  published: string
  /** `YYYY-MM-DD`: when its facts were last checked (Article `dateModified`). */
  updated: string
  /** Every source the page cites, in the order its source list shows them. */
  sources: readonly SourceId[]
}

export const GUIDES_PATH = "/guides"
export const GUIDES_TITLE = "Guides to Cambridge societies"
export const GUIDES_DESCRIPTION =
  "Plain guides for students: how to find and join societies and clubs in Cambridge, and how to start your own. Unofficial; every fact links its source."

// --- sources -------------------------------------------------------------------------------

export type GuideSource = {
  /** Who published it, short: shown inline as the citation. */
  publisher: string
  /** What the page or document is. */
  title: string
  url: string
  /** `YYYY-MM-DD`: when it was read for the guide. */
  retrieved: string
}

const READ = "2026-11-04"

export const SOURCES = {
  "su-fair": {
    publisher: "Cambridge SU",
    title: "Freshers' Fair",
    url: "https://www.cambridgesu.co.uk/freshers/freshersfair",
    retrieved: READ,
  },
  "su-fair-2026": {
    publisher: "Cambridge SU",
    title: "Freshers' Fair stallholder page (archived 22 August 2026)",
    url: "https://web.archive.org/web/20260822202000/https://www.cambridgesu.co.uk/opportunities/freshersfair/",
    retrieved: READ,
  },
  "su-fair-pack": {
    publisher: "Cambridge SU",
    title: "Freshers' Fair information pack for stallholders",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/freshersfair/Freshers-Fair-Information-Pack.pdf",
    retrieved: READ,
  },
  "su-what-is": {
    publisher: "Cambridge SU",
    title: "Freshers: what is a society? (9 September 2025)",
    url: "https://www.cambridgesu.co.uk/news/article/cambridgesu/Freshers-What-is-a-society/",
    retrieved: READ,
  },
  "su-find": {
    publisher: "Cambridge SU",
    title: "Find a Society",
    url: "https://www.cambridgesu.co.uk/opportunities/societies/",
    retrieved: READ,
  },
  "su-profile-paid-a": {
    publisher: "Cambridge SU",
    title: "A society's directory profile selling membership through an outside ticketing site",
    url: "https://www.cambridgesu.co.uk/organisation/10201/",
    retrieved: READ,
  },
  "su-profile-paid-b": {
    publisher: "Cambridge SU",
    title: "A society's directory profile selling membership through an outside payment site",
    url: "https://www.cambridgesu.co.uk/organisation/10021/",
    retrieved: READ,
  },
  "su-profile-free": {
    publisher: "Cambridge SU",
    title: "A society's directory profile with a free members' group",
    url: "https://www.cambridgesu.co.uk/organisation/10001/",
    retrieved: READ,
  },
  "su-refreshers-2024": {
    publisher: "Cambridge SU",
    title: "Refreshers' Fair: what to expect (January 2024)",
    url: "https://www.cambridgesu.co.uk/news/article/cambridgesu/Refreshers-Fair-What-to-expect-amp-why-you-should-go/",
    retrieved: READ,
  },
  "su-freshers": {
    publisher: "Cambridge SU",
    title: "Freshers",
    url: "https://www.cambridgesu.co.uk/freshers/",
    retrieved: READ,
  },
  "su-advice": {
    publisher: "Cambridge SU",
    title: "Student Advice Service",
    url: "https://www.cambridgesu.co.uk/advice",
    retrieved: READ,
  },
  "su-safeguarding": {
    publisher: "Cambridge SU",
    title: "Safeguarding",
    url: "https://www.cambridgesu.co.uk/safeguarding/",
    retrieved: READ,
  },
  "su-terms": {
    publisher: "Cambridge SU",
    title: "Registration terms and conditions for clubs and societies (updated August 2024)",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/start-a-society/SU-club-and-Soc-tscs(1).pdf",
    retrieved: READ,
  },
  "su-start": {
    publisher: "Cambridge SU",
    title: "Start a Society",
    url: "https://www.cambridgesu.co.uk/opportunities/start-a-society/",
    retrieved: READ,
  },
  "su-constitution": {
    publisher: "Cambridge SU",
    title: "Constitution template",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/support/resources/Cambridge-SU-Constitution-Template.pdf",
    retrieved: READ,
  },
  "su-logo": {
    publisher: "Cambridge SU",
    title: "Guidance for student societies on using the University logo",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/start-a-society/Guidance-for-using-the-University-logo-Student-Societies.pdf",
    retrieved: READ,
  },
  "su-finance": {
    publisher: "Cambridge SU",
    title: "Society finance and grants",
    url: "https://www.cambridgesu.co.uk/opportunities/support/finance/",
    retrieved: READ,
  },
  "su-rooms": {
    publisher: "Cambridge SU",
    title: "Room hire",
    url: "https://www.cambridgesu.co.uk/opportunities/support/roomhire/",
    retrieved: READ,
  },
  "su-promotion": {
    publisher: "Cambridge SU",
    title: "Promotion for societies",
    url: "https://www.cambridgesu.co.uk/opportunities/support/promotion/",
    retrieved: READ,
  },
  "su-resources": {
    publisher: "Cambridge SU",
    title: "Committee resources",
    url: "https://www.cambridgesu.co.uk/opportunities/support/resources/",
    retrieved: READ,
  },
  "proctors-clubs": {
    publisher: "The Proctors",
    title: "Clubs and societies",
    url: "https://www.proctors.cam.ac.uk/clubsandsocs",
    retrieved: READ,
  },
  "proctors-list": {
    publisher: "The Proctors",
    title: "Societies registered with the Junior Proctor",
    url: "https://www.proctors.cam.ac.uk/clubsandsocs/registered-societies",
    retrieved: READ,
  },
  "proctors-notice": {
    publisher: "The Proctors",
    title: "Proctorial Notice 5, 2026–27: University clubs and societies",
    url: "https://www.proctors.cam.ac.uk/sites/default/files/5.%20University%20Clubs%20and%20Societies.pdf",
    retrieved: READ,
  },
  "jp-notes": {
    publisher: "The Junior Proctor",
    title: "Notes of guidance for clubs and societies (revised October 2026)",
    url: "https://www.proctors.cam.ac.uk/sites/default/files/202610.13%20JP%20Notes%20of%20Guidance%20for%20Societies%202026%20%28uploaded%20Oct%202026%29.pdf",
    retrieved: READ,
  },
  "syndicate-grants": {
    publisher: "The Proctors",
    title: "Grants from the Societies Syndicate",
    url: "https://www.proctors.cam.ac.uk/clubsandsocs/grants-from-the-societies-syndicate",
    retrieved: READ,
  },
  "free-speech": {
    publisher: "University governance and compliance",
    title: "Code of Practice on Freedom of Speech",
    url: "https://www.governanceandcompliance.admin.cam.ac.uk/policies-and-guidance/university-code-practice-freedom-speech",
    retrieved: READ,
  },
  "term-dates": {
    publisher: "The University",
    title: "Term dates and calendars",
    url: "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars",
    retrieved: READ,
  },
  "uis-lists": {
    publisher: "University Information Services",
    title: "Mailing lists",
    url: "https://help.uis.cam.ac.uk/service/email/lists",
    retrieved: READ,
  },
  "uis-subscribe": {
    publisher: "University Information Services",
    title: "Subscribing to a mailing list",
    url: "https://help.uis.cam.ac.uk/node/1450",
    retrieved: READ,
  },
  "anon-reporting": {
    publisher: "Student complaints office",
    title: "Anonymous reporting for students and staff",
    url: "https://www.studentcomplaints.admin.cam.ac.uk/anonymous-reporting-students-and-staff",
    retrieved: READ,
  },
  "sport-clubs": {
    publisher: "Sports Service",
    title: "University sports clubs",
    url: "https://www.sport.cam.ac.uk/student-sport/university-sports-clubs",
    retrieved: READ,
  },
  "sport-guide": {
    publisher: "Sports Service",
    title: "Sports Club Guide 2026–27 (PDF, as linked from its clubs page)",
    url: "https://live-cambridge-sports-cwp.pantheonsite.io/sites/default/files/UoC%20Sports%20Club%20Guide%2026-27_web.pdf",
    retrieved: READ,
  },
  "sport-eligibility": {
    publisher: "Sports Service",
    title: "Student eligibility criteria",
    url: "https://www.sport.cam.ac.uk/student-sport/university-sports-clubs/student-eligibility-criteria",
    retrieved: READ,
  },
  "sport-varsity": {
    publisher: "Sports Service",
    title: "Varsity matches",
    url: "https://www.sport.cam.ac.uk/varsity-matches",
    retrieved: READ,
  },
  "sport-give-it-a-go": {
    publisher: "Sports Service",
    title: "Recreational sport: Give It a Go",
    url: "https://www.sport.cam.ac.uk/recreational-sport-give-it-go",
    retrieved: READ,
  },
  "sport-college": {
    publisher: "Sports Service",
    title: "College sport",
    url: "https://www.sport.cam.ac.uk/college-sport",
    retrieved: READ,
  },
  "sport-student": {
    publisher: "Sports Service",
    title: "Student sport",
    url: "https://www.sport.cam.ac.uk/student-sport",
    retrieved: READ,
  },
  "pembroke-fairs": {
    publisher: "Pembroke College",
    title: "Freshers' guide: Freshers' Fair",
    url: "https://gp.pem.cam.ac.uk/freshers-guide/freshers-fair/",
    retrieved: READ,
  },
  "christs-fair": {
    publisher: "Christ's College",
    title: "Freshers' Fair",
    url: "https://www.christs.cam.ac.uk/student-life-1/freshers-fair",
    retrieved: READ,
  },
  "lucy-societies": {
    publisher: "Lucy Cavendish College",
    title: "Clubs and societies",
    url: "https://lucy.cam.ac.uk/our-college/place-live-and-study/clubs-and-societies",
    retrieved: READ,
  },
  "queens-form": {
    publisher: "Queens' College JCR",
    title: "Society registration form (Word document)",
    url: "https://www.qjcr.org.uk/content/SocietyRegistrationForm.docx",
    retrieved: READ,
  },
} as const satisfies Record<string, GuideSource>

export type SourceId = keyof typeof SOURCES

// --- the guides ----------------------------------------------------------------------------

export const GUIDES: readonly Guide[] = [
  {
    slug: "join-a-society",
    path: "/guides/join-a-society",
    title: "How to find and join societies in Cambridge",
    description:
      "How to find and join Cambridge student societies and sports clubs: the Freshers' and Sports Fairs, joining later in the year, costs, and where to get help.",
    summary:
      "The fairs at the start of the year, what to do if you missed them, sport, mailing lists, costs, and where to go if something goes wrong.",
    published: "2026-11-04",
    updated: "2026-11-04",
    sources: [
      "su-what-is",
      "su-fair",
      "su-fair-2026",
      "term-dates",
      "pembroke-fairs",
      "christs-fair",
      "lucy-societies",
      "su-find",
      "proctors-list",
      "su-refreshers-2024",
      "sport-clubs",
      "sport-guide",
      "sport-eligibility",
      "sport-varsity",
      "sport-give-it-a-go",
      "sport-college",
      "uis-lists",
      "uis-subscribe",
      "su-freshers",
      "su-profile-paid-a",
      "su-profile-paid-b",
      "su-profile-free",
      "su-terms",
      "su-advice",
      "su-safeguarding",
      "anon-reporting",
    ],
  },
  {
    slug: "start-a-society",
    path: "/guides/start-a-society",
    title: "How to start a society in Cambridge",
    description:
      "How to start a student society in Cambridge: registering with Cambridge SU, the Junior Proctor or your college, a constitution, money, rooms and events.",
    summary:
      "Checking it does not exist yet, the three ways to register, a constitution, a bank account and grants, rooms and events, and keeping it going.",
    published: "2026-11-04",
    updated: "2026-11-04",
    sources: [
      "su-start",
      "su-terms",
      "su-constitution",
      "su-find",
      "proctors-clubs",
      "proctors-list",
      "proctors-notice",
      "jp-notes",
      "queens-form",
      "sport-student",
      "su-finance",
      "syndicate-grants",
      "su-logo",
      "su-rooms",
      "free-speech",
      "su-promotion",
      "su-fair-2026",
      "su-fair-pack",
      "su-resources",
    ],
  },
]

export function guide(slug: GuideSlug): Guide {
  const found = GUIDES.find((entry) => entry.slug === slug)
  if (!found) throw new Error(`No guide ${slug}`)
  return found
}

// --- review notes --------------------------------------------------------------------------

export type ReviewNote = {
  /** Named by `<EditorNote id>` on the page it belongs to. */
  id: string
  guide: GuideSlug
  /** `check`: a fact to confirm, fix or cut. `decide`: a choice for Joshua.
   * `tip`: a first-hand tip for Joshua to write, or to delete. */
  kind: "check" | "decide" | "tip"
  note: string
}

/**
 * What Joshua still has to review. Each entry shows on its page as a
 * "[Joshua: …]" box. To resolve one: fix the text around it, delete its
 * `<EditorNote id>` from the page and delete the entry here. A test fails
 * while this list is non-empty, so the guides cannot be merged unreviewed.
 */
export const REVIEW_NOTES: readonly ReviewNote[] = [
  // How to find and join societies
  {
    id: "join-fair-year",
    guide: "join-a-society",
    kind: "check",
    note: "The fair dates are 2026's (the SU has not published 2027's). Keep them as last year's example, or rephrase as 'usually the first two days of Full Term' before Michaelmas 2027.",
  },
  {
    id: "join-sports-fair-time",
    guide: "join-a-society",
    kind: "check",
    note: "Sports Fair: the Sports Service's public pages give only '5 October' (no year); the 2026 page now needs a login. The Monday, 12–5pm, Sports Centre detail comes from Pembroke's undated guide, which looks like 2024's (its college fair is on 'Tuesday 8th October'). Confirm or cut the time and place.",
  },
  {
    id: "join-counts",
    guide: "join-a-society",
    kind: "decide",
    note: "Counts differ by source: the SU says over 500 registered societies (Sept 2025), the 2026 fair page says 300+ at the fair, the Sports Service both 'more than 75' and 'more than 70' clubs (on its web pages and in its club guide). Each is cited where it is used; check the framing reads right.",
  },
  {
    id: "join-refreshers",
    guide: "join-a-society",
    kind: "check",
    note: "Refreshers' Fair: the only readable source is the SU's January 2024 article; no 2027 date is published and the SU's Refreshers pages have expired. Check with the SU, or cut the venue and hours.",
  },
  {
    id: "join-initiations",
    guide: "join-a-society",
    kind: "decide",
    note: "No current SU or University policy text on initiations was found, so the members' rights section states only what the SU terms say. Decide whether to say more, and from what source.",
  },
  {
    id: "join-postgrads",
    guide: "join-a-society",
    kind: "tip",
    note: "Postgraduates: no current public source on MCR or graduate fairs was found (the Grad Union site now redirects to the SU). Write what you know as a postgraduate, or cut this section.",
  },
  {
    id: "join-tip-week0",
    guide: "join-a-society",
    kind: "tip",
    note: "First-hand tip: how you went about the fairs in your first weeks (what worked, what you would skip). Or delete this box.",
  },
  {
    id: "join-tip-keeping",
    guide: "join-a-society",
    kind: "tip",
    note: "First-hand tip: how you chose which societies to keep going to after the first few weeks. Or delete this box.",
  },
  {
    id: "join-published",
    guide: "join-a-society",
    kind: "check",
    note: "Set `published` and `updated` in lib/guides.ts to the day this guide goes live.",
  },
  // How to start a society
  {
    id: "start-su-form",
    guide: "start-a-society",
    kind: "check",
    note: "The SU's registration form (cambridgesu.co.uk/surveys/232/) is probably behind a login; its fields, and whether it needs Raven, are unconfirmed. Check it and say what to have ready.",
  },
  {
    id: "start-su-renewal",
    guide: "start-a-society",
    kind: "check",
    note: "SU re-registration 'in June/July' comes from the Proctors' page only. The SU's own Society Re-registration page (/opportunities/support/handover/) gives no window, and its constitution template names a handover period of 1 July to 31 August. Check with the SU.",
  },
  {
    id: "start-jp-email",
    guide: "start-a-society",
    kind: "check",
    note: "The Junior Proctor's address differs: the Proctors' page and Notice 5 give junior.proctor@cam.ac.uk, the October 2026 Notes of Guidance juniorproctor@admin.cam.ac.uk. The guide uses the web page's.",
  },
  {
    id: "start-bank",
    guide: "start-a-society",
    kind: "tip",
    note: "SU finance accounts are closed to new applications, and no public source says which banks offer society accounts or what they ask for. Add what you know, or leave it as is.",
  },
  {
    id: "start-startup-grant",
    guide: "start-a-society",
    kind: "check",
    note: "Start-up Grant: the SU's finance page says up to £250; an older page described a £100 trial from Lent 2025. Recheck the amount before publishing.",
  },
  {
    id: "start-hub-notice",
    guide: "start-a-society",
    kind: "check",
    note: "SU Hub notice: the SU's room hire page says both 'at least 5 days' and 'at least 2 weeks'. The guide says two weeks to be safe; check with the SU.",
  },
  {
    id: "start-sports-club",
    guide: "start-a-society",
    kind: "check",
    note: "No public process for founding a new University sports club was found; the guide gives only the Sports Service's contact details.",
  },
  {
    id: "start-broker",
    guide: "start-a-society",
    kind: "decide",
    note: "Decide whether this guide mentions that you introduce societies to sponsors and partners (CAMsocs' private side), and how. It currently does not.",
  },
  {
    id: "start-tip-first-term",
    guide: "start-a-society",
    kind: "tip",
    note: "First-hand tip: what a new society should do in its first term to get its first members. Or delete this box.",
  },
  {
    id: "start-published",
    guide: "start-a-society",
    kind: "check",
    note: "Set `published` and `updated` in lib/guides.ts to the day this guide goes live.",
  },
]

/** The open review note with this id, if any. */
export function reviewNote(id: string): ReviewNote | undefined {
  return REVIEW_NOTES.find((note) => note.id === id)
}

/** True while any guide still has open review notes (the pages then say they
 * are drafts and ask not to be indexed). */
export function guidesInReview(): boolean {
  return REVIEW_NOTES.length > 0
}

// --- structured data -----------------------------------------------------------------------

/**
 * A guide's JSON-LD: an Article and its BreadcrumbList (Guides → the guide).
 * Article, not HowTo (Google retired HowTo rich results in 2023) and not
 * FAQPage (its rich results are limited to government and health sites).
 * The publisher is the person who runs CAMsocs; never the University, a
 * college or the SU.
 */
export function guideJsonLd(entry: Guide): Record<string, unknown> {
  const url = pageId(entry.path)
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        url,
        mainEntityOfPage: url,
        headline: entry.title,
        description: `${entry.description} ${DISCLAIMER}`,
        inLanguage: "en-GB",
        datePublished: entry.published,
        dateModified: entry.updated,
        isPartOf: { "@id": WEBSITE_ID },
        author: { "@id": PUBLISHER_ID },
        publisher: { "@id": PUBLISHER_ID },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        citation: entry.sources.map((id) => SOURCES[id].url),
      },
      breadcrumbList(entry.path, [
        { name: "Guides", path: GUIDES_PATH },
        { name: entry.title, path: entry.path },
      ]),
    ],
  }
}
