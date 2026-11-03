import { describe, expect, test } from "bun:test"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { renderToString } from "react-dom/server"
import { RequestForm } from "@/components/organisms/request-form"

// An invented listing and event key only.

const ORG = { key: "org-invented", slug: "invented-society", name: "Invented Society" }
const EVENT_KEY = `evt-${"e".repeat(40)}`

function render(props: Parameters<typeof RequestForm>[0]): string {
  const client = new ConvexReactClient("https://invented-test-1.convex.cloud")
  const html = renderToString(
    <ConvexProvider client={client}>
      <RequestForm {...props} />
    </ConvexProvider>,
  )
  void client.close()
  return html
}

describe("the request form opened from an event page (event-correction-link)", () => {
  test("is a correction about that event, named in the server HTML by its key alone", () => {
    const html = render({ initialKind: "correct", initialOrg: ORG, initialEventKey: EVENT_KEY })
    expect(html).toMatch(
      /id="kind-correct"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="kind-correct"/,
    )
    expect(html).toContain('id="request-event"')
    expect(html).toContain(EVENT_KEY)
    // A box a <label for> cannot name: the group is named by its title.
    expect(html).toMatch(/role="group"[^>]*aria-labelledby="request-event-label"/)
    expect(html).toContain('id="request-event-label"')
    expect(html).not.toContain('for="request-event"')
    expect(html).toContain('aria-label="Not about this event"')
  })

  test("without an event, there is no event field", () => {
    const html = render({ initialKind: "correct", initialOrg: ORG })
    expect(html).not.toContain('id="request-event"')
  })

  test("an add request is about no event", () => {
    const html = render({ initialKind: "add", initialOrg: null, initialEventKey: EVENT_KEY })
    expect(html).not.toContain(EVENT_KEY)
  })
})
