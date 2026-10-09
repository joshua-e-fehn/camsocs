import type { MetadataRoute } from "next"
import { SITE_URL } from "@/lib/site"

/** Everything public may be crawled; the private broker area, the auth
 * endpoints and the sign-in page may not (they hold nothing for a crawler). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/dashboard", "/api/", "/sign-in"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
