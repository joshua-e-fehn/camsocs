import { convexTest } from "convex-test"
import { components } from "../_generated/api"
import betterAuthSchema from "../betterAuth/schema"
import schema from "../schema"

/**
 * convex-test harness shared by the Convex test suites (salo-ba
 * convex/security-abuse.test.ts pattern, under `bun test`).
 *
 * The filename carries a second dot on purpose: Convex skips such files when
 * bundling, and scripts/check-codegen.ts mirrors that rule, so this test-only
 * module (which imports the dev dependency `convex-test`) is never deployed.
 *
 * The module map is explicit because `bun test` has no `import.meta.glob`. Add
 * a module here when a test reaches a function in it.
 */
const appModules = {
  "./_generated/server.ts": () => import("../_generated/server"),
  "./auth.ts": () => import("../auth"),
  "./authEmail.ts": () => import("../authEmail"),
  "./crons.ts": () => import("../crons"),
  "./derive.ts": () => import("../derive"),
  "./events.ts": () => import("../events"),
  "./http.ts": () => import("../http"),
  "./listingRequests.ts": () => import("../listingRequests"),
  "./orgs.ts": () => import("../orgs"),
  "./runs.ts": () => import("../runs"),
  "./termDates.ts": () => import("../termDates"),
  "./venues.ts": () => import("../venues"),
  "./broker/graph.ts": () => import("../broker/graph"),
  "./broker/interactions.ts": () => import("../broker/interactions"),
  "./broker/introductions.ts": () => import("../broker/introductions"),
  "./broker/listingRequests.ts": () => import("../broker/listingRequests"),
  "./broker/orgs.ts": () => import("../broker/orgs"),
  "./broker/overview.ts": () => import("../broker/overview"),
  "./broker/people.ts": () => import("../broker/people"),
  "./broker/session.ts": () => import("../broker/session"),
  "./ingest/broker.ts": () => import("../ingest/broker"),
  "./ingest/claims.ts": () => import("../ingest/claims"),
  "./ingest/files.ts": () => import("../ingest/files"),
  "./ingest/inbound.ts": () => import("../ingest/inbound"),
  "./ingest/orgInternal.ts": () => import("../ingest/orgInternal"),
  "./ingest/purge.ts": () => import("../ingest/purge"),
  "./ingest/relationships.ts": () => import("../ingest/relationships"),
  "./ingest/sources.ts": () => import("../ingest/sources"),
  "./ingest/termDates.ts": () => import("../ingest/termDates"),
}

const authModules = {
  "./_generated/server.ts": () => import("../betterAuth/_generated/server"),
  "./adapter.ts": () => import("../betterAuth/adapter"),
}

/** A fresh, empty deployment with the Better Auth component registered. */
export function newTest() {
  const t = convexTest(schema, appModules)
  t.registerComponent("betterAuth", betterAuthSchema, authModules)
  return t
}

export type TestConvex = ReturnType<typeof newTest>

/**
 * Creates a Better Auth user and session in `t`, and returns a client acting as
 * that session — the identity `authComponent.safeGetAuthUser` resolves.
 */
export async function signedInAs(
  t: TestConvex,
  email: string,
  options: { emailVerified?: boolean; name?: string } = {},
) {
  const now = Date.now()
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: options.name ?? email.split("@")[0],
        email,
        emailVerified: options.emailVerified ?? true,
        createdAt: now,
        updatedAt: now,
      },
    },
    select: [],
  })
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        token: `${email}-token`,
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      },
    },
    select: [],
  })
  return t.withIdentity({ subject: user._id, sessionId: session._id } as never)
}

/**
 * Sets env vars for the duration of `body`, restoring the previous values
 * afterwards. convex-test runs functions in this process, so `process.env` is
 * what they read.
 */
export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(vars)
  try {
    return await body()
  } finally {
    apply(previous)
  }
}
