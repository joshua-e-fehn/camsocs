import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { BrokerOrgRow } from "@/hooks/convex/broker"
import { parseCsv } from "@/lib/broker/outreach"

/**
 * The reports page's two exports (ENG-40): the outreach CSV, and the
 * webmail-only CSV of the same shape. The Convex hooks are stand-ins over
 * synthetic rows; the downloads are caught at `URL.createObjectURL`.
 */

function orgRow(overrides: Partial<BrokerOrgRow>): BrokerOrgRow {
  return {
    key: "org-chess",
    slug: "chess",
    name: "Chess Club",
    status: "active",
    isCounterpart: false,
    hidden: false,
    collegeKeys: [],
    categories: [],
    has: { email: true, website: false, instagram: false, description: false },
    missingFields: ["website"],
    bestAddress: {
      email: "secretary@chess.example.org",
      role: "secretary",
      kind: "role_own_domain",
    },
    nextAddresses: [],
    webmailAddresses: [],
    heldFields: ["name"],
    sourceHosts: ["example.org"],
    needs: [],
    offers: [],
    suppressed: false,
    hasProfile: false,
    updatedAt: 0,
    ...overrides,
  }
}

const ROWS: BrokerOrgRow[] = [
  orgRow({}),
  orgRow({
    key: "org-rowing",
    slug: "rowing",
    name: "Rowing Society",
    bestAddress: undefined,
    webmailAddresses: [{ email: "rowing.soc@gmail.com", role: "general", kind: "webmail" }],
  }),
  orgRow({ key: "org-list", slug: "list", name: "List Society", bestAddress: undefined }),
]

mock.module("@/hooks/convex/broker", () => ({
  useAllBrokerOrgRows: () => ({ rows: ROWS, complete: true }),
  useBrokerInteractionMutations: () => ({ recordSendLog: async () => ({}) }),
  errorMessage: (error: unknown) => String(error),
}))

const { BrokerReports } = await import("@/components/organisms/broker-reports")

let root: Root | undefined
const downloads: Blob[] = []
const original = {
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
  click: HTMLAnchorElement.prototype.click,
}

beforeEach(() => {
  URL.createObjectURL = (blob: Blob) => {
    downloads.push(blob)
    return "blob:test"
  }
  URL.revokeObjectURL = () => {}
  HTMLAnchorElement.prototype.click = () => {}
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  downloads.length = 0
  Object.assign(URL, {
    createObjectURL: original.createObjectURL,
    revokeObjectURL: original.revokeObjectURL,
  })
  HTMLAnchorElement.prototype.click = original.click
  document.body.innerHTML = ""
})

async function mount() {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(<BrokerReports />))
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!found) throw new Error(`No button "${label}"`)
  return found
}

/** The org_key and email columns of the one CSV downloaded. */
async function downloaded(): Promise<string[]> {
  expect(downloads).toHaveLength(1)
  const [header, ...rows] = parseCsv(await downloads[0].text())
  return rows.map(
    (cells) => `${cells[header.indexOf("org_key")]} ${cells[header.indexOf("email")]}`,
  )
}

test("the webmail-only button downloads only the webmail-only societies", async () => {
  const container = await mount()
  await act(async () => button(container, "Download webmail-only CSV (Art 14)").click())
  expect(await downloaded()).toEqual(["org-rowing rowing.soc@gmail.com"])
})

test("the outreach CSV still leaves webmail out", async () => {
  const container = await mount()
  await act(async () => button(container, "Download outreach CSV").click())
  expect(await downloaded()).toEqual(["org-chess secretary@chess.example.org"])
})

test("the no-address tile counts the webmail-only societies", async () => {
  const container = await mount()
  expect(container.textContent).toContain("1 have webmail only (second CSV)")
})
