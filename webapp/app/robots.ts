import type { MetadataRoute } from "next"
import { SITE_URL } from "@/lib/site"

/** Everything public may be crawled; the private broker area and the auth
 * endpoints may not (they hold nothing for a crawler anyway). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/api/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
