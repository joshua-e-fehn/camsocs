import type { GenericValidator } from "convex/values"

/**
 * Checks an untyped value against a Convex validator, returning the first
 * problem as a readable path + message, or null when it conforms.
 *
 * Why it exists: a field claim's `value` crosses the wire as `v.any()` — one
 * claim shape serves every field of every entity type — so the argument
 * validator cannot check it. `convex/lib/fields.ts` declares each field's value
 * validator with the same `v.*` builders the schema uses, and this walks that
 * validator. A claim that fails is rejected individually (and reported back to
 * the pipeline) instead of failing a 500-claim batch at insert time.
 *
 * Walks the public `kind` / `fields` / `element` / `members` / `value` /
 * `isOptional` properties of convex/values validators (convex 1.46,
 * node_modules/convex/dist/esm-types/values/validators.d.ts). Object
 * validators reject unknown fields, as Convex does.
 */
export function checkValue(
  validator: GenericValidator,
  value: unknown,
  path = "value",
): string | null {
  const node = validator as unknown as ValidatorNode
  switch (node.kind) {
    case "any":
      return value === undefined ? `${path}: required` : null
    case "string":
      return typeof value === "string" ? null : `${path}: expected a string`
    case "float64":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${path}: expected a finite number`
    case "int64":
      return typeof value === "bigint" ? null : `${path}: expected an int64`
    case "boolean":
      return typeof value === "boolean" ? null : `${path}: expected a boolean`
    case "null":
      return value === null ? null : `${path}: expected null`
    case "literal":
      return value === node.value ? null : `${path}: expected ${JSON.stringify(node.value)}`
    case "id":
      // Shape only; whether the document exists is the caller's question.
      return typeof value === "string" && value.length > 0 ? null : `${path}: expected an id`
    case "bytes":
      return value instanceof ArrayBuffer ? null : `${path}: expected bytes`
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected an array`
      for (let i = 0; i < value.length; i++) {
        const problem = checkValue(node.element, value[i], `${path}[${i}]`)
        if (problem) return problem
      }
      return null
    }
    case "object": {
      if (!isPlainObject(value)) return `${path}: expected an object`
      for (const key of Object.keys(value)) {
        if (!(key in node.fields)) return `${path}.${key}: unexpected field`
      }
      for (const [key, fieldValidator] of Object.entries(node.fields)) {
        const fieldValue = value[key]
        if (fieldValue === undefined) {
          if ((fieldValidator as unknown as ValidatorNode).isOptional === "optional") continue
          return `${path}.${key}: required`
        }
        const problem = checkValue(fieldValidator, fieldValue, `${path}.${key}`)
        if (problem) return problem
      }
      return null
    }
    case "record": {
      if (!isPlainObject(value)) return `${path}: expected an object`
      // A record's `value` is the validator for its entries (a literal's is the literal).
      const entryValidator = node.value as GenericValidator
      for (const [key, entry] of Object.entries(value)) {
        const problem =
          checkValue(node.key, key, `${path} key ${JSON.stringify(key)}`) ??
          checkValue(entryValidator, entry, `${path}.${key}`)
        if (problem) return problem
      }
      return null
    }
    case "union": {
      if (node.members.some((member) => checkValue(member, value, path) === null)) return null
      return `${path}: matches none of the allowed shapes`
    }
    default:
      return `${path}: unsupported validator kind ${String(node.kind)}`
  }
}

type ValidatorNode = {
  kind: string
  isOptional: "optional" | "required"
  value?: unknown
  element: GenericValidator
  fields: Record<string, GenericValidator>
  key: GenericValidator
  members: GenericValidator[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
