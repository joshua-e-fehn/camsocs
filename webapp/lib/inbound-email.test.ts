import { describe, expect, test } from "bun:test"
import {
  addressesIn,
  attachmentType,
  base64ToBytes,
  bytesToBase64,
  chooseText,
  headerValue,
  htmlToText,
  INBOUND_LIMITS,
  normaliseMessageId,
  parseGenericPayload,
  parseListId,
  parseResendWebhook,
  plausibleDate,
  recipientAllowed,
  resendMessage,
  verifySvixSignature,
} from "./inbound-email"

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)

describe("headers", () => {
  test("headerValue is case-insensitive and takes the first of repeated values", () => {
    const headers = { "List-ID": "<soc-x.lists.cam.ac.uk>", received: ["a", "b"] }
    expect(headerValue(headers, "list-id")).toBe("<soc-x.lists.cam.ac.uk>")
    expect(headerValue(headers, "Received")).toBe("a")
    expect(headerValue(headers, "date")).toBeUndefined()
    expect(headerValue(null, "date")).toBeUndefined()
  })

  test("parseListId reads RFC 2919 ids with and without a phrase", () => {
    expect(parseListId('"CU German Society" <soc-cugs.lists.cam.ac.uk>')).toEqual({
      listId: "soc-cugs.lists.cam.ac.uk",
      listName: "CU German Society",
    })
    expect(parseListId("Weekly news <SOC-CUGS-NEWS.lists.cam.ac.uk>")).toEqual({
      listId: "soc-cugs-news.lists.cam.ac.uk",
      listName: "Weekly news",
    })
    expect(parseListId("<soc-x.lists.cam.ac.uk>")).toEqual({ listId: "soc-x.lists.cam.ac.uk" })
    expect(parseListId("soc-x.lists.cam.ac.uk")).toEqual({ listId: "soc-x.lists.cam.ac.uk" })
    expect(parseListId("not a list id at all")).toEqual({})
    expect(parseListId(undefined)).toEqual({})
  })

  test("normaliseMessageId adds missing angle brackets and strips whitespace", () => {
    expect(normaliseMessageId(" <a@b> ")).toBe("<a@b>")
    expect(normaliseMessageId("a@b")).toBe("<a@b>")
    expect(normaliseMessageId("")).toBeUndefined()
    expect(normaliseMessageId(42)).toBeUndefined()
  })

  test("addressesIn pulls bare addresses out of header values", () => {
    expect(addressesIn(['"Inbox" <Lists-x7@In.Example.org>', "b@example.org"])).toEqual([
      "lists-x7@in.example.org",
      "b@example.org",
    ])
  })

  test("recipientAllowed: unset accepts all, set requires a match", () => {
    expect(recipientAllowed(undefined, ["x@y.org"])).toBe(true)
    expect(recipientAllowed(" , ", ["x@y.org"])).toBe(true)
    expect(recipientAllowed("in-7f3@in.example.org", ["IN-7F3@in.example.org"])).toBe(true)
    expect(recipientAllowed("in-7f3@in.example.org", ["other@in.example.org"])).toBe(false)
    expect(recipientAllowed("in-7f3@in.example.org", [])).toBe(false)
  })

  test("plausibleDate accepts a Date header within a week only", () => {
    expect(plausibleDate("Wed, 07 Oct 2026 09:30:00 +0100", NOW)).toBe(
      Date.UTC(2026, 9, 7, 8, 30, 0),
    )
    expect(plausibleDate("Thu, 01 Jan 1970 00:00:00 +0000", NOW)).toBeUndefined()
    // A sender clock an hour fast is clamped to now; days fast is ignored.
    expect(plausibleDate("Wed, 07 Oct 2026 13:00:00 +0000", NOW)).toBe(NOW)
    expect(plausibleDate("Sat, 10 Oct 2026 12:00:00 +0000", NOW)).toBeUndefined()
    expect(plausibleDate("garbage", NOW)).toBeUndefined()
  })
})

