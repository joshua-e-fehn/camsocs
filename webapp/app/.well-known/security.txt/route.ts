import { securityTxt } from "@/lib/security-txt"

/** `/.well-known/security.txt` (RFC 9116): built once, at build time. */
export const dynamic = "force-static"

export function GET(): Response {
  return new Response(securityTxt(), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
