"use client"

import { useEffect, useId, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Long text cut to about `lines` lines with a fade and "Read more". It is
 * clamped from the first paint (no jump), the button appears only when the
 * text really is longer, and without JavaScript the text shows in full (the
 * `<noscript>` rule lifts the clamp).
 */
export function ClampedText({
  children,
  lines = 5,
  className,
}: {
  children: React.ReactNode
  lines?: number
  className?: string
}) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 2)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const clamped = !open
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <noscript>
        <style>{`[data-clamp]{max-height:none!important;mask-image:none!important}`}</style>
      </noscript>
      <div
        ref={box}
        id={id}
        data-clamp={clamped ? "" : undefined}
        className={cn(
          "overflow-hidden",
          clamped &&
            overflows &&
            "mask-[linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]",
        )}
        style={clamped ? { maxHeight: `${lines * 1.75}rem` } : undefined}
      >
        {children}
      </div>
      {(overflows || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex min-h-11 items-center self-start text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  )
}
