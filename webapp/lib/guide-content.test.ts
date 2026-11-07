import { expect, test } from "bun:test"
import { publisherOf, sectionSources } from "./guide-content"

test("publisherOf names known publishers and falls back to the host", () => {
  expect(publisherOf("https://www.cucbc.org/bumps")).toBe("CUCBC")
  expect(publisherOf("https://www.theboatrace.org/")).toBe("The Boat Race")
  expect(publisherOf("https://www.sport.cam.ac.uk/x")).toBe("University Sport")
  expect(publisherOf("https://www.trinitymayball.com/")).toBe("trinitymayball.com")
  expect(
    publisherOf("https://www.trinitymayball.com/", { "trinitymayball.com": "Trinity May Ball" }),
  ).toBe("Trinity May Ball")
})

test("sectionSources lists each cited URL once, in reading order", () => {
  const sources = sectionSources(
    [
      {
        id: "a",
        title: "A",
        paragraphs: [{ text: "x", sources: ["https://b.org/", "https://a.org/p/"] }],
      },
      { id: "b", title: "B", paragraphs: [{ text: "y", sources: ["https://a.org/p/"] }] },
    ],
    "2026-11-08",
  )
  expect(sources.map((s) => s.url)).toEqual(["https://b.org/", "https://a.org/p/"])
  expect(sources[1].title).toBe("a.org/p")
})

test("a college's own subdomain and a club's page are named for them, not the University", () => {
  expect(publisherOf("https://www.cai.cam.ac.uk/news/x")).toBe("Gonville & Caius College")
  expect(publisherOf("https://sites.google.com/view/crabumps/about-bumps")).toBe(
    "Cambridgeshire Rowing Association",
  )
  expect(publisherOf("https://www.cam.ac.uk/about")).toBe("University of Cambridge")
})

test("college hosts under cam.ac.uk are named for the college", () => {
  expect(publisherOf("https://ucs.clare.cam.ac.uk/applying")).toBe("Clare College")
  expect(publisherOf("https://www.hughes.cam.ac.uk/news/")).toBe("Hughes Hall")
  expect(publisherOf("https://glossary.lib.cam.ac.uk/term/may-week")).toBe(
    "Cambridge University Library",
  )
})
