import { expect, test } from "bun:test"
import { pageNumbers } from "./pagination"

test("first, last, current and two each side, every tenth page, with gaps", () => {
  expect(pageNumbers(1, 34)).toEqual([1, 2, 3, "gap", 10, "gap", 20, "gap", 30, "gap", 34])
  expect(pageNumbers(17, 34)).toEqual([
    1,
    "gap",
    10,
    "gap",
    15,
    16,
    17,
    18,
    19,
    20,
    "gap",
    30,
    "gap",
    34,
  ])
  expect(pageNumbers(34, 34)).toEqual([1, "gap", 10, "gap", 20, "gap", 30, 31, 32, 33, 34])
})

test("a gap of one page shows the page", () => {
  expect(pageNumbers(5, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, "gap", 10, 11, 12])
  expect(pageNumbers(2, 4)).toEqual([1, 2, 3, 4])
})

test("no page of 34 is more than four clicks from the first (it was 16)", () => {
  const total = 34
  const depth = new Map([[1, 0]])
  const queue = [1]
  while (queue.length > 0) {
    const page = queue.shift() as number
    for (const next of pageNumbers(page, total)) {
      if (next === "gap" || depth.has(next)) continue
      depth.set(next, (depth.get(page) ?? 0) + 1)
      queue.push(next)
    }
  }
  expect(depth.size).toBe(total)
  expect(Math.max(...depth.values())).toBeLessThanOrEqual(4)
})

test("one page or none", () => {
  expect(pageNumbers(1, 1)).toEqual([1])
  expect(pageNumbers(1, 0)).toEqual([1])
})
