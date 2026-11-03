import { describe, expect, test } from "bun:test"
import {
  CATEGORIES_PATH,
  categoryFromSlug,
  categoryHubIntro,
  categoryHubPath,
  categoryHubPaths,
  collectionJsonLd,
  collegeHubIntro,
  directorySeo,
  groupByCategory,
  type HubCard,
  typeSummary,
} from "./directory-hubs"
import { EMPTY_DIRECTORY } from "./url-state"
import { CATEGORIES } from "./vocab"

const card = (overrides: Partial<HubCard> & { key: string }): HubCard => ({
  slug: overrides.key.replace(/^org-/, ""),
  name: overrides.key,
  collegeKeys: [],
  categories: [],
  ...overrides,
})

describe("category hub paths (G13)", () => {
  test("one per category, outside /societies so no slug can collide", () => {
    const paths = categoryHubPaths()
    expect(paths).toHaveLength(CATEGORIES.length)
    for (const path of paths) expect(path.startsWith(`${CATEGORIES_PATH}/`)).toBe(true)
    expect(categoryHubPath("science_tech")).toBe("/categories/science-tech")
  })

  test("a slug reads back to its category; anything else to nothing", () => {
    for (const category of CATEGORIES) {
      expect(categoryFromSlug(categoryHubPath(category).split("/").pop() ?? "")).toBe(category)
    }
    expect(categoryFromSlug("science_tech")).toBeUndefined()
    expect(categoryFromSlug("chess-club")).toBeUndefined()
  })
})

describe("directorySeo: the directory's canonical and robots", () => {
  const slugs = (key: string) => (key === "org-trinity" ? "trinity" : undefined)

  test("plain pages are their own canonical and indexed", () => {
    expect(directorySeo(EMPTY_DIRECTORY, slugs)).toEqual({ canonical: "/societies", index: true })
    expect(directorySeo({ ...EMPTY_DIRECTORY, page: 7 }, slugs)).toEqual({
      canonical: "/societies?page=7",
      index: true,
    })
  })

  test("one category or one college points at its hub", () => {
    expect(directorySeo({ ...EMPTY_DIRECTORY, categories: ["sport"] }, slugs)).toEqual({
      canonical: "/categories/sport",
      index: true,
    })
    expect(directorySeo({ ...EMPTY_DIRECTORY, collegeKeys: ["org-trinity"] }, slugs)).toEqual({
      canonical: "/societies/trinity",
      index: true,
    })
    // Its later pages and other orders are subsets of the hub: the canonical
    // alone says so, never with a contradicting noindex.
    for (const extra of [{ page: 2 }, { sort: "active" as const }]) {
      expect(directorySeo({ ...EMPTY_DIRECTORY, categories: ["sport"], ...extra }, slugs)).toEqual({
        canonical: "/categories/sport",
        index: true,
      })
      expect(
        directorySeo({ ...EMPTY_DIRECTORY, collegeKeys: ["org-trinity"], ...extra }, slugs),
      ).toEqual({ canonical: "/societies/trinity", index: true })
    }
  })

  test("searches, combinations, other filters and orders are noindex", () => {
    for (const state of [
      { ...EMPTY_DIRECTORY, q: "jazz" },
      { ...EMPTY_DIRECTORY, categories: ["sport" as const, "music" as const] },
      { ...EMPTY_DIRECTORY, categories: ["sport" as const], levels: ["university" as const] },
      { ...EMPTY_DIRECTORY, levels: ["university" as const] },
      { ...EMPTY_DIRECTORY, sort: "active" as const },
      { ...EMPTY_DIRECTORY, collegeKeys: ["org-unknown"] },
    ]) {
      expect(directorySeo(state, slugs)).toEqual({ canonical: "/societies", index: false })
    }
  })
})

describe("hub intros say only what the counts say", () => {
  const cards = [
    card({ key: "org-a", level: "university", categories: ["sport", "outdoors"] }),
    card({ key: "org-b", level: "college", collegeKeys: ["org-x"], categories: ["sport"] }),
    card({ key: "org-c", level: "university", categories: ["sport", "outdoors"] }),
  ]

  test("category hub", () => {
    expect(categoryHubIntro("sport", cards)).toBe(
      "CAMsocs lists 3 Cambridge student groups under Sport & Fitness: 2 university-wide and 1 run within a college. Many are also listed under Outdoors & Adventure. Each listing links to its sources; nothing here is official.",
    )
    expect(categoryHubIntro("music", [])).toContain("no Music groups")
  })

  test("college hub", () => {
    const college = [
      card({ key: "org-jcr", orgType: "jcr", categories: ["identity_wellbeing"] }),
      card({ key: "org-bc", orgType: "college_boat_club", categories: ["sport"] }),
      card({ key: "org-fb", orgType: "college_club", categories: ["sport"] }),
      card({ key: "org-ch", orgType: "college_club", categories: ["music"] }),
    ]
    expect(typeSummary(college)).toBe("2 college clubs, a boat club and a JCR")
    expect(collegeHubIntro("Christ's College", college)).toBe(
      "CAMsocs lists 4 student societies and clubs at Christ's College, Cambridge, including 2 college clubs, a boat club and a JCR. The most common areas are Sport & Fitness, Identity, Community & Wellbeing and Music. Each listing links to its sources; nothing here is run by the college.",
    )
    expect(collegeHubIntro("Christ's College", [])).toContain("no societies or clubs")
  })

  test("groups by first category, biggest first, uncategorised last", () => {
    const groups = groupByCategory([
      card({ key: "org-1", categories: ["music"] }),
      card({ key: "org-2" }),
      card({ key: "org-3", categories: ["sport"] }),
      card({ key: "org-4", categories: ["sport", "music"] }),
    ])
    expect(groups.map((group) => [group.label, group.cards.length])).toEqual([
      ["Sport & Fitness", 2],
      ["Music", 1],
      ["Other", 1],
    ])
  })
})

test("collectionJsonLd: a CollectionPage, its ItemList and breadcrumbs in one graph", () => {
  const data = collectionJsonLd({
    path: "/categories/sport",
    title: "Sport & Fitness clubs in Cambridge",
    description: "Intro.",
    items: [
      { name: "Boat Club", path: "/societies/boat" },
      { name: "Netball Club", path: "/societies/netball" },
    ],
    crumbs: [
      { name: "Societies", path: "/societies" },
      { name: "Sport & Fitness", path: "/categories/sport" },
    ],
  })
  const [page, list, crumbs] = data["@graph"] as Record<string, unknown>[]
  expect(page).toMatchObject({
    "@type": "CollectionPage",
    "@id": "https://camsocs.uk/categories/sport",
    isPartOf: { "@id": "https://camsocs.uk/#website" },
    mainEntity: { "@id": "https://camsocs.uk/categories/sport#list" },
  })
  expect(list).toEqual({
    "@type": "ItemList",
    "@id": "https://camsocs.uk/categories/sport#list",
    numberOfItems: 2,
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Boat Club",
        url: "https://camsocs.uk/societies/boat",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Netball Club",
        url: "https://camsocs.uk/societies/netball",
      },
    ],
  })
  expect(crumbs).toMatchObject({ "@type": "BreadcrumbList" })
  const paged = collectionJsonLd({
    path: "/societies?page=2",
    title: "t",
    description: "d",
    items: [{ name: "X", path: "/societies/x" }],
    crumbs: [],
    offset: 24,
    total: 800,
  })
  const pagedList = (paged["@graph"] as Record<string, unknown>[])[1]
  expect(pagedList).toMatchObject({
    numberOfItems: 800,
    itemListElement: [{ position: 25 }],
  })
})
