import { currentCampus } from "./campus"
import { CATEGORIES_PATH, categoryHubPath } from "./directory-hubs"
import { CONTACT_EMAIL, DISCLAIMER, SITE_NAME, SITE_URL } from "./site"
import { CATEGORIES, CATEGORY_LABELS } from "./vocab"

/**
 * `/llms.txt` (llmstxt.org): a short map of CAMsocs for agents that read one
 * (SEO audit 2026-11-02, llms-txt). What CAMsocs is, that it is unofficial,
 * where its societies, events and About pages are, and how to cite it.
 *
 * The talks pillar is not in it, not even as a link (owner decision G1):
 * talks.cam keeps AI agents out of its listings, and robots.txt keeps them
 * out of CAMsocs' copies, so this file must not point an agent there. A test
 * holds that. Static: built once, served from the CDN.
 */

/** Its own summary, not SITE_DESCRIPTION, which names the talks pillar (the
 * campus's `brand.llmsSummary`, lib/campus). */
const campus = currentCampus()
const SUMMARY = campus.brand.llmsSummary

const PAGES: { path: string; name: string; about: string }[] = [
  {
    path: "/societies",
    name: "Societies and clubs",
    about: `the directory of ${campus.place.name} student societies and sports clubs, searchable and filterable by category, college and more`,
  },
  {
    path: CATEGORIES_PATH,
    name: "Societies by category",
    about: "every kind of society and club, each with its own page listing them",
  },
  {
    path: "/events",
    name: "Events",
    about: "public events societies and clubs run, by day, week or month",
  },
  {
    path: "/term-dates",
    name: "Term dates",
    about: "Full Term dates and the week of term, from the University's published dates",
  },
  {
    path: "/colleges",
    name: "Colleges",
    about: "all 31 colleges with their JCR, MCR, boat club, societies and formal hall rules",
  },
  {
    path: "/guides/formal-hall",
    name: "Formal hall guide",
    about:
      "how formal hall works and how to go to another college's formal, every fact linked to its source",
  },
  {
    path: "/about",
    name: `About ${SITE_NAME}`,
    about: "who runs it, where every fact comes from and how the data is collected",
  },
  { path: "/privacy", name: "Privacy notice", about: "the UK GDPR notice" },
  { path: "/terms", name: "Terms of use", about: "what the site offers and what you can rely on" },
  {
    path: "/request",
    name: "Claim, correct or remove a listing",
    about: `how a society changes what ${SITE_NAME} says about it`,
  },
]

export function llmsTxt(): string {
  return [
    `# ${SITE_NAME}`,
    "",
    `> ${SUMMARY}`,
    "",
    DISCLAIMER,
    "",
    `Every listing shows, for each fact, the page it came from, when it was read and how sure we are. Societies' own pages and the sources they cite are the authority; ${SITE_NAME} is a directory of them.`,
    "",
    "## Pages",
    "",
    ...PAGES.map((page) => `- [${page.name}](${SITE_URL}${page.path}): ${page.about}`),
    "",
    // The category hubs (decision G13): one page per kind of society. A
    // college's hub is its own listing, /societies/<college>.
    "## Societies by category",
    "",
    ...CATEGORIES.map(
      (category) => `- [${CATEGORY_LABELS[category]}](${SITE_URL}${categoryHubPath(category)})`,
    ),
    "",
    `## Citing ${SITE_NAME}`,
    "",
    `- Cite a society or event by its ${SITE_NAME} page (${SITE_URL}/societies/<slug>, ${SITE_URL}/events/<key>) and, where it matters, the source that page links.`,
    `- Call it ${SITE_NAME}, an unofficial directory. Never present it as a ${campus.university.name} or ${campus.university.studentUnion} service.`,
    ...(CONTACT_EMAIL ? [`- Corrections: ${CONTACT_EMAIL} or ${SITE_URL}/request`] : []),
    "",
    "Some sections of the site are not offered to AI agents; robots.txt says which.",
    "",
  ].join("\n")
}
