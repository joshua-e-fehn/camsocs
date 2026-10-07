import { describe, expect, test } from "bun:test"
import {
  csvField,
  fieldLabel,
  OUTREACH_COLUMNS,
  type OutreachRow,
  outreachCsv,
  outreachNotice,
} from "./outreach"

const SITE = "https://camsocs.vercel.app/"

function row(overrides: Partial<OutreachRow> = {}): OutreachRow {
  return {
    key: "org-cu-chess-club",
    slug: "cu-chess-club",
    name: "CU Chess Club",
    isCounterpart: false,
    hidden: false,
    suppressed: false,
    bestAddress: { email: "president@cuchess.org", role: "president" },
    missingFields: ["website", "sport.blueStatus"],
    heldFields: ["name", "roleEmails"],
    sourceHosts: ["cambridgesu.co.uk", "cuchess.org"],
    ...overrides,
  }
}

/** Parses RFC 4180 CSV (quoted fields with "" escapes, CRLF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ""
  let fields: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ",") {
      fields.push(field)
      field = ""
    } else if (char === "\r" && text[i + 1] === "\n") {
      fields.push(field)
      rows.push(fields)
      fields = []
      field = ""
      i++
    } else field += char
  }
  return rows
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

  test("with nothing missing it offers corrections instead", () => {
    const complete = outreachNotice(row({ missingFields: [] }), SITE)
    expect(complete).not.toContain("could not find")
    expect(complete).toContain("If anything on it is wrong")
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
      missing_count: "2",
      missing_fields: "website; sport.blueStatus",
      sources: "cambridgesu.co.uk; cuchess.org",
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

describe("fieldLabel", () => {
  test("plain words for known fields, spaced words otherwise", () => {
    expect(fieldLabel("roleEmails")).toBe("committee role addresses")
    expect(fieldLabel("sport.genderCategories")).toBe("gender categories")
    expect(fieldLabel("someNewField")).toBe("some new field")
  })
})
