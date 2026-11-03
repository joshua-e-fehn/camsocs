import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { TrackView } from "@/components/molecules/track-view"
import { DirectoryHub } from "@/components/organisms/directory-hub"
import { OrgProfile } from "@/components/organisms/org-profile"
import { ProfileCamOnlyEvents } from "@/components/organisms/profile-cam-only-events"
import { api } from "@/convex/_generated/api"
import { DAY_MS, londonIsoDate, londonMidnight } from "@/lib/calendar"
import {
  collectionJsonLd,
  collegeHubIntro,
  collegeHubPath,
  groupByCategory,
} from "@/lib/directory-hubs"
import { isThinListing } from "@/lib/directory-indexing"
import {
  alternateNames,
  jsonLdEvents,
  profileLead,
  profileSources,
  societyJsonLd,
  societyTitle,
} from "@/lib/directory-profile"
import { withoutTalksCam } from "@/lib/directory-talks-guard"
import { collegeHubTitle, titleBase } from "@/lib/directory-title"
import { pageMetadata } from "@/lib/page-metadata"
import type { OrgPage } from "@/lib/public-api"
import { publicQuery } from "@/lib/public-data"
import { summary } from "@/lib/rich-text"
import { camSignInOpen } from "@/lib/sign-in-options"
import { jsonLdScript, organizationId } from "@/lib/structured-data"
import { isOrgSlug } from "@/lib/url-state"

type Props = { params: Promise<{ slug: string }> }

/** No profile is built with the site: each is rendered on its first request
 * and then served from the edge, revalidated as the (site) layout says
 * (docs/webapp.md "Caching"). An unknown slug is proxy.ts's 404 first. */
export function generateStaticParams(): { slug: string }[] {
  return []
}

/**
 * One read per render, shared by the metadata and the page. Anonymous, so the
 * page is the same for everyone and cached: a verified @cam.ac.uk reader's
 * Cambridge-only events are added in the browser (`ProfileCamOnlyEvents`).
 *
 * Everything from talks.cam is stripped first (owner decision G1,
 * lib/directory-talks-guard.ts): talks.cam-sourced events, talks.cam links
 * and sources. orgs.getBySlug already applies the same guard; this second
 * pass keeps the page safe on its own. This page is open to AI crawlers; talks.cam content stays
 * under /talks, which is not. So nothing below can render one, in the HTML,
 * the flight payload or the JSON-LD.
 */
const loadOrg = cache(async (slug: string): Promise<OrgPage | null> => {
  if (!isOrgSlug(slug)) return null
  const page = await publicQuery(api.orgs.getBySlug, { slug })
  return page ? withoutTalksCam(page) : null
})

/** The colleges (key, slug, name), once per render. */
const loadColleges = cache(async () => await publicQuery(api.orgs.colleges, {}))

/** A college's listings: its page is its hub (owner decision G13). */
const loadCollegeHub = cache(
  async (collegeKey: string) => await publicQuery(api.orgs.hub, { collegeKey }),
)

const isCollegeHub = (org: OrgPage["org"]) => org.isCounterpart && org.orgType === "college"

/** Upcoming public events: what a crawler sees, so the lead and indexing are
 * the same for every visitor. */
const publicEvents = (page: OrgPage) => page.events.filter((e) => e.visibility === "public")

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await loadOrg((await params).slug)
  // proxy.ts has already answered an unknown slug with a real 404
  // (lib/missing-listing.ts). This is the fallback — a listing hidden since
  // that check, or a check that failed — and, with no loading.tsx streaming
  // a shell first, it is a real 404 too.
  if (!page) notFound()
  const { org } = page
  const path = `/societies/${org.slug}`

  if (isCollegeHub(org)) {
    const cards = await loadCollegeHub(org.key)
    const title = collegeHubTitle(org.name)
    return {
      ...pageMetadata({ title, description: summary(collegeHubIntro(org.name, cards), 160), path }),
      // A college page lists its societies; one that lists none is empty.
      ...(cards.length === 0 ? { robots: { index: false, follow: true } } : {}),
    }
  }

  const colleges = await loadColleges()
  const { description } = profileLead({
    org,
    collegeNames: Object.fromEntries(colleges.map((college) => [college.key, college.name])),
    sessions: page.sessions,
    upcomingEvents: publicEvents(page).length,
  })
  const title = societyTitle(org)
  // The same test, on the same guarded projection, as orgs.sitemap.
  const thin = isThinListing(org, page.hasPublicEvents ?? publicEvents(page).length > 0)
  return {
    // `title` is already fitted (societyTitle): pageMetadata keeps an
    // `{ absolute }` as is and gives Open Graph the bare name.
    ...pageMetadata({ title, description, path }),
    // Owner decision G3: nothing to index until a description, an event or
    // a website arrives; links are still followed.
    ...(thin ? { robots: { index: false, follow: true } } : {}),
  }
}

const CAM_ONLY_WINDOW_DAYS = 180

/** The window of the profile's Cambridge-only hint and its browser top-up:
 * from the start of today (London), as `orgs.getBySlug`'s "Coming up". */
