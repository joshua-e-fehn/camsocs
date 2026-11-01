import { TalkRowSkeleton } from "@/components/molecules/talk-row"
import { Skeleton } from "@/components/ui/skeleton"

/** The agenda's shape while it loads: header and School rail, the search
 * bar, then the week strip beside (desktop) or over (phone) talk rows.
 * In the (agenda) group so it wraps /talks only: /talks/[key] stays outside
 * any Suspense boundary, so an unknown talk is a real HTTP 404, and
 * /talks/departments is not shown an agenda skeleton. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading talks…
      </span>
      <div className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-8 pb-5 sm:px-6 sm:pt-12">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-14 w-56 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <div className="flex gap-1.5 overflow-hidden pt-2">
            {[96, 140, 170, 150, 131, 141, 110, 132].map((width) => (
              <Skeleton key={width} className="h-9 shrink-0 rounded-full" style={{ width }} />
            ))}
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <Skeleton className="mt-3 h-12 w-full rounded-full" />
        <div className="grid gap-x-12 pt-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex flex-col gap-3 lg:order-2">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-8 w-full rounded-full" />
          </div>
          <div className="flex flex-col pt-5 lg:pt-0">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-6 mb-1 h-7 w-48" />
            {Array.from({ length: 6 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <TalkRowSkeleton key={index} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
