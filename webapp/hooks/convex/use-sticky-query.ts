import { type Preloaded, useQuery } from "convex/react"
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server"
import { convexToJson, type JSONValue, jsonToConvex, type Value } from "convex/values"
import { useMemo, useRef } from "react"

/**
 * A live query whose arguments follow client state (the directory's URL),
 * seeded by a server preload so the first paint has data, that keeps showing
 * the last result while the next one loads instead of blanking. `stale` is
 * true in between — draw a quiet progress hint, not a fade.
 *
 * The preload is used while the arguments are still the ones it was made
 * with (the first render and the server render); after that the
 * subscription's own results take over.
 */
export function useStickyQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
  preloaded?: Preloaded<Query>,
): { data: FunctionReturnType<Query> | undefined; stale: boolean } {
  const key = args === "skip" ? "skip" : JSON.stringify(convexToJson(args as Value))
  const seed = useMemo(
    () =>
      preloaded
        ? {
            key: JSON.stringify(preloaded._argsJSON),
            value: jsonToConvex(
              preloaded._valueJSON as unknown as JSONValue,
            ) as FunctionReturnType<Query>,
          }
        : undefined,
    [preloaded],
  )
  const result = useQuery(query, args)
  const last = useRef<FunctionReturnType<Query> | undefined>(seed?.value)
  if (result !== undefined) {
    last.current = result
    return { data: result, stale: false }
  }
  if (seed && seed.key === key) return { data: seed.value, stale: false }
  return { data: last.current, stale: args !== "skip" }
}
