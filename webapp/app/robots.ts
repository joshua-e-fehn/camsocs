import type { MetadataRoute } from "next"
import { AI_CRAWLERS } from "@/lib/crawlers"
import { SITE_URL } from "@/lib/site"

/** Paths no crawler needs: the private broker area, the auth endpoints and
 * the sign-in page (they hold nothing for a crawler). */
const PRIVATE = ["/dashboard", "/api/", "/sign-in"]

/** Training crawlers kept off the whole site (also denied by the Vercel
 * firewall rule in ops/vercel/training-crawlers.json): their repeated hits on
 * the events page used most of the Fluid CPU allowance. */
const SITE_BLOCKED: readonly string[] = ["GPTBot", "ClaudeBot"]

/** Everything public may be crawled, except the talks pillar by AI crawlers
 * and the whole site by SITE_BLOCKED.
 * A crawler that matches a named group ignores the `*` group, so that group
 * repeats the private paths. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      { userAgent: [...SITE_BLOCKED], disallow: "/" },
      {
        userAgent: AI_CRAWLERS.filter((agent) => !SITE_BLOCKED.includes(agent)),
        allow: "/",
        disallow: [...PRIVATE, "/talks"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
