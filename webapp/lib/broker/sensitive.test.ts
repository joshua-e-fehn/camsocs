import { describe, expect, test } from "bun:test"
import { CATEGORIES } from "../vocab"
import {
  isOwnSocietyPage,
  isSensitiveSociety,
  SENSITIVE_CATEGORIES,
  sensitiveBecause,
  sensitiveOfficerProblem,
} from "./sensitive"

describe("sensitiveBecause", () => {
  test("the four identity categories and the LGBTQ+ audience, nothing else", () => {
    expect(sensitiveBecause({ categories: ["faith", "music"], audiences: ["lgbtq"] })).toEqual([
      "Faith & Belief",
      "LGBTQ+",
    ])
    expect(sensitiveBecause({ categories: ["politics_debate"], audiences: [] })).toEqual([
      "Politics, Debate & Law",
    ])
    expect(
      sensitiveBecause({
        categories: ["cultural_international", "identity_wellbeing"],
        audiences: [],
      }),
    ).toEqual(["Cultural & International", "Identity, Community & Wellbeing"])
    const ordinary = CATEGORIES.filter(
      (category) => !(SENSITIVE_CATEGORIES as readonly string[]).includes(category),
    )
    expect(
      isSensitiveSociety({ categories: ordinary, audiences: ["international", "women"] }),
    ).toBe(false)
  })
})

describe("isOwnSocietyPage", () => {
  test("same host, www aside", () => {
    expect(isOwnSocietyPage("https://www.cuquokka.org/committee", "https://cuquokka.org")).toBe(
      true,
    )
    expect(isOwnSocietyPage("http://cuquokka.org/", "https://www.cuquokka.org/")).toBe(true)
    expect(isOwnSocietyPage("https://blog.cuquokka.org/x", "https://cuquokka.org/")).toBe(false)
    expect(isOwnSocietyPage("https://cuquokka.org.evil.example/", "https://cuquokka.org/")).toBe(
      false,
    )
  })

  test("a folder on a shared host: that folder only", () => {
    const site = "https://sites.google.com/cam.ac.uk/quokka"
    expect(isOwnSocietyPage("https://sites.google.com/cam.ac.uk/quokka", site)).toBe(true)
    expect(isOwnSocietyPage("https://sites.google.com/cam.ac.uk/quokka/committee", site)).toBe(true)
    expect(isOwnSocietyPage("https://sites.google.com/cam.ac.uk/quokkaball", site)).toBe(false)
    expect(isOwnSocietyPage("https://sites.google.com/cam.ac.uk/other", site)).toBe(false)
    // A site recorded by its start file is its folder.
    const file = "https://quokka.soc.example.net/club/index.html"
    expect(isOwnSocietyPage("https://quokka.soc.example.net/club/committee.html", file)).toBe(true)
    expect(isOwnSocietyPage("https://quokka.soc.example.net/other/", file)).toBe(false)
  })

  test("no website, not a URL, not http", () => {
    expect(isOwnSocietyPage("https://cuquokka.org/", undefined)).toBe(false)
    expect(isOwnSocietyPage("manual:broker", "https://cuquokka.org/")).toBe(false)
    expect(isOwnSocietyPage("ftp://cuquokka.org/", "https://cuquokka.org/")).toBe(false)
  })
})

describe("sensitiveOfficerProblem", () => {
  const society = {
    name: "Quokka Pride",
    website: "https://pride.example.org/",
    because: ["LGBTQ+"],
  }
  const draft = {
    sourceUrl: "https://pride.example.org/committee",
    staleAfter: "2027-06-30",
    consentBasis: "legitimate_interest",
    publicLinks: [],
  }

  test("null for an ordinary society or a draft that keeps the rules", () => {
    expect(
      sensitiveOfficerProblem({ ...society, because: [] }, { ...draft, notes: "x" }, "2027-06-30"),
    ).toBeNull()
    expect(sensitiveOfficerProblem(society, draft, "2027-06-30", "2027-06-30")).toBeNull()
  })

  test("names the first rule a draft breaks", () => {
    const problem = (extra: object, previous?: string) =>
      sensitiveOfficerProblem(society, { ...draft, ...extra }, "2027-06-30", previous)
    expect(problem({ sourceUrl: "manual:broker" })).toContain("Give the page of pride.example.org")
    expect(problem({ publicLinks: [{}] })).toContain("Remove the profile links")
    expect(problem({ notes: "x" })).toContain("Remove the notes")
    expect(problem({ staleAfter: "2027-07-01" })).toContain("no later than 2027-06-30")
    expect(problem({}, "2026-06-30")).toContain("cannot be moved later")
    expect(problem({ consentBasis: "consent" })).toContain("explicit consent recorded")
    expect(problem({ consentBasis: "consent", consentRecord: { recordedOn: "x" } })).toBeNull()
  })
})
