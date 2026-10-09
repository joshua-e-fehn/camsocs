import path from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { test as base, expect, type Page, type TestInfo } from "@playwright/test"

/**
 * The e2e harness: a read-only guard around every page, plus the checks and
 * the screenshot every smoke test ends with.
 *
 * ## The read-only guard
 *
 * The browser talks to Convex over one WebSocket (the sync protocol: JSON
 * messages `ModifyQuerySet`, `Mutation`, `Action`, … from the page;
 * `Transition`, `MutationResponse`, … from the server). The guard routes that
 * socket through Playwright and forwards everything except `Mutation` and
 * `Action` messages, which never reach the server:
 *
 *  - by default it answers them with a failure and records the function name,
 *    and the test fails (`guard.blocked` must stay empty);
 *  - a test that exercises a form calls `guard.mock(udfPath, result)` first:
 *    the page then gets a successful `MutationResponse` with that result, as
 *    the server would send it, and the submit flow runs to its success state
 *    while nothing is written.
 *
 * A successful mutation resolves on the page only once the client has seen a
 * query-set transition at or after the mutation's timestamp
 * (convex/browser `RequestManager.removeCompleted`), so the mock answers with
 * timestamp 0 and then a no-op `Transition` from the version the page is on.
 *
 * Non-GET requests to `/api/auth/*` (sign-in, sign-out, sign-in links) are
 * aborted the same way. Server-rendered pages call public queries only.
 */

/** A u64 timestamp of 0, little-endian base64, as the sync protocol encodes it. */
const ZERO_TS = "AAAAAAAAAAA="
const CONVEX_SYNC = /\.convex\.cloud\/api\/[^/]+\/sync$/

type SyncMessage = {
  type?: string
  requestId?: number
  udfPath?: string
  endVersion?: unknown
  chunk?: string
  partNumber?: number
  totalParts?: number
  transitionId?: string
}

export type Guard = {
  /** Mutations, actions and auth writes the page tried; they never left the browser. */
  blocked: string[]
  /** Answer calls to `udfPath` (e.g. `listingRequests:submit`) with a successful `result`. */
  mock: (udfPath: string, result: unknown) => void
}

function text(raw: string | Buffer): string {
  return typeof raw === "string" ? raw : raw.toString("utf8")
}

function parse(raw: string | Buffer): SyncMessage | null {
  try {
    return JSON.parse(text(raw)) as SyncMessage
  } catch {
    return null
  }
}

async function installGuard(page: Page): Promise<Guard> {
  const blocked: string[] = []
  const mocks = new Map<string, unknown>()

  await page.routeWebSocket(CONVEX_SYNC, (ws) => {
    const server = ws.connectToServer()
    /** The query-set version the page is on: the last transition's end. */
    let version: unknown
    const chunks = new Map<string, string[]>()

    server.onMessage((raw) => {
      const message = parse(raw)
      if (message?.type === "Transition") version = message.endVersion
      if (message?.type === "TransitionChunk" && message.transitionId) {
        const parts = chunks.get(message.transitionId) ?? []
        parts[message.partNumber ?? 0] = message.chunk ?? ""
        chunks.set(message.transitionId, parts)
        if (parts.filter((part) => part !== undefined).length === message.totalParts) {
          chunks.delete(message.transitionId)
          const whole = parse(parts.join(""))
          if (whole?.type === "Transition") version = whole.endVersion
        }
      }
      ws.send(raw)
    })

    ws.onMessage((raw) => {
      const message = parse(raw)
      if (message?.type !== "Mutation" && message?.type !== "Action") {
        server.send(raw)
        return
      }
      const udfPath = message.udfPath ?? "?"
      const responseType = message.type === "Mutation" ? "MutationResponse" : "ActionResponse"
      if (!mocks.has(udfPath)) {
        blocked.push(udfPath)
        ws.send(
          JSON.stringify({
            type: responseType,
            requestId: message.requestId,
            success: false,
            result: "Blocked by the e2e read-only guard",
            logLines: [],
          }),
        )
        return
      }
      ws.send(
        JSON.stringify({
          type: responseType,
          requestId: message.requestId,
          success: true,
          result: mocks.get(udfPath),
          ...(message.type === "Mutation" ? { ts: ZERO_TS } : {}),
          logLines: [],
        }),
      )
      if (message.type === "Mutation" && version !== undefined) {
        ws.send(
          JSON.stringify({
            type: "Transition",
            startVersion: version,
            endVersion: version,
            modifications: [],
          }),
        )
      }
    })
  })

  // The browser client never uses Convex's HTTP mutation endpoints, but if it
  // ever did, they stay closed too.
  await page.route(/\.convex\.cloud\/api\/(mutation|action|run)/, async (route) => {
    blocked.push(`http:${new URL(route.request().url()).pathname}`)
    await route.abort("blockedbyclient")
  })
  await page.route("**/api/auth/**", async (route) => {
    if (route.request().method() === "GET") return route.continue()
    blocked.push(`auth:${new URL(route.request().url()).pathname}`)
    await route.abort("blockedbyclient")
  })

  return { blocked, mock: (udfPath, result) => mocks.set(udfPath, result) }
}

