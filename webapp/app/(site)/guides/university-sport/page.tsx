import type { Metadata } from "next"
import Link from "next/link"
import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { ResearchedGuide } from "@/components/organisms/researched-guide"
import { categoryHubPath } from "@/lib/directory-hubs"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { SPORT_CHECKED_ON, SPORT_CLUBS, SPORT_SECTIONS } from "@/lib/tier2-guides"

/**
 * University sport (ENG-114): clubs and college teams, trials, Give It a Go,
 * Blues, the Hawks and the Ospreys, costs and facilities, from the Sports
 * Service, the Hawks' Club and the clubs' own pages
 * (lib/data/guides/university-sport.json).
 */

const GUIDE = guide("university-sport")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

const CLUBS: Record<string, readonly (readonly [string, string])[]> = {
  "hawks-and-ospreys": [
    ["the-hawks-club", "The Hawks' Club"],
    ["the-ospreys", "The Ospreys"],
  ],
}

export default function UniversitySportGuide() {
  const clubSection = {
    id: "clubs",
    title: "How some clubs take new members",
    paragraphs: SPORT_CLUBS.map((club) => ({ text: club.note, sources: club.sources })),
  }
  return (
    <ResearchedGuide
      guide={GUIDE}
      sections={SPORT_SECTIONS}
      extraSections={[clubSection]}
      checkedOn={SPORT_CHECKED_ON}
      clubs={CLUBS}
      lede={
        <>
          Cambridge has more than 75 University sports clubs and teams in every college, for
          beginners as well as internationals. Here is how to join, how trials work, what Blues are,
          and what it costs.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Find a club</h2>
          <p className="text-muted-foreground">Every sports club CAMsocs lists, with its events.</p>
          <Link
            href={categoryHubPath("sport")}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Sport and fitness clubs
          </Link>
          <Link
            href="/guides/varsity"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Varsity against Oxford
          </Link>
          <Link
            href="/guides/rowing"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Rowing and the Bumps
          </Link>
        </div>
      }
    >
      {(sources) => (
        <ProseSection id="clubs" title="How some clubs take new members">
          <p>What a few University clubs say about trials and beginners on their own pages.</p>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
            {SPORT_CLUBS.map((club) => (
              <div key={club.slug} className="contents">
                <dt className="font-medium text-foreground">
                  <Link href={`/societies/${club.slug}`}>{club.name}</Link>
                </dt>
                <dd>
                  {club.note}
                  {club.sources.slice(0, 1).map((url) => {
                    const source = sources.find((s) => s.url === url)
                    return source ? <Cite key={url} source={source} /> : null
                  })}
                </dd>
              </div>
            ))}
          </dl>
        </ProseSection>
      )}
    </ResearchedGuide>
  )
}
