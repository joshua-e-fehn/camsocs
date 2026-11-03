import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import { CategoryLinks } from "@/components/molecules/category-links"
import { DirectoryHub } from "@/components/organisms/directory-hub"
import { api } from "@/convex/_generated/api"
import {
  CATEGORIES_PATH,
  categoryFromSlug,
  categoryHubIntro,
  categoryHubPath,
  categorySlug,
  collectionJsonLd,
} from "@/lib/directory-hubs"
import { categoryHubTitle } from "@/lib/directory-title"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { summary } from "@/lib/rich-text"
import { jsonLdScript } from "@/lib/structured-data"
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/vocab"

type Props = { params: Promise<{ category: string }> }

/** Every hub is built with the site: the 16 slugs are a fixed vocabulary
 * (lib/vocab.ts), unlike the other dynamic segments' keys. Each is then served
 * from the edge, revalidated as the (site) layout says (docs/webapp.md
 * "Caching"). */
export function generateStaticParams(): { category: string }[] {
  return CATEGORIES.map((category) => ({ category: categorySlug(category) }))
}

/**
 * Any other slug never reaches this page (re-check 2026-11-03,
 * not-found-template): Next answers it as an unmatched URL, with
 * app/not-found.tsx's static 404 in the site frame, served from the edge.
 * A `notFound()` here instead sends the empty error shell
 * (lib/missing-listing.ts). Where the hubs were not built (a placeholder or
 * failed-read build, `next dev` before a first request) the page still
 * answers an unknown slug with `notFound()` below.
 */
export const dynamicParams = false

/** The hub's data, once per render for the metadata and the page. An
 * unknown slug is null (no Convex call); the 16 slugs are fixed. */
const loadHub = cache(async (slug: string) => {
  const category = categoryFromSlug(slug)
  if (!category) return null
  const [cards, colleges] = await Promise.all([
    publicQuery(api.orgs.hub, { category }),
    publicQuery(api.orgs.colleges, {}),
  ])
  return { category, cards, colleges }
})

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const hub = await loadHub((await params).category)
  if (!hub) notFound()
  const title = categoryHubTitle(hub.category)
  return {
    ...pageMetadata({
      title,
      description: summary(categoryHubIntro(hub.category, hub.cards), 160),
      path: categoryHubPath(hub.category),
    }),
  }
}

/**
 * A category hub (SEO audit 2026-11-02, no-category-college-hubs, owner
 * decision G13): every listing in the category on one self-canonical page,
 * those across Cambridge first, then those in colleges. `/societies?cat=`
 * with this one category names this page as its canonical.
 */
export default async function CategoryHubPage({ params }: Props) {
  const hub = await loadHub((await params).category)
  if (!hub) notFound()
  const { category, cards, colleges } = hub
  const collegeNames = Object.fromEntries(colleges.map((college) => [college.key, college.name]))
  const title = categoryHubTitle(category)
  const intro = categoryHubIntro(category, cards)
  const path = categoryHubPath(category)
  const label = CATEGORY_LABELS[category]
  // One trail for the visible breadcrumbs and the BreadcrumbList, so the
  // two never differ.
  const crumbs = [
    { name: "Societies", path: "/societies" },
    { name: "Categories", path: CATEGORIES_PATH },
    { name: label, path },
  ]
  const jsonLd = collectionJsonLd({
    path,
    title,
    description: summary(intro, 300),
    items: cards.map((card) => ({ name: card.name, path: `/societies/${card.slug}` })),
    crumbs,
  })

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <DirectoryHub
        eyebrow="Category"
        title={title}
        intro={intro}
        crumbs={crumbs.map((crumb, index) =>
          index === crumbs.length - 1
            ? { name: crumb.name }
            : { name: crumb.name, href: crumb.path },
        )}
        sections={[
          {
            id: "across-cambridge",
            title: "Across Cambridge",
            cards: cards.filter((card) => card.collegeKeys.length === 0),
          },
          {
            id: "in-colleges",
            title: "In colleges",
            cards: cards.filter((card) => card.collegeKeys.length > 0),
          },
        ]}
        collegeNames={collegeNames}
        missingHref="/request?kind=add"
        missingText={`Missing a ${label} group?`}
        aside={
          <section aria-labelledby="other-categories" className="flex flex-col gap-4">
            <h2 id="other-categories" className="font-serif text-2xl font-medium tracking-tight">
              Other categories
            </h2>
            <CategoryLinks current={category} />
          </section>
        }
      />
    </>
  )
}
