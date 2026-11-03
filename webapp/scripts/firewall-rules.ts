/**
 * Writes the Vercel firewall rule bodies of ops/vercel/ from
 * lib/firewall-rules.ts (bot policy 2026-11-03): `bun run firewall:rules`.
 * It applies nothing; the operator does (docs/deploy.md "Bot policy").
 * lib/firewall-rules.test.ts fails when a committed file differs.
 */
import { writeFileSync } from "node:fs"
import path from "node:path"
import { FIREWALL_FILES, firewallFileText } from "../lib/firewall-rules"

const dir = path.join(import.meta.dir, "..", "..", "ops", "vercel")
for (const { file, body } of FIREWALL_FILES) {
  writeFileSync(path.join(dir, file), firewallFileText(body()))
  console.log(`wrote ops/vercel/${file}`)
}
