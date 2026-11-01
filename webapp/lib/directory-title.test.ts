import { expect, test } from "bun:test"
import { directoryTitle } from "./directory-title"

test("the directory's title names a query, else a single category", () => {
  expect(directoryTitle({ q: "chess", categories: ["sport"] })).toBe(
    "“chess” — societies and clubs",
  )
  expect(directoryTitle({ categories: ["sport"] })).toBe("Sport & Fitness societies and clubs")
  expect(directoryTitle({ categories: ["sport", "music"] })).toBe("Societies and clubs")
})
