import { fetchQuery } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import type { MetadataRoute } from "next"
import { api } from "@/convex/_generated/api"
import { SITE_URL } from "@/lib/site"

/** Rendered per request: the directory changes with every harvest, and a
 * build has no data to read (it may compile against a placeholder backend). */
export const dynamic = "force-dynamic"

const PAGE = 100
/** Far above the directory's size (~1,500 groups); a stop, not a target. */
const MAX_PAGES = 50

const STATIC_ROUTES = [
  { path: "", changeFrequency: "daily", priority: 1 },
  { path: "/societies", changeFrequency: "daily", priority: 0.9 },
  { path: "/events", changeFrequency: "daily", priority: 0.9 },
  { path: "/about", changeFrequency: "monthly", priority: 0.5 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/request", changeFrequency: "yearly", priority: 0.3 },
] as const

/** Every directory listing (not counterparts, which the directory never
 * lists). If the backend cannot be read, the static pages still go out. */
async function listingSlugs(): Promise<string[]> {
  const slugs: string[] = []
  try {
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: FunctionReturnType<typeof api.orgs.list> = await fetchQuery(api.orgs.list, {
        paginationOpts: { numItems: PAGE, cursor },
      })
      slugs.push(...result.page.map((card) => card.slug))
      if (result.isDone) break
      cursor = result.continueCursor
    }
  } catch {
    // Fall through with what was read.
  }
  return slugs
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const slugs = await listingSlugs()
  return [
    ...STATIC_ROUTES.map((route) => ({
      url: `${SITE_URL}${route.path}`,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    })),
    ...slugs.map((slug) => ({
      url: `${SITE_URL}/societies/${slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ]
}
