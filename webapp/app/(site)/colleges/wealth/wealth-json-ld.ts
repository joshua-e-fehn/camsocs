import {
  formatGbp,
  UNIVERSITY_ENDOWMENT,
  WEALTH_PATH,
  WEALTH_STUDENTS_SOURCE_URL,
} from "@/lib/college-wealth"
import {
  faqText,
  temporalCoverage,
  WEALTH_CRUMB,
  type WealthView,
  wealthDescription,
  wealthFaqs,
  wealthTitle,
} from "@/lib/college-wealth-view"
import { COLLEGES_PATH } from "@/lib/colleges"
import { collectionJsonLd, collegeHubPath } from "@/lib/directory-hubs"
import { SITE_NAME, SITE_URL } from "@/lib/site"
import { pageId } from "@/lib/structured-data"

/**
 * /colleges/wealth's JSON-LD (kept apart from the page so a test can read
 * it): the page, the ranking as an ordered list with each college's figure,
 * the breadcrumb, the dataset (with its CSV) and the questions, every value
 * from the same view the page renders (lib/college-wealth-view.ts).
 */

/** The CSV of the ranking (app/(site)/colleges/wealth.csv/route.ts). */
export const WEALTH_CSV_PATH = "/colleges/wealth.csv"

export function wealthJsonLd(view: WealthView): Record<string, unknown> {
  const title = wealthTitle(view)
  const description = wealthDescription(view)
  const base = collectionJsonLd({
    path: WEALTH_PATH,
    title,
    description,
    items: view.byEndowment.map((row) => ({
      name: `${row.college.name}: ${formatGbp(row.endowmentGbp)}`,
      path: collegeHubPath(row.college),
    })),
    crumbs: [
      { name: "Colleges", path: COLLEGES_PATH },
      { name: WEALTH_CRUMB, path: WEALTH_PATH },
    ],
  })
  const id = pageId(WEALTH_PATH)
  const [page, list, ...rest] = base["@graph"] as Record<string, unknown>[]
  const datasetName = `Cambridge college endowments ${view.financialYear}`
  const sources =
    view.basis === "verified"
      ? view.rows.map((row) => row.sourceUrl)
      : view.rows.map((row) => row.sourceRegisterUrl)
  const dataset = {
    "@type": "Dataset",
    "@id": `${id}#dataset`,
    url: id,
    isPartOf: { "@id": id },
    name: datasetName,
    description: `The investments on each of the ${view.rows.length} Cambridge colleges’ consolidated balance sheets at market value at the end of the ${view.financialYear} financial year, with net assets and total income${view.basis === "verified" ? " read from the accounts each college filed with the Charity Commission and cross-checked against the Charity Commission register" : " as filed in each college’s annual return on the Charity Commission register"}, and student headcount and endowment per student from the University’s student numbers by college.`,
    version: view.financialYear,
    datePublished: view.publishedOn,
    dateModified: view.updatedOn,
    // The accounts year; the student numbers are a separate variable.
    temporalCoverage: temporalCoverage(view),
    spatialCoverage: { "@type": "Place", name: "Cambridge, United Kingdom" },
    keywords: [
      "Cambridge colleges",
      "college endowments",
      "richest Cambridge college",
      "net assets",
      "endowment per student",
      "Charity Commission",
    ],
    inLanguage: "en-GB",
    isAccessibleForFree: true,
    license: `${SITE_URL}/terms`,
    creator: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "text/csv",
        contentUrl: pageId(WEALTH_CSV_PATH),
        name: `${datasetName} (CSV)`,
      },
    ],
    isBasedOn: [
      ...new Set([...sources, WEALTH_STUDENTS_SOURCE_URL, UNIVERSITY_ENDOWMENT.sourceUrl]),
    ],
    variableMeasured: [
      "Endowment (investments at market value)",
      "Net assets",
      "Total income",
      "Students (headcount)",
      "Endowment per student",
    ],
  }
  const faq = {
    "@type": "FAQPage",
    "@id": `${id}#faq`,
    isPartOf: { "@id": id },
    mainEntity: wealthFaqs(view).map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: faqText(entry.answer) },
    })),
  }
  return {
    ...base,
    "@graph": [
      {
        ...page,
        datePublished: view.publishedOn,
        dateModified: view.updatedOn,
        about: { "@type": "Thing", name: "Cambridge college endowments" },
      },
      { ...list, itemListOrder: "https://schema.org/ItemListOrderDescending" },
      ...rest,
      dataset,
      faq,
    ],
  }
}