/** Errors the page logged or threw while the test ran. */
export type PageProblems = { console: string[]; uncaught: string[] }

/** Next's dev-mode indicator ("N" bubble) is not part of the page. */
async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style")
      style.textContent = "nextjs-portal { display: none !important; }"
      document.head.append(style)
    })
  })
}

/** Both fixtures are automatic: every test runs guarded and watched. */
export const test = base.extend<{ guard: Guard; problems: PageProblems }>({
  guard: [
    async ({ page }, use) => {
      await hideDevOverlay(page)
      const guard = await installGuard(page)
      await use(guard)
      expect(guard.blocked, "the page tried to write; the guard blocked it").toEqual([])
    },
    { auto: true },
  ],
  problems: [
    async ({ page }, use) => {
      const problems: PageProblems = { console: [], uncaught: [] }
      page.on("console", (message) => {
        if (message.type() === "error") problems.console.push(message.text())
      })
      page.on("pageerror", (error) => problems.uncaught.push(error.message))
      await use(problems)
      expect(problems.uncaught, "uncaught errors on the page").toEqual([])
      expect.soft(problems.console, "console errors on the page").toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/** `YYYY-MM-DD` in London: the screenshot folder of this run. */
function londonDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date())
}

/** `<repo>/var/screenshots/<date>/<label>/<project>/` (var/ is gitignored). */
export function screenshotDir(testInfo: TestInfo): string {
  const label = process.env.E2E_LABEL ?? "latest"
  return path.resolve(
    testInfo.project.testDir,
    "..",
    "..",
    "var",
    "screenshots",
    londonDate(),
    label,
    testInfo.project.name,
  )
}

/**
 * Scrolls through the page so lazy images load and scroll-triggered reveals
 * play, then back to the top, and waits for fonts and images.
 */
export async function settle(page: Page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    window.scrollTo(0, 0)
    await document.fonts.ready
    await Promise.all(
      [...document.images]
        .filter((image) => !image.complete)
        .map(
          (image) =>
            new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true })
              image.addEventListener("error", resolve, { once: true })
            }),
        ),
    )
  })
  await page.waitForTimeout(500)
}

/** Elements wider than the viewport (a horizontal scroll on a phone), described. */
export async function overflowingElements(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    if (document.documentElement.scrollWidth <= width) return []
    const out: string[] = []
    for (const element of document.body.querySelectorAll("*")) {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.right <= width + 1) continue
      // Report the outermost offender only.
      if (element.parentElement && element.parentElement.getBoundingClientRect().right > width + 1)
        continue
      const name = element.tagName.toLowerCase()
      const classes = (element.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".")
      out.push(`${name}${classes ? `.${classes}` : ""} → right ${Math.round(box.right)}px`)
      if (out.length >= 5) break
    }
    return out
  })
}

/** WCAG 2.1 A/AA and axe's best practices (heading order, landmarks, …). */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]

/** axe-core violations on the page as it is now, as "rule (impact): targets". */
export async function accessibilityViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join(" | ")}`,
  )
}

/**
 * The checks every page gets, then a full-page screenshot named `name`:
 * one `<h1>`, no horizontal overflow, a `<title>`, a description and a share
 * image, no axe-core violation (in the page's current theme, so contrast is checked in
 * light and dark).
 */
export async function checkAndCapture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { fullPage?: boolean; skipSettle?: boolean } = {},
) {
  if (!options.skipSettle) await settle(page)
  await expect.soft(page.locator("h1"), "one h1 per page").toHaveCount(1)
  expect.soft(await overflowingElements(page), "no horizontal overflow").toEqual([])
  expect.soft(await page.title(), "a page title").not.toBe("")
  await expect.soft(page.locator('meta[name="description"]'), "a meta description").toHaveCount(1)
  const file = path.join(screenshotDir(testInfo), `${name}.png`)
  await page.screenshot({ path: file, fullPage: options.fullPage ?? true, animations: "disabled" })
  await testInfo.attach(name, { path: file, contentType: "image/png" })
}
