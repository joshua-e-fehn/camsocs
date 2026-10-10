import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { requireConvexUrls } from "../lib/convex-url"

/**
 * The build's environment contract, exercised by actually running the script.
 *
 * Worth testing well out of proportion to its length, because every failure
 * direction here is silent and one of them ships.
 *
 * **Too little** and `pixi run build` fails in any environment that has not
 * configured a Convex deployment — which happened: the CI workflow set the
 * variables in its own YAML, the documented command did not, and the build gate
 * failed independent verification while passing in CI's own hands.
 *
 * **Too much** and a *deploying* build compiles against
 * `placeholder-build-check-000`. That build does not crash. `lib/convex-url.ts`
 * accepts the pair — it is well-formed and agrees with itself — every query
 * reaches a backend that does not exist and returns nothing, and real records
 * render as "does not exist". The guard exists to prevent exactly that, so a
 * helper that caused it would be the worst bug in this file. The first version
 * of this script (in Bundestracker, PR #50, review finding F1) had it: it filled
 * in *both* URLs whenever either was missing, so `CONVEX_DEPLOY_KEY` plus a
 * mistyped variable name meant Convex deployed to the real backend while the
 * frontend was built against nothing.
 *
 * The matrix below is therefore the contract, and it is tested exhaustively —
 * every combination of {both, one, neither} × {plain, deploy key, Vercel}:
 *
 * | URLs         | deploying? | expected             |
 * |--------------|-----------|----------------------|
 * | both         | either    | pass through         |
 * | exactly one  | either    | **exit 1**           |
 * | neither      | yes       | **exit 1**           |
 * | neither      | no        | placeholder pair     |
 *
 * Run the real script, in a real subprocess, with a real environment. Asserting
 * on the shell is the only thing that proves the shell is right.
 */

const SCRIPT = new URL("./build-env-defaults.sh", import.meta.url).pathname

const PLACEHOLDER = {
  cloud: "https://placeholder-build-check-000.convex.cloud",
  site: "https://placeholder-build-check-000.convex.site",
}

const REAL = {
  cloud: "https://happy-otter-123.convex.cloud",
  site: "https://happy-otter-123.convex.site",
}

/** Every signal the script reads as "this build is going somewhere real". Each
 * is tested independently, because an environment may forward only one. */
const DEPLOYING = [
  { label: "CONVEX_DEPLOY_KEY", env: { CONVEX_DEPLOY_KEY: "prod:example|secret" } },
  { label: "VERCEL", env: { VERCEL: "1" } },
  { label: "VERCEL_ENV=production", env: { VERCEL_ENV: "production" } },
  { label: "VERCEL_ENV=preview", env: { VERCEL_ENV: "preview" } },
] as const

/**
 * A minimal environment the script can run in. Deliberately *not* built from
 * `process.env`: a developer whose shell exports `NEXT_PUBLIC_CONVEX_URL` or
 * runs this on Vercel would otherwise make these tests pass or fail by
 * accident, and the whole subject here is what the script does with an
 * environment that does or does not carry those variables. PATH is carried
 * through because the script needs a shell.
 *
 * `NODE_ENV` is here because Next declares it non-optional on `ProcessEnv`
 * (next/types/global.d.ts), and `production` is what a real build runs under —
 * so including it makes this environment more faithful, not less.
 */
function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "production" }
}

/**
 * Runs the script with a controlled environment and reports what the wrapped
 * command actually saw.
 *
 * The URLs come back on stdout; the script's own diagnostics go to stderr,
 * which is what keeps the two separable here.
 */
function run(env: Record<string, string>) {
  const result = spawnSync(
    "bash",
    [
      SCRIPT,
      "sh",
      "-c",
      'printf "%s\\n%s\\n%s\\n" "$NEXT_PUBLIC_CONVEX_URL" "$NEXT_PUBLIC_CONVEX_SITE_URL" "$NEXT_PUBLIC_SITE_URL"',
    ],
    { env: { ...baseEnv(), ...env }, encoding: "utf8" },
  )
  const [cloud, site, app] = result.stdout.trim().split("\n")
  return { cloud, site, app, status: result.status, stderr: result.stderr }
}

