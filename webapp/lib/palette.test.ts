import { describe, expect, test } from "bun:test"
import { firstPaletteValue, isForgetKey, matchesWords, recentOf, recentValue } from "./palette"

describe("the palette's first row", () => {
  test("is the first row of the first group with one, whatever the scope", () => {
    // All: societies first.
    expect(
      firstPaletteValue([["/societies/chess", "/societies?q=chess"], ["/events?q=chess"]]),
    ).toBe("/societies/chess")
    // Talks only: the first talk, else the "all talks" row.
    expect(firstPaletteValue([["/talks?talk=talk-1", "/talks?q=x"]])).toBe("/talks?talk=talk-1")
    expect(firstPaletteValue([[undefined, "/talks?q=x"]])).toBe("/talks?q=x")
    // Groups with nothing in them are skipped (colleges with no match).
    expect(firstPaletteValue([[], [undefined], ["/societies?cat=music"]])).toBe(
      "/societies?cat=music",
    )
    expect(firstPaletteValue([])).toBe("")
  })
})

describe("recent searches", () => {
  test("round-trip through a row value; other rows are not recents", () => {
    expect(recentOf(recentValue("jazz"))).toBe("jazz")
    expect(recentOf(recentValue("re:cent"))).toBe("re:cent")
    expect(recentOf("/societies?q=jazz")).toBeUndefined()
  })

  test("Delete or Shift+Backspace forgets one; Backspace alone does not", () => {
    expect(isForgetKey({ key: "Delete", shiftKey: false })).toBe(true)
    expect(isForgetKey({ key: "Backspace", shiftKey: true })).toBe(true)
    expect(isForgetKey({ key: "Backspace", shiftKey: false })).toBe(false)
    expect(isForgetKey({ key: "Enter", shiftKey: true })).toBe(false)
  })
})

describe("local matches", () => {
  test("every word, ignoring case and accents", () => {
    expect(matchesWords("Gonville & Caius College", "caius gon")).toBe(true)
    expect(matchesWords("Café Society", "cafe")).toBe(true)
    expect(matchesWords("Trinity Hall", "trinity college")).toBe(false)
  })
})
