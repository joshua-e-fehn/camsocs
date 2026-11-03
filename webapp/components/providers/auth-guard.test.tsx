import { describe, expect, test } from "bun:test"
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime"
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime"
import { renderToString } from "react-dom/server"
import { AuthGuard } from "./auth-guard"

/**
 * What AuthGuard puts in a page's server HTML, the HTML the edge caches
 * (SEO re-check 2026-11-03, home-ssr-spinner): a public page's content, a
 * private page's spinner. The pathname is the one Next's server render
 * reports, including the "/index" a Vercel ISR re-render of "/" carries.
 */
const router: AppRouterInstance = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
}

function serverHtml(pathname: string): string {
  return renderToString(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>
        <AuthGuard>
          <h1>Invented heading</h1>
        </AuthGuard>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  )
}

describe("AuthGuard's server HTML", () => {
  for (const pathname of ["/", "/index", "/about", "/categories/sport", "/societies/invented"]) {
    test(`${pathname} renders its content`, () => {
      const html = serverHtml(pathname)
      expect(html).toContain("<h1>Invented heading</h1>")
      expect(html).not.toContain("animate-spin")
    })
  }

  test("/dashboard renders only the spinner", () => {
    const html = serverHtml("/dashboard")
    expect(html).not.toContain("<h1>")
    expect(html).toContain("animate-spin")
  })
})
