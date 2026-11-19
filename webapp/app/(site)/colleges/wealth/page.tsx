import type { Metadata } from "next"
import { WEALTH_PATH } from "@/lib/college-wealth"
import { loadWealthView } from "@/lib/college-wealth-data"
import { wealthDescription, wealthTitle } from "@/lib/college-wealth-view"
import { pageMetadata } from "@/lib/page-metadata"
import { CollegeWealthArticle } from "./wealth-article"

/**
 * The colleges ranked by endowment (ENG-272). The ranking shows the newest
 * financial year every college has an accepted figure for
 * (lib/college-finances.ts): the verified dataset (lib/data/college-wealth.json,
 * read from the 2024-25 accounts and cross-checked against the Charity
 * Commission register) until the pipeline's register data completes a later
 * year. Title, description and content all come from the same view
 * (lib/college-wealth-view.ts). Static: the only Convex reads are the
 * anonymous cached ones (lib/college-wealth-data.ts), and without them the
 * page renders the verified year.
 */

export async function generateMetadata(): Promise<Metadata> {
  const view = await loadWealthView()
  return pageMetadata({
    title: wealthTitle(view),
    description: wealthDescription(view),
    path: WEALTH_PATH,
  })
}

export default async function CollegeWealthPage() {
  return <CollegeWealthArticle view={await loadWealthView()} />
}
