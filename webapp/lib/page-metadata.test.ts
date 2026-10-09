import { expect, test } from "bun:test"
import { pageMetadata, SHARE_IMAGE } from "./page-metadata"
import { SITE_NAME } from "./site"

test("a page's own title and description reach its share card, with the site's image", () => {
  const metadata = pageMetadata({
    title: "Chess Club",
    description: "Weekly club nights.",
    path: "/societies/chess",
  })
  expect(metadata.alternates?.canonical).toBe("/societies/chess")
  expect(metadata.openGraph).toMatchObject({
    title: "Chess Club",
    description: "Weekly club nights.",
    url: "/societies/chess",
    siteName: SITE_NAME,
    locale: "en_GB",
    images: [SHARE_IMAGE],
  })
  expect(metadata.twitter).toMatchObject({ title: "Chess Club", images: [SHARE_IMAGE.url] })
})
