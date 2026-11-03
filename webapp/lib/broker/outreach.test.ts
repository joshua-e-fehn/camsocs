import { describe, expect, test } from "bun:test"
import {
  csvField,
  fieldLabel,
  OUTREACH_COLUMNS,
  type OutreachRow,
  outreachCsv,
  outreachGroups,
  outreachNotice,
  parseCsv,
  parseSendLog,
  sendLogDate,
  sentOnProblem,
  UnclosedQuoteError,
} from "./outreach"

const SITE = "https://camsocs.vercel.app/"
/** "Today" for the send-log tests, after every date they use. */
const TODAY = "2026-11-10"

function row(overrides: Partial<OutreachRow> = {}): OutreachRow {
  return {
    key: "org-cu-chess-club",
    slug: "cu-chess-club",
    name: "CU Chess Club",
    isCounterpart: false,
    hidden: false,
    suppressed: false,
    bestAddress: { email: "president@cuchess.org", role: "president", kind: "role_own_domain" },
    missingFields: ["website", "sport.blueStatus"],
    heldFields: ["name", "roleEmails"],
    sourceHosts: ["cambridgesu.co.uk", "cuchess.org"],
    ...overrides,
  }
}

describe("outreachNotice (doubles as the Art 14 notice)", () => {
  const notice = outreachNotice(row(), SITE)

  test("says who we are, unofficial", () => {
    expect(notice).toStartWith("Hello CU Chess Club,")
    expect(notice).toContain("personal project by Joshua Fehn")
    expect(notice).toContain("not affiliated with the University of Cambridge or Cambridge SU")
  })

  test("says what we hold and where it came from", () => {
    expect(notice).toContain("shows your name and committee role addresses")
    expect(notice).toContain("from public pages: cambridgesu.co.uk and cuchess.org")
  })

  test("asks for what is missing, in plain words", () => {
    expect(notice).toContain("could not find your website and Blue status")
  })

  test("names the lawful basis, the right to object and links /request and /privacy", () => {
    expect(notice).toContain("legitimate interests")
    expect(notice).toContain("object to this, or ask us to remove the listing")
    expect(notice).toContain("https://camsocs.vercel.app/request")
    expect(notice).toContain("https://camsocs.vercel.app/privacy")
    expect(notice).not.toContain("app//")
  })

  test("says the CRM keeps names and roles, and claims nothing the site cannot keep", () => {
    expect(notice).toContain("we also keep the names and roles of committee members")
    expect(notice).toContain("leaving out any that look like one person's CRSid or alumni address")
    expect(notice).toContain("written not to name committee members")
    expect(notice).toContain("replaced by the person's role")
    expect(notice).not.toContain("never personal ones")
    expect(notice).not.toContain("names no committee members")
    expect(notice).not.toMatch(/never a personal/)
    expect(notice).not.toMatch(/roles as your own pages publish them/)
  })

  test("names both purposes, partners included, and makes no non-commercial claim", () => {
    expect(notice).toContain("a public directory that helps students find societies")
    expect(notice).toContain("introductions between societies and to possible partners")
    expect(notice).toContain("sponsors, speakers and venues")
    expect(notice).toContain("we do not hand them or your addresses to sponsors")
    expect(notice).not.toMatch(/commercial/i)
  })

  test("names the regulator by its current name, as the privacy page does", () => {
    expect(notice).toContain(
      "the UK regulator, the Information Commission (formerly the Information Commissioner's Office, ICO)",
    )
    expect(notice.match(/Information Commission\b/g)).toHaveLength(1)
  })

  test("with nothing missing it offers corrections instead", () => {
    const complete = outreachNotice(row({ missingFields: [] }), SITE)
    expect(complete).not.toContain("could not find")
    expect(complete).toContain("If anything on it is wrong")
  })
})

