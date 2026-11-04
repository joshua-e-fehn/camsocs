import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { type OutreachRow, outreachCsv, parseCsv, parseSendLog } from "./outreach"

/**
 * The Art 14 mail merge (ops/outreach/art14-mail-merge.gs) is an Apps Script
 * with no build step; this runs it against a fake sheet and a fake Gmail.
 * The sheet starts as the dashboard's export, and what the script leaves
 * must import back through `parseSendLog`.
 */

const SCRIPT = readFileSync(
  join(import.meta.dir, "../../../ops/outreach/art14-mail-merge.gs"),
  "utf8",
)
const SITE = "https://camsocs.uk"
const TODAY = "2026-11-05"

type Sent = { to: string; subject: string; body: string; options: Record<string, string> }
type Bounce = { subject: string; body: string; from?: string }

function exportRow(key: string, name: string, email: string, next: string[] = []): OutreachRow {
  return {
    key,
    slug: key.replace(/^org-/, ""),
    name,
    isCounterpart: false,
    hidden: false,
    suppressed: false,
    bestAddress: { email, role: "secretary", kind: "role_own_domain" },
    nextAddresses: next,
    missingFields: ["website"],
    heldFields: ["name"],
    sourceHosts: ["example.org"],
  }
}

function harness(
  csvRows: OutreachRow[],
  opts: { quota?: number; aliases?: string[]; me?: string; bounces?: Bounce[] } = {},
) {
  const grid: unknown[][] = parseCsv(outreachCsv(csvRows, SITE))
  const sent: Sent[] = []
  const formats: string[] = []
  let quota = opts.quota ?? 1500
  const range = (row: number, column: number) => ({
    setNumberFormat(format: string) {
      formats.push(format)
      return this
    },
    setValue(value: unknown) {
      while (grid.length < row) grid.push([])
      grid[row - 1][column - 1] = value
      return this
    },
  })
  const sheet = {
    getDataRange: () => ({ getValues: () => grid.map((row) => row.slice()) }),
    getRange: range,
    appendRow: (values: unknown[]) => grid.push(values.slice()),
  }
  const context: Record<string, unknown> = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheets: () => [sheet] }),
      flush: () => {},
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => opts.me ?? "admin@joshua-fehn.de" }),
      getActiveUser: () => ({ getEmail: () => opts.me ?? "admin@joshua-fehn.de" }),
    },
    GmailApp: {
      getAliases: () => opts.aliases ?? ["camsocs@joshua-fehn.de"],
      sendEmail: (to: string, subject: string, body: string, options: Record<string, string>) => {
        quota--
        sent.push({ to, subject, body, options })
      },
      search: () => [
        {
          getMessages: () =>
            (opts.bounces ?? []).map((bounce) => ({
              getFrom: () =>
                bounce.from ?? "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
              getSubject: () => bounce.subject,
              getPlainBody: () => bounce.body,
            })),
        },
      ],
    },
    MailApp: { getRemainingDailyQuota: () => quota },
    Utilities: { formatDate: () => TODAY, sleep: () => {} },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  }
  runInNewContext(SCRIPT, context)
  // biome-ignore lint/suspicious/noExplicitAny: the script's functions are untyped globals
  const fn = context as Record<string, (...args: any[]) => any>
  const column = (name: string) => (grid[0] as string[]).indexOf(name)
  const value = (row: number, name: string) => String(grid[row - 1][column(name)] ?? "")
  const csv = () =>
    grid
      .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\r\n")
  return { fn, sent, grid, value, csv, formats }
}

const rows = [
  exportRow("org-chess", "Chess Club", "secretary@cuchess.org", ["president@cuchess.org"]),
  exportRow("org-go", "Go Society", "go@srcf.net"),
  exportRow("org-bridge", "Bridge Club", "info@bridge.org"),
]

