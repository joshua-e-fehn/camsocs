import type { Metadata } from "next"
import Link from "next/link"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { ResearchedGuide } from "@/components/organisms/researched-guide"
import { COLLEGES_PATH, collegeInfo } from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { GRADUATE_COLLEGES, POSTGRAD_CHECKED_ON, POSTGRAD_SECTIONS } from "@/lib/postgraduates"

/**
 * Postgraduate life (ENG-116): for new MPhil and PhD students, from the
 * University's postgraduate pages, Cambridge SU and the colleges
 * (lib/data/guides/postgraduates.json), with the colleges for postgraduates
 * and mature students linked to their CAMsocs pages.
 */

const GUIDE = guide("postgraduates")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

const CLUBS: Record<string, readonly (readonly [string, string])[]> = {
  "social-life": [
    ["graduate-orchestra", "Graduate Orchestra"],
    ["black-postgraduate-society-cambridge", "Black Postgraduate Society"],
    ["christian-graduate-society", "Christian Graduate Society"],
    ["graduate-law-society-cambridge", "Graduate Law Society"],
  ],
}

export default function PostgraduatesGuide() {
  const collegesSection = {
    id: "graduate-colleges",
    title: "Colleges for postgraduates",
    paragraphs: GRADUATE_COLLEGES.map((c) => ({ text: c.detail, sources: c.sources })),
  }
  return (
    <ResearchedGuide
      guide={GUIDE}
      sections={POSTGRAD_SECTIONS}
      extraSections={[collegesSection]}
      checkedOn={POSTGRAD_CHECKED_ON}
      clubs={CLUBS}
      lede={
        <>
          Starting an MPhil or a PhD in Cambridge means joining a department for your course and a
          college for everything else. Here is how the two fit together, what your MCR and Tutor do,
          and where to get support.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Your college and MCR</h2>
          <p className="text-muted-foreground">
            Every college’s CAMsocs page links its MCR and lists its formal hall rules.
          </p>
          <Link
            href={COLLEGES_PATH}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            All colleges
          </Link>
          <Link
            href="/guides/formal-hall"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Formal hall and swaps
          </Link>
        </div>
      }
    >
      {(sources) => (
        <ProseSection id="graduate-colleges" title="Colleges for postgraduates">
          <p>
            Most colleges take both undergraduates and postgraduates. These take only postgraduates
            or, for undergraduates, only mature students (21 or over).
          </p>
          <ul className="!list-none !pl-0">
            {GRADUATE_COLLEGES.map((entry) => {
              const college = collegeInfo(entry.collegeKey)
              if (!college) return null
              return (
                <li key={entry.collegeKey} className="flex items-start gap-3">
                  <CollegeCrest crest={college.crest} size={32} decorative />
                  <span>
                    <Link href={collegeHubPath(college)}>{college.name}</Link>: {entry.who}.{" "}
                    {entry.detail}
                    {entry.sources.slice(0, 1).map((url) => {
                      const source = sources.find((s) => s.url === url)
                      return source ? <Cite key={url} source={source} /> : null
                    })}
                  </span>
                </li>
              )
            })}
          </ul>
        </ProseSection>
      )}
    </ResearchedGuide>
  )
}
