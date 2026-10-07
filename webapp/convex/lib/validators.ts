import { type Validator, v } from "convex/values"

/**
 * Validator shapes derived from a TypeScript source of truth.
 *
 * Deliberately importing nothing but `convex/values`: `convex/schema.ts` uses
 * this, and anything reaching back to `_generated/dataModel` would close a
 * cycle through the schema it generates from.
 */

/**
 * A `v.union` of literals, from the `as const` tuple that already lists them.
 *
 * Ported from Bundestracker. Every closed vocabulary in the schema and in
 * function arguments goes through this, from the tuples in lib/vocab.ts, so the
 * tuple is the one list and the validator cannot drift from it.
 *
 * The point is the annotation the callers put on the result: typed
 * `Validator<EventType>`, a literal dropped from either the tuple or the type
 * fails `pixi run typecheck` at the assignment rather than becoming a value the
 * database rejects at runtime.
 *
 * `v.union` needs two or more members to type, which the signature enforces —
 * a one-element vocabulary is a `v.literal`, not a union, and passing one here
 * should be a compile error rather than a runtime surprise. The cast is the
 * price: `.map` over the rest produces `VLiteral[]`, and `v.union`'s rest
 * parameter is a tuple type that no array satisfies. The `head`/`second`
 * parameters carry the arity the cast cannot.
 */
export function literalUnion<const Values extends readonly [string, string, ...string[]]>(
  values: Values,
): Validator<Values[number]> {
  const [head, second, ...rest] = values
  return v.union(
    v.literal(head),
    v.literal(second),
    ...(rest.map((value) => v.literal(value)) as ReturnType<typeof v.literal<string>>[]),
  ) as Validator<Values[number]>
}
