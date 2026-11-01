"use client"

import { CheckIcon, Share2Icon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { quickActionClass, quickActionIconClass } from "@/components/molecules/quick-actions"

/** Share the page: the system share sheet where there is one, else copy the
 * link (with a toast). */
export function ShareAction({ title, path }: { title: string; path: string }) {
  const [copied, setCopied] = useState(false)
  const Icon = copied ? CheckIcon : Share2Icon
  return (
    <button
      type="button"
      className={quickActionClass(false)}
      onClick={async () => {
        const url = new URL(path, window.location.origin).toString()
        if (typeof navigator.share === "function") {
          try {
            await navigator.share({ title, url })
            return
          } catch (error) {
            // Dismissing the sheet is not a failure; anything else falls back.
            if (error instanceof DOMException && error.name === "AbortError") return
          }
        }
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
          toast.success("Link copied")
          setTimeout(() => setCopied(false), 2000)
        } catch {
          toast.error("Could not copy the link")
        }
      }}
    >
      <span className={quickActionIconClass(false)}>
        <Icon aria-hidden />
      </span>
      <span>{copied ? "Copied" : "Share"}</span>
    </button>
  )
}