describe("bodies", () => {
  test("htmlToText keeps link targets, list items and paragraphs", () => {
    const html = `<html><head><style>p{}</style></head><body>
      <p>Hello&nbsp;all!</p><ul><li>Pub quiz &amp; chips</li></ul>
      <p><a href="https://example.org/tickets">Book here</a> or <a href="mailto:x@y">mail</a></p>
      <script>alert(1)</script></body></html>`
    const text = htmlToText(html)
    expect(text).toContain("Hello all!")
    expect(text).toContain("- Pub quiz & chips")
    expect(text).toContain("Book here (https://example.org/tickets)")
    expect(text).not.toContain("alert")
    expect(text).not.toContain("mailto")
  })

  test("chooseText prefers a real text part and falls back to the HTML", () => {
    const html = `<p>${"Long newsletter body. ".repeat(50)}</p>`
    expect(chooseText("View this email in your browser", html)).toContain("Long newsletter body")
    expect(chooseText("Plain text body that is the whole mail", "<p>Plain</p>")).toBe(
      "Plain text body that is the whole mail",
    )
    expect(chooseText(undefined, "<p>Only html</p>")).toBe("Only html")
    expect(chooseText("x".repeat(INBOUND_LIMITS.maxTextChars + 10), undefined)).toHaveLength(
      INBOUND_LIMITS.maxTextChars,
    )
  })

  test("base64 round-trips binary", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
  })

  test("attachmentType keeps images, PDF and calendars only", () => {
    expect(attachmentType("image/PNG; name=x.png", 10)).toBe("image/png")
    expect(attachmentType("text/calendar", 10)).toBe("text/calendar")
    expect(attachmentType("image/svg+xml", 10)).toEqual({ skip: "type image/svg+xml not kept" })
    expect(attachmentType("application/zip", 10)).toMatchObject({ skip: expect.any(String) })
    expect(attachmentType("image/png", INBOUND_LIMITS.maxAttachmentBytes + 1)).toMatchObject({
      skip: expect.stringContaining("larger"),
    })
  })
})

describe("parseGenericPayload", () => {
  const base = {
    messageId: "abc@lists.cam.ac.uk",
    from: '"ZZ Test Society" <events@zz-test.example.org>',
    to: ["inbox@in.example.org"],
    subject: "This week",
    text: "Pub quiz on Wednesday of Week 3 at 7pm.",
    headers: {
      "List-Id": "ZZ Test <soc-zztest.lists.cam.ac.uk>",
      Date: "Wed, 7 Oct 2026 10:00:00 +0100",
    },
    attachments: [
      { filename: "termcard.png", contentType: "image/png", contentBase64: btoa("\x89PNG...") },
      { filename: "minutes.docx", contentType: "application/msword", contentBase64: btoa("x") },
    ],
  }

  test("normalises a full payload", () => {
    const parsed = parseGenericPayload(base, NOW)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toMatchObject({
      messageId: "<abc@lists.cam.ac.uk>",
      receivedAt: Date.UTC(2026, 9, 7, 9, 0, 0),
      listId: "soc-zztest.lists.cam.ac.uk",
      listName: "ZZ Test",
      to: ["inbox@in.example.org"],
      text: base.text,
    })
    expect(parsed.value.attachments.map((a) => a.filename)).toEqual(["termcard.png"])
    expect(parsed.value.skipped).toEqual(["minutes.docx: type application/msword not kept"])
  })

  test("refuses what is missing or malformed", () => {
    expect(parseGenericPayload({ ...base, messageId: "" }, NOW)).toMatchObject({ ok: false })
    expect(parseGenericPayload({ ...base, from: undefined }, NOW)).toMatchObject({ ok: false })
    expect(parseGenericPayload({ ...base, text: "", html: undefined }, NOW)).toMatchObject({
      ok: false,
    })
    expect(parseGenericPayload({ ...base, headers: [] }, NOW)).toMatchObject({ ok: false })
    expect(
      parseGenericPayload(
        { ...base, attachments: [{ filename: "a.png", contentType: "image/png" }] },
        NOW,
      ),
    ).toMatchObject({ ok: false })
    expect(parseGenericPayload([base], NOW)).toMatchObject({ ok: false })
  })

  test("an implausible Date falls back to now", () => {
    const parsed = parseGenericPayload(
      { ...base, headers: { Date: "Mon, 1 Jan 2001 00:00:00" } },
      NOW,
    )
    expect(parsed.ok && parsed.value.receivedAt).toBe(NOW)
  })
})

