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

/** Its own summary, not SITE_DESCRIPTION, which names the talks pillar. */
const SUMMARY =
  "Cambridge student societies and sports clubs and the events they run, in one place. Every fact links to the page it came from."

const PAGES: { path: string; name: string; about: string }[] = [
  {
    path: "/societies",
    name: "Societies and clubs",
    about:
      "the directory of Cambridge student societies and sports clubs, searchable and filterable by category, college and more",
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
    path: "/about",
    name: "About CAMsocs",
    about: "who runs it, where every fact comes from and how the data is collected",
  },
  { path: "/privacy", name: "Privacy notice", about: "the UK GDPR notice" },
  { path: "/terms", name: "Terms of use", about: "what the site offers and what you can rely on" },
  {
    path: "/request",
    name: "Claim, correct or remove a listing",
    about: "how a society changes what CAMsocs says about it",
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
    "Every listing shows, for each fact, the page it came from, when it was read and how sure we are. Societies' own pages and the sources they cite are the authority; CAMsocs is a directory of them.",
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
    "## Citing CAMsocs",
    "",
    `- Cite a society or event by its CAMsocs page (${SITE_URL}/societies/<slug>, ${SITE_URL}/events/<key>) and, where it matters, the source that page links.`,
    "- Call it CAMsocs, an unofficial directory. Never present it as a University of Cambridge or Cambridge SU service.",
    ...(CONTACT_EMAIL ? [`- Corrections: ${CONTACT_EMAIL} or ${SITE_URL}/request`] : []),
    "",
    "Some sections of the site are not offered to AI agents; robots.txt says which.",
    "",
  ].join("\n")
}