describe("build-env-defaults.sh — neither URL set", () => {
  test("fills in a valid pair for an ordinary build", () => {
    // The clean-checkout and CI case, and the only row of the matrix that
    // substitutes anything. Before this script, `pixi run build` here died in
    // page-data collection with "NEXT_PUBLIC_CONVEX_URL must be a Convex
    // deployment URL … received undefined".
    const { cloud, site, app, status } = run({})
    expect(status).toBe(0)
    expect(cloud).toBe(PLACEHOLDER.cloud)
    expect(site).toBe(PLACEHOLDER.site)
    expect(app).toBe("http://localhost:3000")
  })

  test("treats an empty value as unset", () => {
    // A CI runner that declares `NEXT_PUBLIC_CONVEX_URL: ""`, or a `.env` line
    // with nothing after the `=`. Testing `-n` would call that configured and
    // hand the empty string on, which is the "received undefined" failure with
    // an extra step.
    const { cloud, site, status } = run({
      NEXT_PUBLIC_CONVEX_URL: "",
      NEXT_PUBLIC_CONVEX_SITE_URL: "",
    })
    expect(status).toBe(0)
    expect(cloud).toBe(PLACEHOLDER.cloud)
    expect(site).toBe(PLACEHOLDER.site)
  })

  for (const { label, env } of DEPLOYING) {
    test(`refuses to substitute when ${label} is set`, () => {
      // A build whose output is going somewhere must name its backend. The
      // placeholder is a compile check; shipping one produces a site that loads
      // and answers every query with nothing.
      const { status, stderr } = run(env)
      expect(status).toBe(1)
      expect(stderr).toMatch(/No Convex URLs set/)
      expect(stderr).not.toMatch(/placeholder-build-check-000\.convex/)
    })
  }
})

describe("build-env-defaults.sh — both URLs set", () => {
  test("passes a configured deployment through untouched", () => {
    // The property that matters most. Vercel sets these from its dashboard; a
    // script that clobbered them would ship production pointed at a deployment
    // that does not exist, and lib/convex-url.ts could not catch it, because
    // the placeholder pair is internally consistent.
    const { cloud, site, app, status } = run({
      NEXT_PUBLIC_CONVEX_URL: REAL.cloud,
      NEXT_PUBLIC_CONVEX_SITE_URL: REAL.site,
      NEXT_PUBLIC_SITE_URL: "https://camsocs.example",
    })
    expect(status).toBe(0)
    expect(cloud).toBe(REAL.cloud)
    expect(site).toBe(REAL.site)
    expect(app).toBe("https://camsocs.example")
  })

  for (const { label, env } of DEPLOYING) {
    test(`leaves NEXT_PUBLIC_SITE_URL unset for lib/site.ts when ${label} is set`, () => {
      // A deploying build without it must not be stamped with localhost: the
      // sitemap, robots and canonical links would all point there. lib/site.ts
      // falls back to the production origin instead.
      const { app, status } = run({
        ...env,
        NEXT_PUBLIC_CONVEX_URL: REAL.cloud,
        NEXT_PUBLIC_CONVEX_SITE_URL: REAL.site,
      })
      expect(status).toBe(0)
      // printf prints an empty last line, which the trim in run() drops.
      expect(app ?? "").toBe("")
    })
  }

  for (const { label, env } of DEPLOYING) {
    test(`still passes through when ${label} is set`, () => {
      // The legitimate production and preview path: fully configured *and*
      // deploying. The deploy-context checks must not break the case they exist
      // to protect — a gate that also blocks correct deploys is not a gate.
      const { cloud, site, status } = run({
        ...env,
        NEXT_PUBLIC_CONVEX_URL: REAL.cloud,
        NEXT_PUBLIC_CONVEX_SITE_URL: REAL.site,
      })
      expect(status).toBe(0)
      expect(cloud).toBe(REAL.cloud)
      expect(site).toBe(REAL.site)
    })
  }
})

