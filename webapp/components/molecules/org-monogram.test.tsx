import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { OrgMonogram } from "@/components/molecules/org-monogram"

/** A fixed-size logo carries a 1x/2x srcset, not every width Next knows
 * (html-bloat). */
test("a logo tile asks for its own size and its double only", () => {
  const html = renderToStaticMarkup(
    <OrgMonogram name="Chess Club" url="https://example.convex.cloud/api/storage/abc" size={44} />,
  )
  const srcSet = html.match(/srcSet="([^"]+)"/i)?.[1] ?? ""
  const candidates = srcSet.split(", ").map((part) => part.split(" ").at(-1))
  expect(candidates).toEqual(["1x", "2x"])
  expect(html).not.toContain("sizes=")
})

test("without a logo it draws initials, and no image", () => {
  const html = renderToStaticMarkup(<OrgMonogram name="Chess Club" size={44} />)
  expect(html).not.toContain("<img")
  expect(html).toContain("<span")
})
