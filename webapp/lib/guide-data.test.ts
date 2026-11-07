import { describe, expect, test } from "bun:test"
import { collegeInfo } from "./colleges"
import { GLOSSARY, GLOSSARY_INTRO, termAnchor } from "./glossary"
import type { GuideSection } from "./guide-content"
import { MAY_BALL_SECTIONS, MAY_BALLS, MAY_WEEK } from "./may-balls"
import { GRADUATE_COLLEGES, POSTGRAD_SECTIONS } from "./postgraduates"
import { ROWING_DATES, ROWING_GLOSSARY, ROWING_SECTIONS } from "./rowing"
import { PAGE_PATHS } from "./sitemap"
import { SPORT_CLUBS, SPORT_SECTIONS, THEATRE_SECTIONS } from "./tier2-guides"
import { VARSITY_FIXTURES, VARSITY_SECTIONS } from "./varsity"

const ISO = /^\d{4}-\d{2}-\d{2}$/
/** Words a researcher's notes leave behind that a reader must never see. */
const DRAFT = /\b(today|not verified|search[- ]index|could not be (loaded|fetched))\b/i

function checkSections(sections: readonly GuideSection[]) {
  expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length)
  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      expect([section.id, paragraph.sources.length > 0]).toEqual([section.id, true])
      for (const url of paragraph.sources) expect(url).toStartWith("https://")
      expect(paragraph.text).not.toMatch(DRAFT)
    }
  }
}

describe("the guides' researched data", () => {
  test("every paragraph is sourced, over https, with no research notes left in", () => {
    checkSections(MAY_BALL_SECTIONS)
    checkSections(ROWING_SECTIONS)
    checkSections(VARSITY_SECTIONS)
    checkSections(POSTGRAD_SECTIONS)
    checkSections(SPORT_SECTIONS)
    checkSections(THEATRE_SECTIONS)
    checkSections([
      {
        id: "clubs",
        title: "",
        paragraphs: SPORT_CLUBS.map((c) => ({ text: c.note, sources: c.sources })),
      },
    ])
    checkSections([{ id: "may-week", title: "", paragraphs: [MAY_WEEK] }])
    checkSections([{ id: "glossary", title: "", paragraphs: [...ROWING_GLOSSARY] }])
  })

  test("every ball belongs to a known college, is sourced and has no draft wording", () => {
    for (const ball of MAY_BALLS) {
      expect([ball.name, Boolean(collegeInfo(ball.collegeKey))]).toEqual([ball.name, true])
      expect(ball.sources.length).toBeGreaterThan(0)
      if (ball.date) expect(ball.date).toMatch(ISO)
      if (ball.website) expect(ball.website).toStartWith("https://")
      for (const value of [ball.dateText, ball.tickets, ball.dress, ball.workers, ball.frequency])
        if (value) expect(value).not.toMatch(DRAFT)
    }
  })

  test("dates are ISO and sourced", () => {
    for (const row of ROWING_DATES) {
      if (row.start) expect(row.start).toMatch(ISO)
      if (row.end) expect(row.end).toMatch(ISO)
      expect(row.sources.length).toBeGreaterThan(0)
    }
    for (const fixture of VARSITY_FIXTURES) {
      if (fixture.date) expect(fixture.date).toMatch(ISO)
      expect(fixture.sources.length).toBeGreaterThan(0)
    }
  })
})

test("graduate colleges are known colleges", () => {
  for (const entry of GRADUATE_COLLEGES) expect(Boolean(collegeInfo(entry.collegeKey))).toBe(true)
})

test("glossary words are sourced, unique by anchor and link only to real guide paths", () => {
  checkSections(GLOSSARY_INTRO)
  checkSections([
    {
      id: "words",
      title: "",
      paragraphs: GLOSSARY.map((e) => ({ text: e.text, sources: e.sources })),
    },
  ])
  const anchors = GLOSSARY.map((e) => termAnchor(e.term))
  expect(new Set(anchors).size).toBe(anchors.length)
  const paths = new Set(PAGE_PATHS as readonly string[])
  for (const entry of GLOSSARY)
    if (entry.see)
      expect([entry.term, paths.has(entry.see) || entry.see.startsWith("/categories/")]).toEqual([
        entry.term,
        true,
      ])
})
