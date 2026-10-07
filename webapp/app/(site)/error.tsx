"use client"

import { RotateCwIcon, TriangleAlertIcon } from "lucide-react"
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

/** A public page failed to load its data. Says so plainly and offers a retry;
 * the error's details stay in the server log. */
export default function SiteError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
      <Empty className="rounded-xl border border-dashed py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>This page could not be loaded</EmptyTitle>
          <EmptyDescription>
            The directory did not answer in time. Nothing is wrong with your request; please try
            again.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button onClick={reset}>
            <RotateCwIcon data-icon="inline-start" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">Home</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
