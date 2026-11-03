"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import { isPaletteShortcut, PALETTE_EVENT, type PaletteRequest } from "@/lib/palette"

/** The ⌘K palette's code (cmdk, the search hooks) is fetched when a reader
 * first asks for it, or once the browser is idle, never on the page's
 * critical path (SEO audit 2026-11-02, mobile-lcp-js-weight). */
const loadPalette = () => import("@/components/organisms/command-palette")
const CommandPalette = dynamic(() => loadPalette().then((module) => module.CommandPalette), {
  ssr: false,
})

/**
 * Until the palette is loaded, its shortcuts and open requests
 * (`openPalette`) land here: the first one loads it and is handed to it, so
 * it opens as asked. From then on the palette listens itself.
 */
export function LazyCommandPalette() {
  const [request, setRequest] = useState<PaletteRequest | null>(null)

  useEffect(() => {
    if (request) return
    function onKeyDown(event: KeyboardEvent) {
      if (!isPaletteShortcut(event)) return
      event.preventDefault()
      setRequest({})
    }
    function onRequest(event: Event) {
      setRequest((event as CustomEvent<PaletteRequest>).detail ?? {})
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener(PALETTE_EVENT, onRequest)
    // Warm the chunk when the browser has nothing better to do, so the first
    // open is instant; Safari has no requestIdleCallback.
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(() => void loadPalette(), { timeout: 5_000 })
        : window.setTimeout(() => void loadPalette(), 3_000)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener(PALETTE_EVENT, onRequest)
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
    }
  }, [request])

  return request ? <CommandPalette initialRequest={request} /> : null
}
