import { describe, expect, test } from "bun:test"
import { AUDIENCE_PAGES, audienceIntro, joinLabels, unionCards } from "./audience-hubs"
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "./page-metadata"
import { PAGE_PATHS } from "./sitemap"

const card = (key: string, name: string, categories: string[] = ["sport"]) =>
  ({ key, slug: key, name, collegeKeys: [], categories }) as never

describe("audience pages", () => {
  test("fit a search result, are in the sitemap and never use a sensitive audience", () => {
    for (const page of AUDIENCE_PAGES) {
      expect(page.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      expect(page.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      expect(PAGE_PATHS as readonly string[]).toContain(page.path)
      for (const query of page.queries)
        expect(["lgbtq", "women", "men"]).not.toContain(query.audience ?? "")
    }
  })

  test("unionCards keeps each listing once, by name", () => {
    const cards = unionCards([[card("b", "Bravo"), card("a", "Alpha")], [card("a", "Alpha")]])
    expect(cards.map((c: { key: string }) => c.key)).toEqual(["a", "b"])
  })

  test("the intro counts the listings, names the main areas and says how the list is made", () => {
    const [page] = AUDIENCE_PAGES
    const text = audienceIntro(page, [
      card("a", "A", ["sport"]),
      card("b", "B", ["sport", "music"]),
    ])
    expect(text).toStartWith(
      "CAMsocs lists 2 societies and clubs for beginners, most of them in Sport",
    )
    expect(text).toEndWith(page.how)
    expect(audienceIntro(page, [])).toBe("CAMsocs lists no societies for beginners yet.")
  })
})

test("joinLabels keeps a label's own comma readable", () => {
  expect(joinLabels(["Sport", "Music", "Drama"])).toBe("Sport, Music and Drama")
  expect(joinLabels(["Academic", "Identity, Community & Wellbeing"])).toBe(
    "Academic and Identity, Community & Wellbeing",
  )
  expect(joinLabels(["A", "Identity, Community & Wellbeing", "C"])).toBe(
    "A; Identity, Community & Wellbeing and C",
  )
})
