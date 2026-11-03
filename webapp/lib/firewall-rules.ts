import { AI_CRAWLERS, AI_TRAINING_CRAWLERS, SCRAPERS } from "./crawlers"

/**
 * The Vercel firewall rules of the bot policy (2026-11-03), as the PATCH
 * bodies of `/v1/security/firewall/config` that ops/vercel/*.json holds. Built
 * here from the crawler tiers (lib/crawlers.ts), so the firewall names the
 * same agents as robots.txt and the proxy; `scripts/firewall-rules.ts`
 * writes the files and lib/firewall-rules.test.ts fails when one drifts.
 * Nothing in the repo applies them: the operator does, in the order of
 * docs/deploy.md "Bot policy".
 *
 * A body is `{ action, id, value }`. In a rule, the conditions of a group
 * must all hold and any group may match (at most 25 groups of 65
 * conditions).
 */

export type Condition = {
  type: "path" | "raw_path" | "query" | "user_agent" | "host"
  op: "eq" | "neq" | "pre" | "suf" | "sub" | "re" | "inc" | "ninc" | "ex" | "nex"
  value?: string
  key?: string
  neg?: boolean
}

export type Mitigation =
  | { action: "deny" | "bypass" | "log" }
  | {
      action: "rate_limit"
      rateLimit: {
        algo: "fixed_window"
        window: number
        limit: number
        keys: ["ip"]
        action: "log"
      }
    }

export type RuleBody = {
  action: "rules.insert" | "rules.update"
  id: string | null
  value: {
    name: string
    description: string
    active: boolean
    conditionGroup: { conditions: Condition[] }[]
    action: { mitigate: Mitigation }
  }
}

export type ManagedRulesBody = {
  action: "managedRules.update"
  id: "bot_protection"
  value: { active: boolean; action: "log" }
}

/** The live rule that kept GPTBot and ClaudeBot off the whole site since
 * 1 Nov; step 2 narrows it in place, keeping its id. */
export const TRAINING_RULE_ID = "rule_block_gpt_bot_and_claude_bot_training_crawlers_ctjYse"

/** The longest user-agent regex one condition carries: a long list is split
 * over several groups (the API documents no limit; this keeps each value
 * well inside any). */
