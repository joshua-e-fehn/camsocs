"use client"

import { useMutation, useQuery } from "convex/react"
import { XIcon } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { FeedPanel } from "@/components/organisms/feed-panel"
import { api } from "@/convex/_generated/api"
import { clearStoredFeed, readStoredFeed, type StoredFeed } from "@/lib/feed-storage"

/** "My calendar" (ENG-129): the societies this browser's feed follows, to remove. */
export function FeedManager() {
  const [stored, setStored] = useState<StoredFeed | null | undefined>(undefined)
  useEffect(() => setStored(readStoredFeed()), [])
  const feed = useQuery(api.feeds.get, stored ? { feedId: stored.feedId } : "skip")
  const update = useMutation(api.feeds.update)
  const [busy, setBusy] = useState<string | null>(null)

  if (stored === undefined || (stored && feed === undefined)) {
    return <div className="h-40 animate-pulse rounded-2xl bg-muted" aria-busy />
  }
  if (!stored || feed === null || feed === undefined) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed p-6">
        <p className="font-serif text-2xl">No calendar on this browser yet</p>
        <p className="text-muted-foreground">
          Take the Society Finder and follow the societies you like: your calendar is made in one
          click.
        </p>
        <Link href="/finder" className="underline underline-offset-4">
          Find your societies
        </Link>
      </div>
    )
  }

  async function remove(key: string) {
    if (!stored || !feed) return
    setBusy(key)
    try {
      await update({
        feedId: stored.feedId,
        editToken: stored.editToken,
        orgKeys: feed.orgs.map((o) => o.key).filter((k) => k !== key),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FeedPanel feedId={stored.feedId} count={feed.orgs.length} />
      <section aria-labelledby="following" className="flex flex-col gap-3">
        <h2 id="following" className="font-serif text-2xl">
          Following {feed.orgs.length}
        </h2>
        <ul className="flex flex-col divide-y rounded-2xl border">
          {feed.orgs.map((org) => (
            <li key={org.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <Link href={`/societies/${org.slug}`} className="underline-offset-4 hover:underline">
                {org.name}
              </Link>
              <button
                type="button"
                onClick={() => remove(org.key)}
                disabled={busy !== null}
                aria-label={`Stop following ${org.name}`}
                className="inline-flex min-h-11 items-center gap-1 rounded-full px-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40 sm:min-h-8"
              >
                <XIcon aria-hidden className="size-4" />
                Remove
              </button>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Add more by taking the{" "}
          <Link href="/finder" className="underline underline-offset-4">
            Society Finder
          </Link>{" "}
          again.{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => {
              clearStoredFeed()
              setStored(null)
            }}
          >
            Forget this calendar on this browser
          </button>{" "}
          (the feed keeps working in your calendar app).
        </p>
      </section>
    </div>
  )
}