describe("build-env-defaults.sh — exactly one URL set", () => {
  // Never substitute, in any context. This replaced a "both or neither" rule
  // that filled in both whenever either was missing — which discarded a real
  // URL somebody had deliberately set and turned a loud failure into a
  // successful build.

  test("fails when only the cloud URL is set", () => {
    const { status, stderr } = run({ NEXT_PUBLIC_CONVEX_URL: REAL.cloud })
    expect(status).toBe(1)
    expect(stderr).toMatch(/NEXT_PUBLIC_CONVEX_SITE_URL is not/)
  })

  test("fails when only the site URL is set", () => {
    const { status, stderr } = run({ NEXT_PUBLIC_CONVEX_SITE_URL: REAL.site })
    expect(status).toBe(1)
    expect(stderr).toMatch(/NEXT_PUBLIC_CONVEX_URL is not/)
  })

  test("never discards the value that was set", () => {
    // The concrete regression. The old script printed nothing about the real
    // URL and replaced it; this one names it and stops. Asserting the
    // placeholder is absent from the diagnostics is the closest a failing run
    // can get to "the placeholder was not used".
    const { stderr } = run({ NEXT_PUBLIC_CONVEX_URL: REAL.cloud })
    expect(stderr).not.toMatch(/placeholder-build-check-000/)
    expect(stderr).toMatch(/Refusing to substitute/)
  })

  for (const { label, env } of DEPLOYING) {
    test(`fails when ${label} is set alongside a half pair`, () => {
      // The review's worst case, for CONVEX_DEPLOY_KEY: the backend deploys to
      // the real deployment while the frontend compiles against a placeholder.
      // A green build, a live site, and every query empty.
      const { status } = run({ ...env, NEXT_PUBLIC_CONVEX_URL: REAL.cloud })
      expect(status).toBe(1)
    })
  }
})

describe("build-env-defaults.sh — invariants", () => {
  test("the placeholder pair is one lib/convex-url.ts accepts", () => {
    // The script and the guard have to agree, and they are written in different
    // languages in different files. If the guard's rules tighten — a stricter
    // deployment-name shape, say — this fails here rather than in a build log.
    expect(
      requireConvexUrls({
        NEXT_PUBLIC_CONVEX_URL: PLACEHOLDER.cloud,
        NEXT_PUBLIC_CONVEX_SITE_URL: PLACEHOLDER.site,
      }),
    ).toEqual({ cloudUrl: PLACEHOLDER.cloud, siteUrl: PLACEHOLDER.site })
  })

  test("passes the child's exit code through", () => {
    // It wraps `next build`. Swallowing a non-zero status would turn a failed
    // build into a green CI run, which is worse than having no gate at all.
    expect(run({}).status).toBe(0)
    const failed = spawnSync("bash", [SCRIPT, "sh", "-c", "exit 42"], {
      env: baseEnv(),
      encoding: "utf8",
    })
    expect(failed.status).toBe(42)
  })

  test("does not run the wrapped command when it refuses", () => {
    // A refusal has to stop the build, not merely complain before it. If the
    // guard printed its message and still exec'd, every case above would report
    // the right stderr and ship the wrong bundle.
    const result = spawnSync("bash", [SCRIPT, "sh", "-c", "echo RAN_ANYWAY"], {
      env: { ...baseEnv(), CONVEX_DEPLOY_KEY: "prod:example|secret" },
      encoding: "utf8",
    })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toMatch(/RAN_ANYWAY/)
  })
})

describe("bun run build — the URL check runs before any deploy", () => {
  test("a deploying build without the URL pair stops before convex-deploy-if-key.sh", () => {
    // `package.json` wraps the deploy in this script: deploy-then-check pushed
    // functions to production and then failed the build (review 2026-10-10).
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: { build: string }
    }
    expect(pkg.scripts.build.startsWith("bash scripts/build-env-defaults.sh ")).toBe(true)
    const deployed = new URL("./build-env-defaults.sh", import.meta.url).pathname
    const result = spawnSync("bash", [deployed, "sh", "-c", "echo DEPLOYED"], {
      env: {
        ...baseEnv(),
        CONVEX_DEPLOY_KEY: "prod:example|secret",
        CAMSOCS_ALLOW_LOCAL_CONVEX_DEPLOY: "1",
      },
      encoding: "utf8",
    })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain("DEPLOYED")
  })
})
