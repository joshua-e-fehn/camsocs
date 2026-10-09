import { expect, test } from "bun:test"
import { monogram } from "./monogram"

test("initials skip the words every name shares", () => {
  expect(monogram("ABBA Support Society")).toBe("AS")
  expect(monogram("Cambridge University Triathlon Club")).toBe("T")
  expect(monogram("Ethics in Mathematics Society")).toBe("EM")
  expect(monogram("180 Degrees Consulting (Cambridge)")).toBe("1D")
  expect(monogram("Addenbrookes' Students' Sharks Mixed Netball Team")).toBe("AS")
})

test("a short acronym the organisation uses wins", () => {
  expect(monogram("Ethics in Mathematics Society", "EiM")).toBe("EIM")
  expect(monogram("Amateur Dramatic Club", "CUADC")).toBe("AD")
})

test("a name made only of shared words still gets initials", () => {
  expect(monogram("The Society")).toBe("TS")
  expect(monogram("Cambridge University")).toBe("CU")
  expect(monogram("—")).toBe("?")
})

test("letters outside ASCII are kept", () => {
  expect(monogram("Ölkännchen Gesellschaft")).toBe("ÖG")
})
