import { describe, expect, test } from "bun:test"
import { venueDisplayName } from "./venue-name"
import fixtures from "./venue-name.fixtures.json"

/** The rule shared with the pipeline: `venue-name.fixtures.json` is asserted
 * here and by pipeline/src/tests/test_venue_name.py. */
describe("venueDisplayName", () => {
  for (const { input, output } of fixtures.cases) {
    test(JSON.stringify(input), () => {
      expect(venueDisplayName(input)).toBe(output)
    })
  }

  test("is idempotent", () => {
    for (const { input } of fixtures.cases) {
      const once = venueDisplayName(input)
      expect(venueDisplayName(once)).toBe(once)
    }
  })
})
