import { describe, expect, test } from "bun:test"
import { eventSeriesOf, seriesNameOf, seriesOf, seriesSlugOf } from "./eventSeries"

const org = { organiserKeys: ["org-greek-play"] }

describe("event series (ENG-282)", () => {
  test("an edition title gives the name before its year", () => {
    expect(seriesNameOf("The Cambridge Greek Play 2026")).toBe("The Cambridge Greek Play")
    expect(seriesNameOf("CUADC/Footlights Pantomime 2026: Cinderella")).toBe(
      "CUADC/Footlights Pantomime",
    )
    expect(seriesNameOf("PdOC Research Showcase 2027 (6th edition)")).toBe("PdOC Research Showcase")
    expect(seriesNameOf("Footlights ADC Smokers: Michaelmas 2026")).toBe("Footlights ADC Smokers")
    expect(seriesNameOf("Varsity BJJ November 2026")).toBe("Varsity BJJ")
    expect(seriesNameOf("Kiss, Marry, Kill - CUMTS Freshers Musical 2026")).toBe(
      "CUMTS Freshers Musical",
    )
    expect(seriesNameOf("CyberSci Regional Qualifiers 2026-27")).toBe(
      "CyberSci Regional Qualifiers",
    )
  })

  test("a year that is a topic, a date or too little of a name is no series", () => {
    expect(seriesNameOf("Panel discussion: 2026 US Midterm Elections")).toBeNull()
    expect(seriesNameOf("Writing a History of the Library Society, 1748–2026")).toBeNull()
    expect(seriesNameOf("Laidlaw Scholars 2025 Cohort Graduation")).toBeNull()
    expect(seriesNameOf("GLOBAL CULTURES: ISE WORKSHOP 10 NOV 2026")).toBeNull()
    expect(seriesNameOf("ETG 2026: Antony and Cleopatra")).toBeNull()
    expect(seriesNameOf("Weekly rehearsal")).toBeNull()
  })

  test("one series per organiser and name, whatever the year or punctuation", () => {
    const a = seriesOf({ ...org, title: "The Cambridge Greek Play 2026" })
    const b = seriesOf({ ...org, title: "the Cambridge Greek Play – 2029" })
    expect(a?.key).toBe(b?.key as string)
    expect(
      seriesOf({ organiserKeys: ["org-other"], title: "The Cambridge Greek Play 2026" })?.key,
    ).not.toBe(a?.key as string)
  })

  test("curated fixtures match without a year, across organisers", () => {
    const one = seriesOf({
      organiserKeys: ["org-jesus-bc"],
      title: "Fairbairn Cup - Seniors (Jesus)",
    })
    const two = seriesOf({ organiserKeys: ["org-clare-hall-bc"], title: "Fairbairn Cup (novices)" })
    expect(one).toEqual({
      key: "ser-fairbairn-cup",
      name: "The Fairbairn Cup (Fairbairns)",
      slug: "fairbairn-cup",
    })
    expect(two?.key).toBe("ser-fairbairn-cup")
    expect(seriesOf({ organiserKeys: [], title: "The Steele Bodger Match" })?.slug).toBe(
      "steele-bodger",
    )
  })

  test("someone else's event and a talks.cam-derived one are never a series", () => {
    expect(seriesOf({ ...org, title: "CSCTF 2026", hosting: "takes_part" })).toBeNull()
    expect(eventSeriesOf({ ...org, title: "Lecture Series 2026", source: "talks_cam" })).toBeNull()
    expect(
      eventSeriesOf({ ...org, title: "Cambridge Oktoberfest 2026", source: "manual" })?.name,
    ).toBe("Cambridge Oktoberfest")
  })

  test("slugs are plain words", () => {
    expect(seriesSlugOf("The Cambridge Greek Play")).toBe("cambridge-greek-play")
    expect(seriesSlugOf("Michaelmas Beginner's White Water Trip")).toBe(
      "michaelmas-beginners-white-water-trip",
    )
    expect(seriesSlugOf("CUADC/Footlights Pantomime")).toBe("cuadc-footlights-pantomime")
  })
})
