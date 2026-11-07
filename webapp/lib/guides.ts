import { DISCLAIMER } from "./site"
import { breadcrumbList, PUBLISHER_ID, pageId, WEBSITE_ID } from "./structured-data"

/**
 * The guides (`/guides`, `/guides/<slug>`): plain editorial pages that answer
 * recurring Cambridge questions (ENG-105). One rule holds them honest: every
 * fact a page states links the public page it comes from, and the page lists
 * its sources with the date they were read. A fact without a source is not
 * written. The guides are unofficial (DISCLAIMER): they sum up what colleges,
 * the SU and the University publish, and never speak for any of them.
 *
 * The join-a-society and start-a-society drafts (PR #46, ENG-106) join this
 * list once their review notes are settled.
 */

export type GuideSlug =
  | "join-a-society"
  | "start-a-society"
  | "formal-hall"
  | "may-balls"
  | "rowing"
  | "varsity"
  | "glossary"
  | "university-sport"
  | "theatre"
  | "postgraduates"

export type GuideSource = {
  /** Who published it, short: shown inline as the citation. */
  publisher: string
  /** What the page or document is. */
  title: string
  url: string
  /** `YYYY-MM-DD`: when it was read for the guide. */
  retrieved: string
}

export type Guide = {
  slug: GuideSlug
  path: `/guides/${GuideSlug}`
  /** The page's name and h1; the `<title>` adds " · CAMsocs" while it fits. */
  title: string
  /** Meta description, at most 155 characters (a test holds it). */
  description: string
  /** One line for the guides index and llms.txt. */
  summary: string
  /** `YYYY-MM-DD`: when the page first went live (Article `datePublished`). */
  published: string
  /** `YYYY-MM-DD`: when its facts were last checked (Article `dateModified`). */
  updated: string
}

export const GUIDES_PATH = "/guides"
export const GUIDES_TITLE = "Guides to student life in Cambridge"
export const GUIDES_DESCRIPTION =
  "Plain guides for Cambridge students: societies, formal hall, May Balls, sport, theatre, postgraduate life and a glossary. Unofficial; every fact links its source."

export const GUIDES: readonly Guide[] = [
  {
    slug: "join-a-society",
    path: "/guides/join-a-society",
    title: "How to find and join societies in Cambridge",
    description:
      "How to find and join Cambridge student societies and sports clubs: the Freshers' and Sports Fairs, joining later in the year, costs, and where to get help.",
    summary:
      "The fairs at the start of the year, what to do if you missed them, sport, mailing lists, costs, and where to go if something goes wrong.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "start-a-society",
    path: "/guides/start-a-society",
    title: "How to start a society in Cambridge",
    description:
      "How to start a student society in Cambridge: registering with Cambridge SU, the Junior Proctor or your college, a constitution, money, rooms and events.",
    summary:
      "Checking it does not exist yet, the three ways to register, a constitution, a bank account and grants, rooms and events, and keeping it going.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "formal-hall",
    path: "/guides/formal-hall",
    title: "Formal hall in Cambridge: a guide for every college",
    description:
      "How formal hall works in Cambridge, how to go to another college's formal, and each of the 31 colleges' rules on guests, gowns and booking.",
    summary:
      "What formal hall is, how to get into another college's formal (a host or a swap), gowns and dress, and the rules of all 31 colleges.",
    published: "2026-11-07",
    updated: "2026-11-07",
  },
  {
    slug: "may-balls",
    path: "/guides/may-balls",
    title: "May Balls in Cambridge: dates, tickets and every college",
    description:
      "Every Cambridge May Ball and June Event: 2027 dates, how tickets and worker tickets work, and dress codes, each linked to the ball's own site.",
    summary:
      "What May Week is, ball or June Event, how tickets and worker tickets work, dress codes, and each college's ball for 2027.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "rowing",
    path: "/guides/rowing",
    title: "Rowing in Cambridge: Bumps, Fairbairns and the Boat Race",
    description:
      "How Cambridge rowing works: college boat clubs and novices, Fairbairns, Lent and May Bumps explained, the Boat Race, and the races coming up.",
    summary:
      "College boat clubs and novice rowing, how bumps racing works, Fairbairns, the University squads and the Boat Race, with the races coming up.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "varsity",
    path: "/guides/varsity",
    title: "Varsity in Cambridge: Oxford fixtures and the ski trip",
    description:
      "Cambridge v Oxford: the Boat Race, the Varsity Match and other Varsity fixtures, the Varsity ski trip, and how to watch, with this season's dates.",
    summary:
      "What Varsity means, Blues, the Boat Race, the rugby Varsity Match and other fixtures, the Varsity ski trip, and the fixtures coming up.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "university-sport",
    path: "/guides/university-sport",
    title: "University sport in Cambridge: trials, Blues and the Hawks",
    description:
      "How to play sport at Cambridge: University clubs and college teams, trials and beginners, Cuppers, Full and Half Blues, the Hawks' Club and the facilities.",
    summary:
      "University clubs and college teams, how trials work, beginners, Cuppers, what Blues and Half Blues are, and the facilities.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "theatre",
    path: "/guides/theatre",
    title: "Student theatre and comedy in Cambridge: ADC and Footlights",
    description:
      "Student theatre and comedy in Cambridge: the ADC Theatre, Footlights and drama societies, auditions on Camdram, backstage roles and pitching a show.",
    summary:
      "The ADC and other stages, the main drama and comedy societies, auditions, backstage roles, putting on your own show, and tickets.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "postgraduates",
    path: "/guides/postgraduates",
    title: "Postgraduate life in Cambridge: colleges, MCRs and support",
    description:
      "For new MPhil and PhD students: how department and college fit together, graduate colleges, the MCR and your Tutor, the SU, supervision, welfare and money.",
    summary:
      "Department and college, graduate colleges, the MCR and your Tutor, the SU, terms and supervision, social life, welfare and money.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
  {
    slug: "glossary",
    path: "/guides/glossary",
    title: "Cambridge words explained: a student glossary",
    description:
      "What Cambridge words mean: Full Term, Tripos, supervisions, bedders, the Porters' Lodge, JCR and MCR, formals, May Week and Blues, each with its source.",
    summary:
      "An A–Z of the words Cambridge students meet, from bedder and buttery to Tripos and Week 5, each linked to its source.",
    published: "2026-11-08",
    updated: "2026-11-08",
  },
]

export function guide(slug: GuideSlug): Guide {
  const found = GUIDES.find((entry) => entry.slug === slug)
  if (!found) throw new Error(`No guide ${slug}`)
  return found
}

/**
 * A guide's JSON-LD: an Article and its BreadcrumbList (Guides → the guide).
 * Article, not HowTo (Google retired HowTo rich results in 2023) and not
 * FAQPage (its rich results are limited to government and health sites).
 * The publisher is the person who runs CAMsocs; never the University, a
 * college or the SU.
 */
export function guideJsonLd(
  entry: Guide,
  sources: readonly GuideSource[],
): Record<string, unknown> {
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
        citation: [...new Set(sources.map((source) => source.url))],
      },
      breadcrumbList(entry.path, [
        { name: "Guides", path: GUIDES_PATH },
        { name: entry.title, path: entry.path },
      ]),
    ],
  }
}