describe("outreachGroups (the reports page)", () => {
  test("a listing without an outreach address is in noAddress, complete or not", () => {
    const groups = outreachGroups([
      row(),
      row({ key: "org-done", missingFields: [] }),
      row({ key: "org-webmail-done", bestAddress: undefined, missingFields: [] }),
      row({ key: "org-list-gaps", bestAddress: undefined }),
      row({ key: "org-hidden", hidden: true }),
      row({ key: "org-bank", isCounterpart: true }),
    ])
    const keys = (rows: readonly OutreachRow[]) => rows.map((r) => r.key)
    expect(keys(groups.address)).toEqual(["org-cu-chess-club"])
    expect(keys(groups.complete)).toEqual(["org-done"])
    expect(keys(groups.noAddress)).toEqual(["org-webmail-done", "org-list-gaps"])
    expect(groups.withAddress).toBe(2)
    expect(groups.excluded).toBe(1)
  })
})

describe("outreachCsv", () => {
  test("a header row, then one row per candidate with an address, by name", () => {
    const csv = outreachCsv(
      [
        row({ key: "org-z", name: "Zeta Society" }),
        row(),
        row({ key: "org-noaddr", name: "No Address Soc", bestAddress: undefined }),
        row({ key: "org-hidden", name: "Hidden Soc", hidden: true }),
        row({ key: "org-supp", name: "Suppressed Soc", suppressed: true }),
        row({ key: "org-bank", name: "A Bank", isCounterpart: true }),
      ],
      SITE,
    )
    expect(csv.endsWith("\r\n")).toBe(true)
    const rows = parseCsv(csv)
    expect(rows[0]).toEqual([...OUTREACH_COLUMNS])
    expect(rows.slice(1).map((r) => r[0])).toEqual(["CU Chess Club", "Zeta Society"])
    const chess = Object.fromEntries(OUTREACH_COLUMNS.map((column, i) => [column, rows[1][i]]))
    expect(chess).toMatchObject({
      org_key: "org-cu-chess-club",
      role: "president",
      email: "president@cuchess.org",
      email_kind: "role_own_domain",
      missing_count: "2",
      missing_fields: "website; sport.blueStatus",
      sources: "cambridgesu.co.uk; cuchess.org",
      sent_on: "",
      bounced: "",
    })
    // The multi-paragraph notice survives the round trip intact.
    expect(chess.notice).toBe(outreachNotice(row(), SITE))
  })

  test("quotes commas, quotes and line breaks, and defuses formulas", () => {
    expect(csvField("plain")).toBe("plain")
    expect(csvField('Say "hi", then')).toBe('"Say ""hi"", then"')
    expect(csvField("a\nb")).toBe('"a\nb"')
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)")
    expect(csvField("+44")).toBe("'+44")
    const csv = outreachCsv([row({ name: '=cmd|"/c calc"!A1, Soc' })], SITE)
    expect(parseCsv(csv)[1][0]).toBe(`'=cmd|"/c calc"!A1, Soc`)
  })
})