const MAX_PATTERN = 600

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A token as a regex that ignores case without relying on a `(?i)` flag
 * (whether the WAF's engine takes one is not documented): each letter as a
 * class of its two cases, `GPTBot` as `[Gg][Pp][Tt][Bb][Oo][Tt]`. */
export function caseless(token: string): string {
  return [...token]
    .map((char) => {
      const lower = char.toLowerCase()
      const upper = char.toUpperCase()
      return lower === upper ? escapeRegex(char) : `[${upper}${lower}]`
    })
    .join("")
}

/** User-agent regexes naming the tokens in any case, each at most
 * `MAX_PATTERN` long: `(tokenA|tokenB|…)`. */
export function userAgentPatterns(tokens: readonly string[]): string[] {
  const out: string[][] = [[]]
  for (const token of tokens) {
    const part = caseless(token)
    const current = out[out.length - 1]
    const length = current.reduce((sum, item) => sum + item.length + 1, 1) + part.length
    if (current.length > 0 && length > MAX_PATTERN) out.push([part])
    else current.push(part)
  }
  return out.map((parts) => `(${parts.join("|")})`)
}

function uaConditions(tokens: readonly string[]): Condition[] {
  return userAgentPatterns(tokens).map((value) => ({ type: "user_agent", op: "re", value }))
}

/** T0: the crawler control files, reachable by every agent before any other
 * rule (moved to the first position after the insert). */
export function controlFilesBypass(): RuleBody {
  return {
    action: "rules.insert",
    id: null,
    value: {
      name: "Crawler control files: always reachable",
      description:
        "Bot policy 2026-11-03, T0: /robots.txt and /llms.txt bypass every later rule, so any agent (one denied elsewhere included) can read what it is asked to do. Keep this rule first.",
      active: true,
      conditionGroup: ["/robots.txt", "/llms.txt"].map((value) => ({
        conditions: [{ type: "path", op: "eq", value }],
      })),
      action: { mitigate: { action: "bypass" } },
    },
  }
}

/** G1: no AI agent (T1-T3) on the talks pillar, before compute. */
export function talksAiDeny(): RuleBody {
  return {
    action: "rules.insert",
    id: null,
    value: {
      name: "Deny AI agents on /talks",
      description:
        "Bot policy 2026-11-03 and owner decision G1: deny the AI agents of webapp/lib/crawlers.ts AI_CRAWLERS (T1 search, T2 user-triggered, T3 training; tokens in any case) on the talks pillar, path prefix /talks (which covers /talks.ics), before compute. Browsers, Googlebot, Bingbot and other search crawlers stay allowed. robots.txt asks the same; proxy.ts refuses them too.",
      active: true,
      conditionGroup: uaConditions(AI_CRAWLERS).map((ua) => ({
        conditions: [{ type: "path", op: "pre", value: "/talks" }, ua],
      })),
      action: { mitigate: { action: "deny" } },
    },
  }
}

/** Vulnerability probes: paths nothing on the site serves. */
export const PROBE_PATHS = String.raw`^/(\.env|\.git|wp-|wordpress|xmlrpc|phpmyadmin|\.aws|\.DS_Store|.*\.php$)`

/** T4 and T5: probes of other software's paths, and the SEO tools and
 * commercial scrapers, refused before compute. */
export function probesAndScrapersDeny(): RuleBody {
  return {
    action: "rules.insert",
    id: null,
    value: {
      name: "Deny vulnerability probes and scrapers",
      description:
        "Bot policy 2026-11-03: deny requests for other software's paths (.env, .git, wp-*, xmlrpc, phpMyAdmin, .aws, .DS_Store, *.php; nothing here serves them) and the SEO-tool and commercial scrapers of webapp/lib/crawlers.ts SCRAPERS (T4, any case), which robots.txt asks to read nothing. Firewall-denied requests cost no function, CDN request or data transfer.",
      active: true,
      conditionGroup: [
        { conditions: [{ type: "path", op: "re", value: PROBE_PATHS }] },
        ...uaConditions(SCRAPERS).map((ua) => ({ conditions: [ua] })),
      ],
      action: { mitigate: { action: "deny" } },
    },
  }
}

/** The pages rendered per request, and every other path a training crawler
 * may not cost compute on: the calendar, directory, request form and talks
 * pages (and their `.rsc` payloads), the whole talks pillar, every `.ics`
 * feed (`/events.ics`, `/events/<key>/ics`) and the generated share images
 * (`/…/opengraph-image-<hash>`). */
export const UNCACHED_PATHS = String.raw`^/((events|societies|request)(\.rsc)?$|talks)|[/.]ics$|opengraph-image`

/** T3 (step 2): training crawlers on edge-cached public pages only. The
 * existing GPTBot/ClaudeBot rule, narrowed in place. */
export function trainingCrawlers(): RuleBody {
  const notRobots: Condition = { type: "path", op: "neq", value: "/robots.txt" }
  // Any of these, with a training crawler's user agent, is denied. A query
  // string: `raw_path` is assumed to carry it (to be confirmed live,
  // docs/deploy.md "Bot policy"); `_rsc` is Next's RSC fetch, named as a
  // documented `query` key in case it does not.
  const uncached: Condition[] = [
    { type: "path", op: "re", value: UNCACHED_PATHS },
    { type: "raw_path", op: "re", value: String.raw`\?` },
    { type: "query", op: "ex", key: "_rsc" },
  ]
  return {
    action: "rules.update",
    id: TRAINING_RULE_ID,
    value: {
      name: "Training crawlers: cached public pages only",
      description:
        "Bot policy 2026-11-03, step 2 (was: block GPTBot and ClaudeBot site-wide since the 1 Nov CPU incident, when they hammered /events). The AI-training crawlers of webapp/lib/crawlers.ts AI_TRAINING_CRAWLERS (any case) may read edge-cached public pages; deny them the pages rendered per request (/events, /societies, /request, /talks and their .rsc), the talks pillar, .ics feeds, share images and any URL with a query string. /robots.txt is never denied. Browsers and search crawlers are unaffected.",
      active: true,
      conditionGroup: uaConditions(AI_TRAINING_CRAWLERS).flatMap((ua) =>
        uncached.map((path) => ({ conditions: [ua, notRobots, path] })),
      ),
      action: { mitigate: { action: "deny" } },
    },
  }
}

/** T5 flood insurance, measured first: a per-IP fixed window on the pages
 * rendered per request and the API, logging (not refusing) what exceeds it. */
export function dynamicRateLimitLog(): RuleBody {
  return {
    action: "rules.insert",
    id: null,
    value: {
      name: "Rate limit dynamic paths (log only)",
      description:
        "Bot policy 2026-11-03, T5: log any IP making more than 120 requests a minute to the pages rendered per request (/events, /societies, /request, /sign-in and their .rsc), the talks pillar or /api/. Log mode: measure before refusing anything; switch the rate limit's action to deny only after reading the logs.",
      active: true,
      conditionGroup: [
        {
          conditions: [
            {
              type: "path",
              op: "re",
              value: String.raw`^/(events|societies|request|sign-in)(\.rsc)?$`,
            },
          ],
        },
        { conditions: [{ type: "path", op: "pre", value: "/talks" }] },
        { conditions: [{ type: "path", op: "pre", value: "/api/" }] },
      ],
      action: {
        mitigate: {
          action: "rate_limit",
          rateLimit: { algo: "fixed_window", window: 60, limit: 120, keys: ["ip"], action: "log" },
        },
      },
    },
  }
}

/** T5: Vercel's Bot Protection managed ruleset, in log mode (measure first). */
export function botProtectionLog(): ManagedRulesBody {
  return {
    action: "managedRules.update",
    id: "bot_protection",
    value: { active: true, action: "log" },
  }
}

/** Every file of ops/vercel/, in the order docs/deploy.md applies them. */
export const FIREWALL_FILES: readonly { file: string; body: () => RuleBody | ManagedRulesBody }[] =
  [
    { file: "control-files-bypass.json", body: controlFilesBypass },
    { file: "probes-and-scrapers-deny.json", body: probesAndScrapersDeny },
    { file: "talks-ai-deny.json", body: talksAiDeny },
    { file: "training-crawlers.json", body: trainingCrawlers },
    { file: "dynamic-rate-limit-log.json", body: dynamicRateLimitLog },
    { file: "bot-protection-log.json", body: botProtectionLog },
  ]

/** A body as its file holds it (tab-indented, as the reviewed rule files
 * have been). */
export function firewallFileText(body: RuleBody | ManagedRulesBody): string {
  return `${JSON.stringify(body, null, "\t")}\n`
}
