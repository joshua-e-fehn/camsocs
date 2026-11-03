import { llmsTxt } from "@/lib/llms-txt"

/** `/llms.txt` (lib/llms-txt.ts): built at build time and served statically,
 * so a fetch costs no function call (it was an uncached 404 render). */
export const dynamic = "force-static"

export function GET() {
  return new Response(llmsTxt(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
