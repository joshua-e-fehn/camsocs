import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { isPrivatePath, isPublicPath, PRIVATE_PATHS, PUBLIC_PATHS } from "./auth-routes"

const APP_DIR = new URL("../app/", import.meta.url).pathname

/**
 * Every route `app/` serves a page at, as a pathname.
 *
 * Route groups `(name)` vanish from the URL; dynamic segments `[id]` are kept
 * literally, which still exercises the prefix match their parent provides.
 */
function pageRoutes(dir: string = APP_DIR): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "api") continue
      found.push(...pageRoutes(full))
    } else if (entry.name === "page.tsx") {
      const segments = relative(APP_DIR, dir)
        .split("/")
        .filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment))
      found.push(`/${segments.join("/")}`)
    }
  }
  return found.sort()
}

describe("route classification", () => {
  test("every page is either public or private, never both", () => {
    const routes = pageRoutes()
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      const classified = [isPublicPath(route), isPrivatePath(route)].filter(Boolean).length
      // A failure names the route, so the fix (add it to one list) is obvious.
      expect(`${route}: ${classified}`).toBe(`${route}: 1`)
    }
  })

  test("the lists hold no duplicates and do not overlap", () => {
    const all = [...PUBLIC_PATHS, ...PRIVATE_PATHS]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("isPublicPath", () => {
  test("'/' matches only itself", () => {
    expect(isPublicPath("/")).toBe(true)
    expect(isPublicPath("/dashboard")).toBe(false)
  })

  test("auth callbacks stay public", () => {
    expect(isPublicPath("/api/auth/callback/google")).toBe(true)
  })

  test("a prefix must end at a segment boundary", () => {
    expect(isPublicPath("/sign-in-elsewhere")).toBe(false)
    expect(isPublicPath("/sign-in/extra")).toBe(true)
  })
})

describe("isPrivatePath", () => {
  test("covers nested broker pages", () => {
    expect(isPrivatePath("/dashboard")).toBe(true)
    expect(isPrivatePath("/dashboard/contacts/abc")).toBe(true)
    expect(isPrivatePath("/")).toBe(false)
  })
})
