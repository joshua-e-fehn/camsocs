import {
  BY_ENDOWMENT,
  COLLEGE_WEALTH,
  formatGbp,
  UNIVERSITY_ENDOWMENT,
  WEALTH_CHECKED_ON,
  WEALTH_FINANCIAL_YEAR,
  WEALTH_PATH,
  WEALTH_STUDENTS_SOURCE_URL,
  WEALTH_TOTALS,
} from "@/lib/college-wealth"
import { COLLEGES_PATH } from "@/lib/colleges"
import { collectionJsonLd, collegeHubPath } from "@/lib/directory-hubs"
import { SITE_NAME, SITE_URL } from "@/lib/site"
import { pageId } from "@/lib/structured-data"

/** The /colleges/wealth title, description and JSON-LD (kept apart from the page so a test can read them). */

export const WEALTH_TITLE = "Richest Cambridge colleges: endowments ranked"
export const WEALTH_CRUMB = "Ranked by endowment"

const { total, richest, richestShare } = WEALTH_TOTALS
export const WEALTH_SHARE_PCT = `${(richestShare * 100).toFixed(1)}%`

export const WEALTH_DESCRIPTION = `${richest.college.shortName} held ${formatGbp(richest.endowmentGbp)} in long-term investments at the end of ${WEALTH_FINANCIAL_YEAR}, ${WEALTH_SHARE_PCT} of the ${formatGbp(total)} on all ${COLLEGE_WEALTH.length} Cambridge colleges’ balance sheets. Every college ranked, from its filed accounts.`

export function wealthJsonLd(): Record<string, unknown> {
  const base = collectionJsonLd({
    path: WEALTH_PATH,
    title: WEALTH_TITLE,
    description: WEALTH_DESCRIPTION,
    items: BY_ENDOWMENT.map((row) => ({ name: row.name, path: collegeHubPath(row.college) })),
    crumbs: [
      { name: "Colleges", path: COLLEGES_PATH },
      { name: WEALTH_CRUMB, path: WEALTH_PATH },
    ],
  })
  const id = pageId(WEALTH_PATH)
  const dataset = {
    "@type": "Dataset",
    "@id": `${id}#dataset`,
    url: id,
    isPartOf: { "@id": id },
    name: `Cambridge college endowments ${WEALTH_FINANCIAL_YEAR}`,
    description: `The investments on each of the ${COLLEGE_WEALTH.length} Cambridge colleges’ consolidated balance sheets at market value at the end of the ${WEALTH_FINANCIAL_YEAR} financial year, with net assets and total income read from the accounts each college filed with the Charity Commission (or, for some colleges’ income, its annual return), and student headcount and endowment per student from the University’s student numbers by college.`,
    // Accounts year 1 July 2024 – 31 July 2025; student numbers are 2025-26.
    temporalCoverage: "2024-07-01/2026-07-31",
    dateModified: WEALTH_CHECKED_ON,
    inLanguage: "en-GB",
    isAccessibleForFree: true,
    license: `${SITE_URL}/terms`,
    creator: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
    isBasedOn: [
      ...new Set([
        ...COLLEGE_WEALTH.map((row) => row.sourceUrl),
        WEALTH_STUDENTS_SOURCE_URL,
        UNIVERSITY_ENDOWMENT.sourceUrl,
      ]),
    ],
    variableMeasured: [
      "Endowment (investments at market value)",
      "Net assets",
      "Total income",
      "Students (headcount)",
      "Endowment per student",
    ],
  }
  const graph = base["@graph"] as Record<string, unknown>[]
  return { ...base, "@graph": [...graph, dataset] }
}