describe("parseSendLog (the send log, imported back as interactions)", () => {
  const exported = outreachCsv(
    [
      row(),
      row({
        key: "org-go",
        name: "CU Go Society",
        bestAddress: { email: "Sec@CUGo.org", role: "secretary", kind: "role_own_domain" },
      }),
      row({ key: "org-z", name: "Zeta Society" }),
    ],
    SITE,
  )

  /** The export with `sent_on` / `bounced` filled in per organisation key. */
  function filled(marks: Record<string, [string, string]>): string {
    const [header, ...rows] = parseCsv(exported)
    const at = (name: string) => header.indexOf(name)
    for (const cells of rows) {
      const mark = marks[cells[at("org_key")]]
      if (!mark) continue
      cells[at("sent_on")] = mark[0]
      cells[at("bounced")] = mark[1]
    }
    return [header, ...rows].map((cells) => cells.map(csvField).join(",")).join("\r\n")
  }

  test("the export itself goes back: sent rows become entries, unsent ones are counted", () => {
    const log = parseSendLog(
      filled({ "org-cu-chess-club": ["2026-11-05", ""], "org-go": ["5/11/2026", "yes"] }),
      TODAY,
    )
    expect(log.errors).toEqual([])
    expect(log.notSent).toBe(1)
    expect(log.entries).toEqual([
      {
        orgKey: "org-cu-chess-club",
        email: "president@cuchess.org",
        sentOn: "2026-11-05",
        bounced: false,
      },
      { orgKey: "org-go", email: "sec@cugo.org", sentOn: "2026-11-05", bounced: true },
    ])
  })

  test("a short log of four columns, LF line ends; duplicates collapse, a bounce wins", () => {
    const log = parseSendLog(
      [
        "org_key,email,sent_on,bounced",
        "org-a,sec@a.org,2026-11-05,",
        "org-a,sec@a.org,2026-11-05,bounced",
        "org-b,info@b.org,2026-11-06",
        "",
      ].join("\n"),
      TODAY,
    )
    expect(log.errors).toEqual([])
    expect(log.entries).toEqual([
      { orgKey: "org-a", email: "sec@a.org", sentOn: "2026-11-05", bounced: true },
      { orgKey: "org-b", email: "info@b.org", sentOn: "2026-11-06", bounced: false },
    ])
  })

  test("names each bad row, and a file without the columns", () => {
    const log = parseSendLog(
      "org_key,email,sent_on,bounced\norg-a,sec@a.org,31/02/2026,\n,nobody,2026-11-05,maybe\n",
      TODAY,
    )
    expect(log.errors).toEqual([
      'Row 2: "31/02/2026" is not a date (YYYY-MM-DD)',
      "Row 3: no org_key",
      'Row 3: "nobody" is not an address',
      'Row 3: bounced should be "yes" or empty, not "maybe"',
    ])
    expect(parseSendLog("org_name,email\nChess,sec@a.org\n", TODAY).errors).toEqual([
      'The file needs the columns "org_key" and "sent_on"',
    ])
  })

  test("dates: ISO or the UK spreadsheet form, real days only", () => {
    expect(sendLogDate("2026-11-05")).toBe("2026-11-05")
    expect(sendLogDate(" 5/11/2026 ")).toBe("2026-11-05")
    expect(sendLogDate("2026-02-30")).toBeUndefined()
    expect(sendLogDate("11/5/26")).toBeUndefined()
  })

  test("a date outside the outreach period, such as a US-locale 11/5/2026, stops the file", () => {
    const log = parseSendLog(
      [
        "org_key,email,sent_on",
        "org-a,sec@a.org,11/5/2026",
        "org-b,sec@b.org,2026-11-11",
        "org-c,sec@c.org,2026-09-30",
        "org-d,sec@d.org,2026-10-01",
      ].join("\n"),
      TODAY,
    )
    expect(log.errors).toEqual([
      "Row 2: 2026-05-11 is outside the outreach period (2026-10-01 to 2026-11-10); check the sheet's date format",
      "Row 3: 2026-11-11 is outside the outreach period (2026-10-01 to 2026-11-10); check the sheet's date format",
      "Row 4: 2026-09-30 is outside the outreach period (2026-10-01 to 2026-11-10); check the sheet's date format",
    ])
    expect(sentOnProblem("2026-10-01", TODAY)).toBeUndefined()
    expect(sentOnProblem(TODAY, TODAY)).toBeUndefined()
  })

  test("an unclosed quote refuses the whole file, naming the row it opens on", () => {
    const text = [
      "org_key,email,sent_on,notice",
      'org-a,sec@a.org,2026-11-05,"Hello',
      "org-b,sec@b.org,2026-11-05,Hello",
      "org-c,sec@c.org,2026-11-05,Hello",
    ].join("\r\n")
    expect(() => parseCsv(text)).toThrow(UnclosedQuoteError)
    expect(parseSendLog(text, TODAY)).toEqual({
      entries: [],
      notSent: 0,
      errors: ["The file has an unclosed quote (from row 2)"],
    })
  })
})

describe("fieldLabel", () => {
  test("plain words for known fields, spaced words otherwise", () => {
    expect(fieldLabel("roleEmails")).toBe("committee role addresses")
    expect(fieldLabel("sport.genderCategories")).toBe("gender categories")
    expect(fieldLabel("someNewField")).toBe("some new field")
  })
})
