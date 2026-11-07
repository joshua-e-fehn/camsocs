import type { Metadata } from "next"
import { FeedManager } from "@/components/organisms/feed-manager"
import { pageMetadata } from "@/lib/page-metadata"

/** "My calendar" (ENG-129): a browser's own feed; never indexed. */
export const metadata: Metadata = {
  ...pageMetadata({
    title: "My CAMsocs calendar",
    description: "The societies your CAMsocs calendar follows, to add or remove.",
    path: "/finder/calendar",
  }),
  robots: { index: false, follow: true },
}

export default function MyCalendarPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em]">
        My calendar
      </h1>
      <FeedManager />
    </div>
  )
}
