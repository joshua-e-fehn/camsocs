/**
 * Asserts the committed `convex/_generated/api.d.ts` still lists every Convex
 * module on disk.
 *
 * ## Why this exists
 *
 * `convex/_generated/` is committed rather than ignored, because it cannot be
 * regenerated without deployment credentials: `bunx convex codegen` needs a
 * `CONVEX_DEPLOYMENT` it has access to, and the full `api.d.ts` is built from a
 * deployment's own analysis of the pushed modules. A clean checkout — CI, a new
 * contributor, a fork's PR — has no such access, and without these files
 * `tsc --noEmit` fails and the Convex test suites cannot import
 * `./_generated/server`. (Ported from Bundestracker.)
 *
 * Committing derived files buys that at a price: they can now go stale, and the
 * staleness is silent. This is the one check that catches it without needing
 * the credentials the regeneration itself would need.
 *
 * ## What it can and cannot see
 *
 * `api.d.ts` refers to each module as `typeof import("../runs.js")`, so every
 * *signature* in it is derived from the source at typecheck time and cannot
 * drift — rename a function's arguments and `tsc` reads the new ones from the
 * file. What is baked in is the **list of modules**: adding `convex/foo.ts`
 * without regenerating leaves `api.foo` missing, and the failure surfaces as a
 * property error at the call site rather than as anything naming codegen.
 *
 * So this compares two lists and nothing else. It deliberately does not try to
 * verify `components`, the Better Auth component's `component.ts`, or anything
 * else that genuinely requires a deployment to compute — a check that cannot be
 * satisfied offline would just be a red gate nobody can fix.
 *
 * The module rules mirror `entryPoints()` in convex/dist/cjs/bundler: `.ts`
 * files under `convex/`, excluding `_generated`, `schema.ts`, dotfiles, any
 * name with a second dot (`auth.config.ts`, `convex.config.ts`, `*.test.ts`),
 * and any directory holding a `convex.config.ts` of its own — that last is what
 * excludes `convex/betterAuth/`, which is a component with its own codegen.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const CONVEX_DIR = new URL("../convex/", import.meta.url).pathname
const API_DTS = join(CONVEX_DIR, "_generated", "api.d.ts")

/** Every module `convex codegen` would list, as a slash-joined path with no
 * extension — the exact shape `api.d.ts` imports them by. */
function entryPoints(dir: string, root: string = dir): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (entry.name === "_generated") continue
      // A directory defining its own component is deployed separately and must
      // not be double-listed here. `convex/betterAuth/` is the one today.
      if (existsSync(join(full, "convex.config.ts"))) continue
      found.push(...entryPoints(full, root))
      continue
    }

    if (!entry.name.endsWith(".ts")) continue
    if (entry.name.startsWith(".")) continue
    if (entry.name === "schema.ts") continue
    // `auth.config.ts`, `convex.config.ts`, `*.test.ts` — anything carrying a
    // second dot is config or a test, not a function module.
    if ((entry.name.match(/\./g) ?? []).length > 1) continue

    found.push(relative(root, full).replace(/\\/g, "/").replace(/\.ts$/, ""))
  }

  return found.sort()
}

const onDisk = entryPoints(CONVEX_DIR)

if (!existsSync(API_DTS)) {
  console.error(
    `✖ convex/_generated/api.d.ts is missing.\n` +
      `  It is committed to this repo on purpose — see webapp/.gitignore.\n` +
      `  Restore it with git, or regenerate with \`bunx convex dev --once\`\n` +
      `  against a deployment you have access to.`,
  )
  process.exit(1)
}

/** The modules the committed file was generated against. */
const generated = [...readFileSync(API_DTS, "utf8").matchAll(/from "\.\.\/(.+?)\.js"/g)]
  .map((match) => match[1])
  .sort()

const missing = onDisk.filter((module) => !generated.includes(module))
const extra = generated.filter((module) => !onDisk.includes(module))

if (missing.length > 0 || extra.length > 0) {
  console.error("✖ convex/_generated/api.d.ts is out of date.\n")
  for (const module of missing) console.error(`  + convex/${module}.ts is not in api.d.ts`)
  for (const module of extra) console.error(`  - api.d.ts lists convex/${module}.ts, which is gone`)
  console.error(
    `\n  Regenerate against a deployment you have access to and commit the result:\n` +
      `\n    cd webapp && bunx convex dev --once\n`,
  )
  process.exit(1)
}

console.log(`✓ convex/_generated/api.d.ts lists all ${onDisk.length} Convex modules`)
