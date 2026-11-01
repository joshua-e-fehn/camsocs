import { Skeleton } from "@/components/ui/skeleton"

/** A profile's shape while it loads: identity header with actions, then the
 * main column beside the "At a glance" card. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <Skeleton className="h-4 w-48" />
          <div className="flex items-start gap-4 sm:gap-6">
            <Skeleton className="size-16 shrink-0 rounded-[22%] sm:size-22" />
            <Skeleton className="h-10 w-80 max-w-full sm:h-12" />
          </div>
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-5 w-full max-w-3xl" />
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="size-11 rounded-full sm:h-10 sm:w-28" />
            ))}
          </div>
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_21rem] lg:py-10">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-7 w-32" />
          {Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="h-4 w-full" />
          ))}
          <Skeleton className="mt-8 h-7 w-40" />
          {Array.from({ length: 3 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </div>
  )
}
