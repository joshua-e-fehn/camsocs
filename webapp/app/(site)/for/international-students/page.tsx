import type { Metadata } from "next"
import { AudienceHub } from "@/components/organisms/audience-hub"
import { audiencePage } from "@/lib/audience-hubs"
import { pageMetadata } from "@/lib/page-metadata"

/** Societies for international-students (ENG-118, lib/audience-hubs.ts). */
const PAGE = audiencePage("international-students")

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

export default function Page() {
  return <AudienceHub page={PAGE} />
}