function camOnlyWindow(now: number) {
  const from = londonMidnight(londonIsoDate(now))
  return { from, to: from + CAM_ONLY_WINDOW_DAYS * DAY_MS }
}

/** How many Cambridge-only upcoming events a signed-out reader cannot see.
 * Null when the count is unavailable — the page must not fail over a hint. */
async function hiddenEventCount(orgKey: string, window: { from: number; to: number }) {
  try {
    const { camOnly } = await publicQuery(
      api.events.restrictedCount,
      // The profile never lists a talks.cam-derived event (G1), so the hint
      // does not count them either.
      { ...window, orgKey, talksCam: "exclude" },
    )
    return camOnly
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

/** Related listings for the profile; empty when they cannot be read — the
 * page must not fail over a list of suggestions. */
async function relatedOrgs(slug: string) {
  try {
    return await publicQuery(api.orgs.related, { slug, limit: 6 })
  } catch (error) {
    unstable_rethrow(error)
    return []
  }
}

function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
      dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }}
    />
  )
}

/** A college's own page as its hub (G13, college-counterpart-pages): its
 * listings by category, not an empty "claim this society" profile. */
async function CollegeHubPage({ page }: { page: OrgPage }) {
  const { org } = page
  const [cards, colleges] = await Promise.all([loadCollegeHub(org.key), loadColleges()])
  const collegeNames = Object.fromEntries(colleges.map((college) => [college.key, college.name]))
  const title = collegeHubTitle(org.name)
  const intro = collegeHubIntro(org.name, cards)
  const path = collegeHubPath(org)
  const jsonLd = collectionJsonLd({
    path,
    title,
    description: summary(intro, 300),
    items: cards.map((card) => ({ name: card.name, path: `/societies/${card.slug}` })),
    crumbs: [
      { name: "Societies", path: "/societies" },
      { name: org.name, path },
    ],
    // The college itself, as a place-bound Organization: never typed as a
    // CollegeOrUniversity, and nothing here speaks for it.
    about: {
      "@type": "Organization",
      "@id": organizationId(org.slug),
      name: org.name,
      url: org.website,
    },
  })
  const others = colleges.filter((college) => college.key !== org.key)
  return (
    <>
      <JsonLd data={jsonLd} />
      <TrackView event="society_viewed" props={{ orgKey: org.key, categories: org.categories }} />
      <DirectoryHub
        eyebrow="College"
        title={title}
        intro={intro}
        crumbs={[{ name: "Societies", href: "/societies" }, { name: org.name }]}
        sections={groupByCategory(cards).map((group) => ({
          id: `group-${group.category ?? "other"}`,
          title: group.label,
          cards: group.cards,
        }))}
        collegeNames={collegeNames}
        missingHref="/request?kind=add"
        missingText={`Missing a society at ${org.name}?`}
        aside={
          others.length > 0 && (
            <section aria-labelledby="other-colleges" className="flex flex-col gap-3">
              <h2 id="other-colleges" className="font-serif text-2xl font-medium tracking-tight">
                Other colleges
              </h2>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {others.map((college) => (
                  <li key={college.key}>
                    <Link
                      href={collegeHubPath(college)}
                      className="inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:min-h-8"
                    >
                      {college.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        }
      />
    </>
  )
}

export default async function SocietyPage({ params }: Props) {
  const page = await loadOrg((await params).slug)
  if (!page) notFound()
  const { org } = page
  if (isCollegeHub(org)) return <CollegeHubPage page={page} />

  const window = camOnlyWindow(Date.now())
  const [colleges, camSignIn, hiddenCount, related] = await Promise.all([
    loadColleges(),
    camSignInOpen(),
    hiddenEventCount(org.key, window),
    relatedOrgs(org.slug),
  ])
  // The count's prompt is a sign-in link: none while the link is off, as on
  // /events (ENG-35). A signed-in reader's own Cambridge-only events still
  // arrive in the browser (`ProfileCamOnlyEvents`).
  const hiddenEvents = camSignIn ? hiddenCount : null
  const collegeNames = Object.fromEntries(colleges.map((college) => [college.key, college.name]))
  const collegeSlugs = Object.fromEntries(colleges.map((college) => [college.key, college.slug]))
  const { lead, description } = profileLead({
    org,
    collegeNames,
    sessions: page.sessions,
    upcomingEvents: publicEvents(page).length,
  })
  const jsonLd = societyJsonLd({
    org,
    title: titleBase(societyTitle(org)),
    description,
    eventKeys: jsonLdEvents(page.events),
  })

  return (
    <>
      <JsonLd data={jsonLd} />
      <TrackView event="society_viewed" props={{ orgKey: org.key, categories: org.categories }} />
      <OrgProfile
        page={page}
        collegeNames={collegeNames}
        collegeSlugs={collegeSlugs}
        hiddenEvents={hiddenEvents}
        camOnly={
          <ProfileCamOnlyEvents
            orgKey={org.key}
            path={`/societies/${org.slug}`}
            window={window}
            hiddenEvents={hiddenEvents}
          />
        }
        related={related}
        lead={lead}
        alternate={alternateNames(org)}
        sources={profileSources(org.meta)}
      />
    </>
  )
}
