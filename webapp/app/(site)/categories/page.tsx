import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { CategoryLinks } from "@/components/molecules/category-links"
import { api } from "@/convex/_generated/api"
import { CATEGORIES_PATH, categoryHubPath, collectionJsonLd } from "@/lib/directory-hubs"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { jsonLdScript } from "@/lib/structured-data"
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/vocab"

const TITLE = "Cambridge societies and clubs by category"
const DESCRIPTION =
  "Every category of Cambridge student society and club CAMsocs lists, from sport and music to faith, politics and volunteering, each with its own page of listings."

export const metadata: Metadata = {
  ...pageMetadata({ title: TITLE, description: DESCRIPTION, path: CATEGORIES_PATH }),
}

/** Listings per category; null when they cannot be read — the index still
 * links every hub. */
async function loadCounts(): Promise<Record<string, number> | null> {
  try {
    return (await publicQuery(api.orgs.facets, {})).categories
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

/**
 * The index of category hubs (no-category-college-hubs): one link to each,
 * with its count, so every hub is two hops from anywhere on the site.
 */
export default async function CategoriesPage() {
  const counts = await loadCounts()
  const jsonLd = collectionJsonLd({
    path: CATEGORIES_PATH,
    title: TITLE,
    description: DESCRIPTION,
    items: CATEGORIES.map((category) => ({
      name: CATEGORY_LABELS[category],
      path: categoryHubPath(category),
    })),
    crumbs: [
      { name: "Societies", path: "/societies" },
      { name: "Categories", path: CATEGORIES_PATH },
    ],
  })
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 pt-8 pb-6 sm:px-6 sm:pt-12">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            The directory
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Cambridge societies by category
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            Sixteen categories; a society can sit in more than one. Each page lists every society
            and club in it, across Cambridge and in the colleges.
          </p>
        </div>
      </header>
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
        <CategoryLinks counts={counts ?? undefined} />
      </div>
    </>
  )
}
