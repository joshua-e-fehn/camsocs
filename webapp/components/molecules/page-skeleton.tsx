import { Skeleton } from "@/components/ui/skeleton"

/** Loading placeholder shaped like a public page: a header band, then either
 * a filter column and card grid, a list, or a profile with a side column. */
export function PageSkeleton({ shape }: { shape: "grid" | "list" | "profile" }) {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="border-b">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-8 sm:px-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
      </div>
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[16rem_1fr]">
        {shape === "grid" && (
          <>
            <div className="hidden flex-col gap-3 lg:flex">
              {Array.from({ length: 10 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 9 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <Skeleton key={i} className="h-40 rounded-xl" />
              ))}
            </div>
          </>
        )}
        {shape === "list" && (
          <div className="flex flex-col gap-2 lg:col-span-2">
            <Skeleton className="h-10 w-full" />
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        )}
        {shape === "profile" && (
          <div className="grid gap-10 lg:col-span-2 lg:grid-cols-[1fr_22rem]">
            <div className="flex flex-col gap-3">
              {Array.from({ length: 8 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
            <Skeleton className="h-72 rounded-xl" />
          </div>
        )}
      </div>
    </div>
  )
}
