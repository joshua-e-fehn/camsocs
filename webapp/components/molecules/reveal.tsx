"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type Phase = "static" | "waiting" | "shown"

/**
 * Fades and lifts its children into place once, as they scroll into view
 * (DESIGN.md "Scroll reveal").
 *
 * No-JS safe (spec §5): the server HTML and the first client render are the
 * plain, visible content. Only after mount, with motion allowed and the block
 * still below the fold, is it tucked away to be revealed on scroll — content
 * already on screen is never hidden, so nothing flashes. Without
 * IntersectionObserver, or with reduced motion, it simply stays put.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  /** Seconds, as before (Framer's unit). */
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>("static")

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === "undefined") return
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return
    if (element.getBoundingClientRect().top < window.innerHeight) return
    setPhase("waiting")
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setPhase("shown")
          observer.disconnect()
        }
      },
      { rootMargin: "0px 0px -60px 0px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      data-reveal={phase}
      style={phase === "shown" && delay > 0 ? { transitionDelay: `${delay}s` } : undefined}
      className={cn(
        "data-[reveal=shown]:transition-[opacity,translate] data-[reveal=shown]:duration-300 data-[reveal=shown]:ease-[cubic-bezier(0.25,0.1,0.25,1)] data-[reveal=waiting]:translate-y-2.5 data-[reveal=waiting]:opacity-0",
        className,
      )}
    >
      {children}
    </div>
  )
}