describe("art14-mail-merge.gs", () => {
  test("sends one email per row, from the contact address, and writes sent_on as text", () => {
    const h = harness(rows)
    const result = h.fn.sendNext_(2)
    expect(result).toMatchObject({ sent: 2, remaining: 1 })
    expect(h.sent.map((m) => m.to)).toEqual(["info@bridge.org", "secretary@cuchess.org"])
    const [first] = h.sent
    expect(first.subject).toBe(
      "Your CAMsocs listing (Bridge Club): what we hold and how to change it",
    )
    expect(first.body).toStartWith("Hello Bridge Club,")
    expect(first.options).toEqual({
      from: "camsocs@joshua-fehn.de",
      name: "Joshua Fehn (CAMsocs)",
      replyTo: "camsocs@joshua-fehn.de",
    })
    expect(h.value(2, "sent_on")).toBe(TODAY)
    expect(h.value(3, "sent_on")).toBe(TODAY)
    expect(h.value(4, "sent_on")).toBe("")
    expect(h.formats).toEqual(["@", "@"])
  })

  test("a second run sends only what is left, and never more than the quota", () => {
    const h = harness(rows, { quota: 1 })
    expect(h.fn.sendNext_(100)).toMatchObject({ sent: 1, remaining: 2 })
    expect(h.fn.sendNext_(100)).toMatchObject({ sent: 0 })
    const again = harness(rows)
    again.fn.sendNext_(100)
    expect(again.fn.sendNext_(100)).toMatchObject({ sent: 0, remaining: 0 })
    expect(again.sent).toHaveLength(3)
  })

  test("refuses to send unless the account can send as the contact address", () => {
    const h = harness(rows, { aliases: [] })
    expect(() => h.fn.sendNext_(10)).toThrow(/not a "Send mail as" address/)
    expect(h.sent).toHaveLength(0)
    const own = harness(rows, { aliases: [], me: "camsocs@joshua-fehn.de" })
    own.fn.sendNext_(1)
    expect(own.sent[0].options.from).toBeUndefined()
  })

  test("a test goes to the address given, marked, and writes nothing", () => {
    const h = harness(rows)
    expect(h.fn.sendTestTo_("jef76@cam.ac.uk")).toContain("as a test")
    expect(h.sent[0].to).toBe("jef76@cam.ac.uk")
    expect(h.sent[0].subject).toStartWith("[Test] ")
    expect(h.value(2, "sent_on")).toBe("")
  })

  test("skips a row whose address is not one, and leaves it unsent", () => {
    const h = harness([exportRow("org-bad", "Bad Soc", "not-an-address"), ...rows.slice(1)])
    const result = h.fn.sendNext_(10)
    expect(result.skipped).toHaveLength(1)
    expect(h.sent.map((m) => m.to)).not.toContain("not-an-address")
  })

  test("marks bounces by whole address; delay warnings are not bounces", () => {
    const h = harness([...rows, exportRow("org-cugo", "CU Go", "cugo@srcf.net")], {
      bounces: [
        {
          subject: "Delivery Status Notification (Failure)",
          body: "Your message wasn't delivered to secretary@cuchess.org because the address couldn't be found.",
        },
        {
          subject: "Undeliverable: Your CAMsocs listing (CU Go)",
          body: "Delivery has failed to these recipients: cugo@srcf.net.",
        },
        {
          subject: "Delivery Status Notification (Delay)",
          body: "info@bridge.org: will retry for 47 more hours",
        },
      ],
    })
    h.fn.sendNext_(10)
    expect(h.fn.markBounces_().sort()).toEqual(["cugo@srcf.net", "secretary@cuchess.org"])
    const bounced = (h.grid as string[][])
      .slice(1)
      .filter((row) => row[(h.grid[0] as string[]).indexOf("bounced")] === "yes")
      .map((row) => row[(h.grid[0] as string[]).indexOf("email")])
    // go@srcf.net is inside cugo@srcf.net but is not that address.
    expect(bounced.sort()).toEqual(["cugo@srcf.net", "secretary@cuchess.org"])
  })

  test("queues the next address after a bounce, and names a listing with none left", () => {
    const h = harness(rows, {
      bounces: [
        {
          subject: "Undeliverable",
          body: "secretary@cuchess.org; go@srcf.net could not be delivered",
        },
      ],
    })
    h.fn.sendNext_(10)
    h.fn.markBounces_()
    const result = h.fn.queueNextAddresses_()
    expect(result).toEqual({ queued: 1, noRoute: ["Go Society"] })
    const last = h.grid.length
    expect(h.value(last, "org_key")).toBe("org-chess")
    expect(h.value(last, "email")).toBe("president@cuchess.org")
    expect(h.value(last, "sent_on")).toBe("")
    // Pending again: a second queue run adds nothing.
    expect(h.fn.queueNextAddresses_()).toEqual({ queued: 0, noRoute: ["Go Society"] })
    expect(h.fn.sendNext_(10)).toMatchObject({ sent: 1 })
    expect(h.sent.at(-1)?.to).toBe("president@cuchess.org")
  })

  test("the sheet it leaves imports back as the send log", () => {
    const h = harness(rows, {
      bounces: [{ subject: "Undeliverable", body: "to go@srcf.net failed" }],
    })
    h.fn.sendNext_(10)
    h.fn.markBounces_()
    const log = parseSendLog(h.csv(), "2026-11-10")
    expect(log.errors).toEqual([])
    expect(log.entries).toHaveLength(3)
    expect(log.entries.find((entry) => entry.orgKey === "org-go")).toEqual({
      orgKey: "org-go",
      email: "go@srcf.net",
      sentOn: TODAY,
      bounced: true,
    })
  })

  test("refuses a sheet that is not the export", () => {
    const h = harness(rows)
    h.grid[0] = ["name", "address"]
    expect(() => h.fn.sendNext_(1)).toThrow(/needs the columns/)
  })
})
