"use client"

import { RotateCwIcon, TriangleAlertIcon } from "lucide-react"
import { useEffect } from "react"
import "./globals.css"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { captureBrowserException } from "@/lib/analytics-client"

/**
 * The last-resort boundary: the root layout itself failed, so this replaces
 * it, `<html>` and `<body>` included, without the providers, header or
 * fonts. Kept to plain markup and a retry. The error goes to PostHog only for
 * a visitor who accepted analytics (ENG-6); its details stay in the server
 * log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    captureBrowserException(error)
  }, [error])

  return (
    <html lang="en-GB">
      <body className="font-sans antialiased">
        <main className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
          <Empty className="rounded-xl border border-dashed py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlertIcon />
              </EmptyMedia>
              <EmptyTitle>Something went wrong</EmptyTitle>
              <EmptyDescription>
                The site could not be shown. Nothing is wrong with your request; please try again.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              <Button onClick={reset}>
                <RotateCwIcon data-icon="inline-start" />
                Try again
              </Button>
              <Button variant="outline" asChild>
                {/* A full page load, not a client navigation: the app shell is what failed. */}
                <a href="/">Home</a>
              </Button>
            </EmptyContent>
          </Empty>
        </main>
      </body>
    </html>
  )
}
