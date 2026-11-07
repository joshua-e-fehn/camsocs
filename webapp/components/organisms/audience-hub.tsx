import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { DirectoryHub } from "@/components/organisms/directory-hub"
import { api } from "@/convex/_generated/api"
import { type AudiencePage, audienceIntro, unionCards } from "@/lib/audience-hubs"
import { collectionJsonLd, groupByCategory } from "@/lib/directory-hubs"
import { publicQuery } from "@/lib/public-data"
import { jsonLdScript } from "@/lib/structured-data"

/**
 * A "Societies for …" page (lib/audience-hubs.ts, ENG-118): the union of the
 * page's hub reads, grouped by category like a college's page, with how the
 * list is made and the related guides. Cached reads only (ISR).
 */
export async function AudienceHub({ page }: { page: AudiencePage }) {
  let lists: Awaited<ReturnType<typeof publicQuery<typeof api.orgs.hub>>>[] = []
  let colleges: { key: string; name: string }[] = []
  let failed = false
  try {
    ;[lists, colleges] = await Promise.all([
      Promise.all(page.queries.map((query) => publicQuery(api.orgs.hub, query))),
      publicQuery(api.orgs.colleges, {}),
    ])
  } catch (error) {
    unstable_rethrow(error)
    console.error(`orgs.hub failed; ${page.path} without listings`, error)
    failed = true
  }
  const cards = unionCards(lists)
  // A failed read must not look like an empty list, nor be indexed as one.
  const intro = failed
    ? `The list of societies for ${page.who} could not be loaded right now. Please try again in a few minutes.`
    : audienceIntro(page, cards)
  const jsonLd = collectionJsonLd({
    path: page.path,
    title: page.title,
    description: intro,
    items: cards.map((card) => ({ name: card.name, path: `/societies/${card.slug}` })),
    crumbs: [
      { name: "Societies", path: "/societies" },
      { name: page.title, path: page.path },
    ],
  })
  return (
    <>
      {failed && <meta name="robots" content="noindex, follow" />}
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <DirectoryHub
        eyebrow={`For ${page.who}`}
        title={page.title}
        intro={intro}
        crumbs={[{ name: "Societies", href: "/societies" }, { name: `For ${page.who}` }]}
        sections={groupByCategory(cards).map((group) => ({
          id: `group-${group.category ?? "other"}`,
          title: group.label,
          cards: group.cards,
        }))}
        collegeNames={Object.fromEntries(colleges.map((college) => [college.key, college.name]))}
        missingHref="/request?kind=add"
        missingText={`Know a society for ${page.who} that is missing?`}
        aside={
          <section aria-labelledby="related" className="flex flex-col gap-3">
            <h2 id="related" className="font-serif text-2xl font-medium tracking-tight">
              Related guides
            </h2>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {page.related.map(([href, label]) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="inline-flex min-h-11 items-center underline underline-offset-4 sm:min-h-8"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        }
      />
    </>
  )
}
