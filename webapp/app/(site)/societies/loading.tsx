import { Skeleton } from "@/components/ui/skeleton"

/** The directory's shape while it loads: header band, search and chips, the
 * facet rail on desktop, and dense rows / two-column cards. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading societies…
      </span>
      <div className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-8 pb-6 sm:px-6 sm:pt-12">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-11 w-72 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-7xl gap-x-10 px-4 sm:px-6 lg:grid-cols-[15.5rem_1fr]">
        <div className="hidden flex-col gap-3 py-6 lg:flex">
          <Skeleton className="h-6 w-24" />
          <div className="flex flex-wrap gap-1.5">
            {[72, 110, 88, 136, 96, 120, 80, 104, 140, 76, 118, 92].map((width) => (
              <Skeleton key={width} className="h-8 rounded-full" style={{ width }} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3 pt-3 lg:pt-6">
          <Skeleton className="h-12 w-full rounded-full" />
          <div className="flex gap-1.5 overflow-hidden">
            {Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="h-8 w-28 shrink-0 rounded-full" />
            ))}
          </div>
          <div className="grid gap-3 pt-6 sm:grid-cols-2">
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <div key={i} className="flex gap-3 py-3 sm:rounded-xl sm:border sm:p-4">
                <Skeleton className="size-12 shrink-0 rounded-[22%]" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
