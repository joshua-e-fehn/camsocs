import { expect, test } from "bun:test"
import { pageNumbers } from "./pagination"

test("first, last, current and neighbours, with gaps", () => {
  expect(pageNumbers(1, 34)).toEqual([1, 2, "gap", 34])
  expect(pageNumbers(5, 34)).toEqual([1, "gap", 4, 5, 6, "gap", 34])
  expect(pageNumbers(34, 34)).toEqual([1, "gap", 33, 34])
})

test("a gap of one page shows the page", () => {
  expect(pageNumbers(4, 34)).toEqual([1, 2, 3, 4, 5, "gap", 34])
  expect(pageNumbers(2, 4)).toEqual([1, 2, 3, 4])
})

test("one page or none", () => {
  expect(pageNumbers(1, 1)).toEqual([1])
  expect(pageNumbers(1, 0)).toEqual([1])
})
