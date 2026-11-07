import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react"
import { renderToString } from "react-dom/server"
import { camOnlyEvents, ProfileCamOnlyEvents } from "@/components/organisms/profile-cam-only-events"
import { belongsHere, RestrictedEvent } from "@/components/organisms/restricted-event"
import { isTalkAddress } from "./not-found-variant"

/**
 * The edge cache of the public site (SEO audit 2026-11-02, no-cdn-cache;
 * docs/webapp.md "Caching"). A public page is cacheable only while nothing
 * on its way reads the request and every Convex read is the anonymous cached
 * one. One `headers()` in the root not-found, one `getToken()` in a layout,
 * one direct `fetchQuery` in a page — each type-checks, builds and renders,
 * and quietly turns the page (or every page) back into a function call per
 * view. These checks fail instead.
 */

const WEBAPP = path.join(import.meta.dir, "..")

function read(file: string): string {
  return readFileSync(path.join(WEBAPP, file), "utf8")
}

/** The code of a module without its comments (which may name what it avoids). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(WEBAPP, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...files(relative))
    else if (/\.tsx?$/.test(entry.name) && !/\.test(ing)?\.tsx?$/.test(entry.name)) {
      out.push(relative)
    }
  }
  return out
}

/** Reads the request: any of these in a module makes its route dynamic. */
const READS_REQUEST =
  /from "next\/headers"|@\/lib\/auth-server|\bgetToken\s*\(|\bheaders\s*\(\)|\bcookies\s*\(\)/
/** A Convex read that bypasses the anonymous cache (`no-store`). */
const UNCACHED_READ = /\b(?:fetchQuery|preloadQuery)\s*\(/

const SITE = path.join("app", "(site)")
/** Share cards are image routes with their own `Cache-Control` (app/_og). */
const isShareCard = (file: string) => /opengraph-image\.tsx$/.test(file)

describe("what every page renders", () => {
  for (const file of ["app/layout.tsx", "app/not-found.tsx", "app/(site)/layout.tsx"]) {
    test(`${file} reads no request`, () => {
      expect(code(read(file))).not.toMatch(READS_REQUEST)
    })
  }
})

describe("public pages", () => {
  const pages = files(SITE).filter((file) => !isShareCard(file))

  test("the scan sees the pages it guards", () => {
    expect(pages).toContain(path.join(SITE, "page.tsx"))
    expect(pages).toContain(path.join(SITE, "societies", "[slug]", "page.tsx"))
    expect(pages).toContain(path.join(SITE, "site-frame.tsx"))
  })

  for (const file of [
    ...pages,
    "lib/event-page.ts",
    "lib/term-dates.ts",
    "lib/sport-events.ts",
    "lib/welcome-events.ts",
    "lib/sign-in-options.ts",
  ]) {
    test(`${file} reads no request and only cached, anonymous data`, () => {
      const source = code(read(file))
      expect(source).not.toMatch(READS_REQUEST)
      expect(source).not.toMatch(UNCACHED_READ)
    })
  }

  test("the patterns catch what they guard against", () => {
    expect(READS_REQUEST.test('import { headers } from "next/headers"')).toBe(true)
    expect(READS_REQUEST.test("const token = await getToken()")).toBe(true)
    expect(UNCACHED_READ.test("await fetchQuery(api.orgs.list, {})")).toBe(true)
    expect(UNCACHED_READ.test("await publicQuery(api.orgs.list, {})")).toBe(false)
  })

  test("the (site) layout sets a literal revalidate", () => {
    expect(read("app/(site)/layout.tsx")).toMatch(/^export const revalidate = \d+$/m)
  })

  // A dynamic segment without `generateStaticParams` is rendered per request;
  // one that lists params reads Convex at build time. The segments build
  // nothing, except the category hubs.
  const segments = pages.filter((file) => /\[[^\]]+\][/\\]page\.tsx$/.test(file))
  test("the scan sees every dynamic segment", () => {
    expect(segments.length).toBe(5)
  })
  // The category hubs are the exception: a fixed list of 16, built with the
  // site, so that any other slug gets the site's static 404 (re-check
  // 2026-11-03, not-found-template; app/(site)/categories/[category]/page.tsx).
  const CATEGORY_HUB = path.join(SITE, "categories", "[category]", "page.tsx")
  test("the exception is a dynamic segment", () => {
    expect(segments).toContain(CATEGORY_HUB)
  })
  for (const file of segments.filter((file) => file !== CATEGORY_HUB)) {
    test(`${file} builds no page and renders each on demand`, () => {
      expect(read(file)).toMatch(
        /export function generateStaticParams\(\)[^\n]*\{\n\s*return \[\]\n\}/,
      )
      expect(read(file)).not.toMatch(/export const dynamicParams\s*=\s*false/)
    })
  }
  test(`${CATEGORY_HUB} builds every hub and no other slug`, () => {
    expect(read(CATEGORY_HUB)).toMatch(/^export const dynamicParams = false$/m)
  })
})

describe("what a signed-out reader's cached page holds", () => {
  /** A Convex client that never connects, behind a signed-out session. */
  function signedOut(node: React.ReactNode) {
    const client = new ConvexReactClient("https://invented-test-1.convex.cloud")
    const useAuth = () => ({
      isLoading: false,
      isAuthenticated: false,
      fetchAccessToken: async () => null,
    })
    const html = renderToString(
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {node}
      </ConvexProviderWithAuth>,
    )
    void client.close()
    // React's text separators, so assertions read as the page does.
    return html.replaceAll("<!-- -->", "")
  }

  test("a profile's Cambridge-only top-up is the server's hint", () => {
    const html = signedOut(
      <ProfileCamOnlyEvents
        orgKey="org-invented"
        path="/societies/invented"
        window={{ from: 0, to: 1 }}
        hiddenEvents={2}
      />,
    )
    expect(html).toContain("2 more Cambridge-only events")
    expect(html).toContain("/sign-in")
  })

  test("a restricted event page is the server's unavailable page", () => {
    const html = signedOut(
      <RestrictedEvent eventKey="evt-invented" underTalks={false}>
        <p>Invented unavailable page</p>
      </RestrictedEvent>,
    )
    expect(html).toBe("<p>Invented unavailable page</p>")
  })
})

describe("what a signed-in reader's browser adds", () => {
  test("only the Cambridge-only events, which a signed-out list never holds", () => {
    const listed = [
      { key: "a", visibility: "public" },
      { key: "b", visibility: "cam_only" },
    ] as unknown as Parameters<typeof camOnlyEvents>[0]
    expect(camOnlyEvents(listed).map((event) => event.key)).toEqual(["b"])
    expect(camOnlyEvents(undefined)).toEqual([])
  })

  test("never a talks.cam-derived event outside /talks; any event under it (G1)", () => {
    const event = (talksDerived: boolean) =>
      ({ key: "evt", talksDerived }) as unknown as Parameters<typeof belongsHere>[0]
    expect(belongsHere(event(false), false)).toBe(true)
    expect(belongsHere(event(true), false)).toBe(false)
    expect(belongsHere(event(true), true)).toBe(true)
    // Under /talks a stale verdict must not hide it (talks-boundary-redirect-loop).
    expect(belongsHere(event(false), true)).toBe(true)
    expect(belongsHere(null, false)).toBe(false)
    expect(belongsHere(undefined, true)).toBe(false)
  })
})

describe("the 404's talks variant", () => {
  test("is chosen for a talk's address only", () => {
    expect(isTalkAddress(`/talks/talk-${"0".repeat(20)}`)).toBe(true)
    expect(isTalkAddress("/talks/nope")).toBe(true)
    expect(isTalkAddress("/talks/departments")).toBe(false)
    expect(isTalkAddress("/societies/zzqx")).toBe(false)
    expect(isTalkAddress(`/talks/events/evt-${"0".repeat(40)}`)).toBe(false)
  })
})
