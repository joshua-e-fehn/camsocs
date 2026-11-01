import { expect, test } from "bun:test"
import { CATEGORY_TONE, CATEGORY_TONES, categoryTone } from "./category-tone"
import { CATEGORIES } from "./vocab"

test("every category has a tone, and every tone is used", () => {
  expect(Object.keys(CATEGORY_TONE).sort()).toEqual([...CATEGORIES].sort())
  expect(new Set(Object.values(CATEGORY_TONE))).toEqual(new Set(CATEGORY_TONES))
})

test("a listing takes its first category's tone, else neutral", () => {
  expect(categoryTone(["sport", "music"])).toBe("teal")
  expect(categoryTone("music")).toBe("plum")
  expect(categoryTone([])).toBe("neutral")
  expect(categoryTone(undefined)).toBe("neutral")
})
