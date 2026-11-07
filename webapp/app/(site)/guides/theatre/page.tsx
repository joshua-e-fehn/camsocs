import type { Metadata } from "next"
import Link from "next/link"
import { ProseSection } from "@/components/molecules/prose-section"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { ResearchedGuide } from "@/components/organisms/researched-guide"
import { linkProps } from "@/lib/crawl-traps"
import { categoryHubPath } from "@/lib/directory-hubs"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { loadCategoryEvents } from "@/lib/sport-events"
import { THEATRE_CHECKED_ON, THEATRE_SECTIONS } from "@/lib/tier2-guides"

/**
 * Student theatre and comedy (ENG-115): the stages, the societies, how to
 * get involved and the theatre year, from the ADC Theatre, the societies and
 * Camdram (lib/data/guides/theatre.json), with what is on soon from the
 * events CAMsocs already lists.
 */

const GUIDE = guide("theatre")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

const CLUBS: Record<string, readonly (readonly [string, string])[]> = {
  "the-scene": [["amateur-dramatic-club", "CUADC"]],
  "main-societies": [
    ["amateur-dramatic-club", "CUADC"],
    ["footlights-dramatic-club-cambridge", "Footlights"],
    ["cambridge-university-musical-theatre-society", "CUMTS"],
    ["marlowe-society", "Marlowe Society"],
    ["european-theatre-group", "European Theatre Group"],
    ["cambridge-university-gilbert-and-sullivan-society", "Gilbert and Sullivan Society"],
    ["pembroke-players", "Pembroke Players"],
    ["corpus-christi-college-the-fletcher-players-society", "Fletcher Players"],
    ["downing-dramatic-society", "Downing Dramatic Society"],
    ["queens-college-bats", "BATS"],
    ["brickhouse-theatre-company", "Brickhouse"],
  ],
  "getting-involved": [
    ["cambridge-impronauts", "Impronauts"],
    ["footlights-dramatic-club-cambridge", "Footlights"],
  ],
}

export default async function TheatreGuide() {
  const now = Date.now()
  const events = await loadCategoryEvents(now, "theatre_film_dance", 21)
  const onStage = (events ?? [])
    .filter((event) => !event.cancelled && !event.talksDerived)
    .filter((event) => (event.endsAt ?? event.startsAt) >= now)
    .slice(0, 10)
  return (
    <ResearchedGuide
      guide={GUIDE}
      sections={THEATRE_SECTIONS}
      checkedOn={THEATRE_CHECKED_ON}
      clubs={CLUBS}
      names={{ "cambridgefootlights.org": "Footlights" }}
      lede={
        <>
          Cambridge puts on dozens of student shows a term, most of them at the ADC Theatre, and
          anyone can audition, work backstage or pitch a show. Here is how it works, and the
          societies to know.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Find a company</h2>
          <p className="text-muted-foreground">
            Every theatre, film and dance society CAMsocs lists.
          </p>
          <Link
            href={categoryHubPath("theatre_film_dance")}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Theatre, film and dance
          </Link>
        </div>
      }
    >
      {() =>
        onStage.length > 0 && (
          <ProseSection id="on-soon" title="On soon, from CAMsocs’ listings">
            <UpcomingEventList events={onStage} empty="" />
            <p>
              <Link {...linkProps("/events?cat=theatre_film_dance")}>
                Everything on in theatre, film and dance
              </Link>
            </p>
          </ProseSection>
        )
      }
    </ResearchedGuide>
  )
}
