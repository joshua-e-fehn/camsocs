import { describe, expect, test } from "bun:test"
import { CONFIRM_PATH, confirmLinkFor, VERIFY_PATH, verifyPathFromFragment } from "./sign-in-link"

const VERIFY =
  "https://camsocs.uk/api/auth/magic-link/verify?token=qUvUYHYUeVNIiXnEGwbcTxiNoxhGoIQb&callbackURL=%2F%3Fsigned_in%3Dcam&errorCallbackURL=%2Fsign-in%3Fcam%3D1"

describe("confirmLinkFor", () => {
  test("puts the whole verify query in the fragment of the confirm page", () => {
    const link = confirmLinkFor(VERIFY)
    expect(link.startsWith(`https://camsocs.uk${CONFIRM_PATH}#token=`)).toBe(true)
    // Nothing a server sees (path and query) carries the token.
    const url = new URL(link)
    expect(url.search).toBe("")
    expect(url.pathname).toBe(CONFIRM_PATH)
  })

  test("round-trips to the original verify path", () => {
    const fragment = new URL(confirmLinkFor(VERIFY)).hash
    const original = new URL(VERIFY)
    expect(verifyPathFromFragment(fragment)).toBe(`${VERIFY_PATH}${original.search}`)
  })
})

describe("verifyPathFromFragment", () => {
  test("refuses anything that is not a sign-in link", () => {
    expect(verifyPathFromFragment("")).toBeNull()
    expect(verifyPathFromFragment("#token=short")).toBeNull()
    expect(verifyPathFromFragment("#token=qUvUYHYUeVNIiXnEGwbcTxiNoxhGoIQb&next=/x")).toBeNull()
    expect(verifyPathFromFragment("#token=a%20b%20c%20d%20e%20f%20g%20h%20i")).toBeNull()
  })

  test("refuses callbacks that leave the site", () => {
    const token = "token=qUvUYHYUeVNIiXnEGwbcTxiNoxhGoIQb"
    expect(verifyPathFromFragment(`#${token}&callbackURL=https://evil.example`)).toBeNull()
    expect(verifyPathFromFragment(`#${token}&callbackURL=//evil.example`)).toBeNull()
    expect(verifyPathFromFragment(`#${token}&errorCallbackURL=/%5Cevil.example`)).toBeNull()
    expect(verifyPathFromFragment(`#${token}&token=qUvUYHYUeVNIiXnEGwbcTxiNoxhGoIQc`)).toBeNull()
  })

  test("accepts a bare token", () => {
    expect(verifyPathFromFragment("token=qUvUYHYUeVNIiXnEGwbcTxiNoxhGoIQb")).toBe(
      `${VERIFY_PATH}?token=qUvUYHYUeVNIiXnEGwbcTxiNoxhGoIQb`,
    )
  })
})
