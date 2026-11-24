import { describe, expect, test } from "bun:test"
import { EVENT_TYPE_ICONS, FILM_ICON, ITEM_ICONS, itemIconKey, TALK_KIND_ICONS } from "./item-icons"
import { EVENT_TYPES, TALK_KINDS } from "./vocab"

describe("item icons", () => {
  test("every event type and talk kind has an icon", () => {
    for (const type of EVENT_TYPES) expect(EVENT_TYPE_ICONS[type]).toBeDefined()
    for (const kind of TALK_KINDS) expect(TALK_KIND_ICONS[kind]).toBeDefined()
    expect(Object.keys(EVENT_TYPE_ICONS).sort()).toEqual([...EVENT_TYPES].sort())
    expect(Object.keys(TALK_KIND_ICONS).sort()).toEqual([...TALK_KINDS].sort())
  })

  test("every icon key resolves, film included", () => {
    expect(Object.keys(ITEM_ICONS)).toHaveLength(EVENT_TYPES.length + TALK_KINDS.length + 1)
    for (const type of EVENT_TYPES) expect(ITEM_ICONS[`event-${type}`]).toBe(EVENT_TYPE_ICONS[type])
    for (const kind of TALK_KINDS) expect(ITEM_ICONS[`talk-${kind}`]).toBe(TALK_KIND_ICONS[kind])
    expect(ITEM_ICONS.film).toBe(FILM_ICON)
  })

  test("an item's key: film first, else its type, else other", () => {
    expect(itemIconKey({ kind: "event", eventType: "performance", precision: "film" })).toBe("film")
    expect(itemIconKey({ kind: "event", eventType: "formal" })).toBe("event-formal")
    expect(itemIconKey({ kind: "event" })).toBe("event-other")
    expect(itemIconKey({ kind: "talk", talkKind: "lecture" })).toBe("talk-lecture")
    expect(itemIconKey({ kind: "talk" })).toBe("talk-other")
  })
})
