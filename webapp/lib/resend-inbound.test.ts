import { describe, expect, test } from "bun:test"
import { INBOUND_LIMITS } from "./inbound-email"
import { fetchReceivedAttachments, fetchReceivedEmail, ResendError } from "./resend-inbound"

type Call = { url: string; headers: Record<string, string> }

function fakeFetch(routes: Record<string, () => Response>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return route()
  }
}

const EMAIL_URL = "https://api.resend.com/emails/receiving/e-1?html_format=cid"
const LIST_URL = "https://api.resend.com/emails/receiving/e-1/attachments"

describe("fetchReceivedEmail", () => {
  test("asks for cid HTML with the API key", async () => {
    const calls: Call[] = []
    const email = await fetchReceivedEmail(
      fakeFetch({ [EMAIL_URL]: () => Response.json({ html: "<p>x</p>", text: "x" }) }, calls),
      "re_test",
      "e-1",
    )
    expect(email.text).toBe("x")
    expect(calls[0].headers.Authorization).toBe("Bearer re_test")
  })

  test("a refusal is a transient ResendError, so the webhook asks for a retry", async () => {
    const promise = fetchReceivedEmail(
      fakeFetch({ [EMAIL_URL]: () => new Response("no", { status: 401 }) }),
      "re_test",
      "e-1",
    )
    await expect(promise).rejects.toBeInstanceOf(ResendError)
  })
})

describe("fetchReceivedAttachments", () => {
  test("downloads kept types and skips the rest before downloading", async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(
      {
        [LIST_URL]: () =>
          Response.json({
            data: [
              {
                filename: "termcard.png",
                size: 4,
                content_type: "image/png",
                download_url: "https://inbound-cdn.resend.com/a1",
              },
              {
                filename: "minutes.docx",
                size: 4,
                content_type: "application/vnd.openxmlformats-officedocument",
                download_url: "https://inbound-cdn.resend.com/a2",
              },
              {
                filename: "huge.pdf",
                size: INBOUND_LIMITS.maxAttachmentBytes + 1,
                content_type: "application/pdf",
                download_url: "https://inbound-cdn.resend.com/a3",
              },
            ],
          }),
        "https://inbound-cdn.resend.com/a1": () => new Response(new Uint8Array([1, 2, 3, 4])),
      },
      calls,
    )
    const result = await fetchReceivedAttachments(fetchImpl, "re_test", "e-1")
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toMatchObject({
      filename: "termcard.png",
      contentType: "image/png",
    })
    expect(result.skipped).toHaveLength(2)
    // Neither skipped file was downloaded.
    expect(calls.map((call) => call.url)).toEqual([LIST_URL, "https://inbound-cdn.resend.com/a1"])
  })
})