describe("Resend", () => {
  const webhook = {
    type: "email.received",
    created_at: "2026-10-07T11:00:00.000Z",
    data: {
      email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
      created_at: "2026-10-07T11:00:00.000Z",
      from: "sender@example.org",
      to: ["inbox@in.example.org"],
      cc: [],
      bcc: [],
      received_for: ["forwarded@example.org"],
      message_id: "<111-222@example.org>",
      subject: "Hello",
      attachments: [{ id: "a1", filename: "x.png", content_type: "image/png" }],
    },
  }

  test("parseResendWebhook reads email.received metadata and ignores other types", () => {
    const parsed = parseResendWebhook(webhook)
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        emailId: webhook.data.email_id,
        messageId: "<111-222@example.org>",
        to: ["inbox@in.example.org", "forwarded@example.org"],
        attachmentCount: 1,
      },
    })
    expect(parseResendWebhook({ ...webhook, type: "email.sent" })).toEqual({
      ok: true,
      value: null,
    })
    expect(parseResendWebhook({ ...webhook, data: { email_id: "../x" } })).toMatchObject({
      ok: false,
    })
  })

  test("resendMessage merges the retrieved body and headers", () => {
    const parsed = parseResendWebhook(webhook)
    if (!parsed.ok || !parsed.value) throw new Error("unreachable")
    const message = resendMessage(
      parsed.value,
      {
        html: "<p>Talk on <b>Thursday</b></p>",
        text: null,
        headers: {
          from: '"ZZ Society" <sender@example.org>',
          "list-id": "<soc-zz.lists.cam.ac.uk>",
          date: "Wed, 07 Oct 2026 11:30:00 +0000",
        },
      },
      NOW,
    )
    expect(message).toMatchObject({
      messageId: "<111-222@example.org>",
      from: '"ZZ Society" <sender@example.org>',
      text: "Talk on Thursday",
      listId: "soc-zz.lists.cam.ac.uk",
      receivedAt: Date.UTC(2026, 9, 7, 11, 30, 0),
    })
  })
})

describe("verifySvixSignature", () => {
  // The published example from https://docs.svix.com/receiving/verifying-payloads/how-manual.
  const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl"
  const body = '{"event_type":"ping","data":{"success":true}}'
  const headers = {
    id: "msg_loFOjxBNrRLzqYUf",
    timestamp: "1731705121",
    signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
  }

  test("accepts Svix's published example", async () => {
    expect(await verifySvixSignature(headers, body, secret, 1731705121)).toBe(true)
  })

  test("accepts when any of several signatures matches", async () => {
    const several = { ...headers, signature: `v1,AAAA ${headers.signature} v2,BBBB` }
    expect(await verifySvixSignature(several, body, secret, 1731705121)).toBe(true)
  })

  test("refuses a changed body, id, secret or a stale timestamp", async () => {
    expect(await verifySvixSignature(headers, `${body} `, secret, 1731705121)).toBe(false)
    expect(await verifySvixSignature({ ...headers, id: "msg_x" }, body, secret, 1731705121)).toBe(
      false,
    )
    expect(
      await verifySvixSignature(headers, body, "whsec_AAAAAAAAAAAAAAAAAAAAAAAA", 1731705121),
    ).toBe(false)
    expect(await verifySvixSignature(headers, body, secret, 1731705121 + 301)).toBe(false)
    expect(await verifySvixSignature(headers, body, undefined, 1731705121)).toBe(false)
    expect(await verifySvixSignature(headers, body, "", 1731705121)).toBe(false)
    expect(
      await verifySvixSignature(
        { ...headers, timestamp: "1731705121.5" },
        body,
        secret,
        1731705121,
      ),
    ).toBe(false)
  })
})
