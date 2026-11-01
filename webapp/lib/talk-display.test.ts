import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import type { TalkListItem } from "./public-api"
import {
  type DepartmentCount,
  schoolColumns,
  speakerLine,
  talkHref,
  talkMeta,
  talkPaletteLine,
  talkTime,
} from "./talk-display"

const talk = (overrides: Partial<TalkListItem> = {}): TalkListItem => ({
  key: "talk-0123456789abcdef0123",
  title: "Types all the way down",
  speakers: [{ name: "Dr Ada Byron", affiliation: "Analytical Engines" }],
  series: "Programming Research Group",
  departments: [
    {
      key: "dept-computer-science",
      slug: "computer-science",
      shortName: "Computer Science",
      school: "technology",
    },
  ],
  startsAt: londonMidnight("2026-11-02") + 16 * 3_600_000,
  endsAt: null,
  allDay: false,
  venue: "Lecture Theatre 1",
  online: false,
  kind: "seminar",
  cancelled: false,
  url: "https://example.org/talk/1",
  ...overrides,
})

const department = (overrides: Partial<DepartmentCount>): DepartmentCount => ({
  key: "dept-x",
  slug: "x",
  shortName: "X",
  school: "technology",
  upcomingCount: 0,
  virtual: false,
  ...overrides,
})

describe("a talk's agenda line", () => {
  test("links to its sheet on /talks", () => {
    expect(talkHref("talk-abc")).toBe("/talks?talk=talk-abc")
  })

  test("speakers: one with affiliation, two by name, more counted", () => {
    expect(speakerLine([])).toBeUndefined()
    expect(speakerLine([{ name: "A", affiliation: "Here" }])).toBe("A (Here)")
    expect(speakerLine([{ name: "A" }, { name: "B", affiliation: "There" }])).toBe("A and B")
    expect(speakerLine([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }])).toBe(
      "A, B and 2 more",
    )
  })

  test("meta is department (else series) · speaker, else nothing", () => {
    expect(talkMeta(talk())).toBe("Computer Science · Dr Ada Byron (Analytical Engines)")
    expect(talkMeta(talk({ departments: [] }))).toBe(
      "Programming Research Group · Dr Ada Byron (Analytical Engines)",
    )
    expect(talkMeta(talk({ speakers: [], departments: [], series: null }))).toBeUndefined()
  })

  test("time: the London clock, all day, or On for one begun earlier", () => {
    expect(talkTime(talk(), "2026-11-02")).toBe("16:00")
    expect(talkTime(talk({ allDay: true }), "2026-11-02")).toBe("All day")
    expect(talkTime(talk(), "2026-11-03")).toBe("On")
  })
})

describe("a talk in the palette", () => {
  test("when and whose: time and department, else the series", () => {
    expect(talkPaletteLine(talk())).toBe("16:00 · Computer Science")
    expect(talkPaletteLine(talk({ departments: [], allDay: true }))).toBe(
      "All day · Programming Research Group",
    )
    expect(talkPaletteLine(talk({ departments: [], series: null }))).toBe("16:00")
  })
})

describe("talks by department", () => {
  const departments = [
    department({ key: "a", shortName: "Zoology", school: "biological_sciences", upcomingCount: 3 }),
    department({
      key: "b",
      shortName: "Biochemistry",
      school: "biological_sciences",
      upcomingCount: 3,
    }),
    department({
      key: "c",
      shortName: "Genetics",
      school: "biological_sciences",
      upcomingCount: 9,
    }),
    department({ key: "d", shortName: "Plant Sciences", school: "biological_sciences" }),
    department({ key: "e", shortName: "Engineering", school: "technology", upcomingCount: 4 }),
    department({
      key: "other-series",
      shortName: "Other series",
      school: "other",
      upcomingCount: 5,
      virtual: true,
    }),
    department({ key: "f", shortName: "Museum", school: "other", upcomingCount: 5 }),
  ]

  test("every School, in order, with its busiest departments first", () => {
    const columns = schoolColumns(departments, 2)
    expect(columns.map((column) => column.school)).toEqual([
      "arts_humanities",
      "humanities_social_sciences",
      "biological_sciences",
      "clinical_medicine",
      "physical_sciences",
      "technology",
      "other",
    ])
    const bio = columns[2]
    // Ties by name; a department with nothing coming up is left out.
    expect(bio.top.map((d) => d.shortName)).toEqual(["Genetics", "Biochemistry"])
    expect(bio.total).toBe(15)
    expect(bio.active).toBe(3)
    // A real department before the "Other series" bucket on a tie.
    expect(columns[6].top.map((d) => d.key)).toEqual(["f", "other-series"])
  })

  test("a School with nothing coming up keeps an empty column", () => {
    const [arts] = schoolColumns(departments, 5)
    expect(arts).toEqual({ school: "arts_humanities", total: 0, active: 0, top: [] })
  })
})
