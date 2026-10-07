import { SearchXIcon } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/** A missing page or listing, inside the site frame. */
export default function SiteNotFound() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
      <Empty className="rounded-xl border border-dashed py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>Not found</EmptyTitle>
          <EmptyDescription>
            There is no page or listing at this address. A society may have been renamed or removed
            at its own request.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button asChild>
            <Link href="/societies">Browse societies</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/request?kind=add">Add a missing society</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
