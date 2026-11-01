import { PageSkeleton } from "@/components/molecules/page-skeleton"

/** An event's page loads in the shape of a page, not of the calendar's list. */
export default function Loading() {
  return <PageSkeleton shape="profile" />
}
