import { afterEach, describe, expect, test } from "bun:test"
import {
  classifyEmail,
  isUniversityListing,
  type TermDates,
  termWeekLabel,
} from "../../convex/lib/derived"
import { nameTokens, termSpan, weekWindow } from "../../convex/lib/orgActivity"
import { buildSignInEmail } from "../../convex/lib/signInEmail"
import { DAY_MS, isoDateMs, londonIsoDate, londonMidnight, londonOffsetMs } from "../calendar"
import emailTypes from "../email-types.fixtures.json"
import { UNIVERSITY_NAME } from "../events"
import { ICS_UID_DOMAIN } from "../ics"
import {
  BOT_USER_AGENT,
  CAM_SIGN_IN_HREF,
  CONTACT_EMAIL,
  DISCLAIMER,
  SHARE_IMAGE_ALT,
  SITE_DESCRIPTION,
  SITE_INTRO,
  SITE_NAME,
  SITE_TAGLINE,
} from "../site"
import { TEACHING_WEEKS, TERM_NAMES, TERM_SHORT } from "../term-week"
import facts from "./campuses.fixtures.json"
import { deploymentCampus, deploymentProfile } from "./deployment"
import { CAMBRIDGE, CAMPUS_IDS, currentCampus, getCampus } from "./index"
import { classifyMemberEmail, isMemberEmail } from "./member-email"
import type { CampusProfile } from "./profile"
import { TESTFORD } from "./profiles/zz.testing"
import { termWeekLabel as campusTermWeekLabel, firstWeekStart } from "./terms"

/**
 * The campus core (decision D8): the profiles equal the shared facts, and
 * Cambridge's output through them is today's, byte for byte. The synthetic
 * campus `zz` ("Testford") proves the seams hold for a campus unlike it.
 */

const PROFILES: Record<string, CampusProfile> = { cam: CAMBRIDGE, zz: TESTFORD }

/** An instant at a London wall-clock time (BST-aware via londonOffsetMs). */
function london(iso: string): number {
  const naive = Date.parse(`${iso}Z`)
  return naive - londonOffsetMs(naive)
}

describe("profiles", () => {
  test("each profile's facts deep-equal campuses.fixtures.json", () => {
    expect(facts.schema).toBe("camsocs.campus-facts/1")
    expect(Object.keys(facts.campuses).sort()).toEqual(["cam", "zz"])
    expect(CAMBRIDGE.facts).toStrictEqual(facts.campuses.cam)
    expect(TESTFORD.facts).toStrictEqual(facts.campuses.zz)
    expect(CAMBRIDGE.id).toBe("cam")
    expect(TESTFORD.id).toBe("zz")
  })

  test("only cam is registered; zz is synthetic and never served", () => {
    expect(CAMPUS_IDS).toEqual(["cam"])
    expect(getCampus("cam")).toBe(CAMBRIDGE)
    expect(() => getCampus("zz")).toThrow(/Unknown campus/)
    expect(() => getCampus("university")).toThrow(/Unknown campus/)
    expect(TESTFORD.facts.synthetic).toBe(true)
    expect(CAMBRIDGE.facts.synthetic).toBeUndefined()
  })

  test("cam's presentation values are today's literals", () => {
    // L8 makes these modules read the profile; until then they must agree.
    expect(CAMBRIDGE.brand.name).toBe(SITE_NAME)
    expect(`${CAMBRIDGE.brand.wordmark.lead}${CAMBRIDGE.brand.wordmark.rest}`).toBe(SITE_NAME)
    expect(CAMBRIDGE.brand.tagline).toBe(SITE_TAGLINE)
    expect(CAMBRIDGE.brand.description).toBe(SITE_DESCRIPTION)
    expect(CAMBRIDGE.brand.intro).toBe(SITE_INTRO)
    expect(CAMBRIDGE.brand.shareAlt).toBe(SHARE_IMAGE_ALT)
    expect(CAMBRIDGE.brand.disclaimer).toBe(DISCLAIMER)
    expect(CAMBRIDGE.botUserAgent).toBe(BOT_USER_AGENT)
    expect(CAMBRIDGE.contactEmail).toBe(CONTACT_EMAIL)
    expect(CAMBRIDGE.memberTier.signInHref).toBe(CAM_SIGN_IN_HREF)
    expect(CAMBRIDGE.university.name).toBe(UNIVERSITY_NAME)
    expect(CAMBRIDGE.terms.names).toEqual(TERM_NAMES)
    expect(CAMBRIDGE.terms.short).toEqual(TERM_SHORT)
    expect(CAMBRIDGE.terms.teachingWeeks).toBe(TEACHING_WEEKS)
    expect(CAMBRIDGE.currentYearRegisters).toEqual(["su", "proctors", "sportsService", "cucbc"])
    expect(CAMBRIDGE.icsUidDomain).toBe(ICS_UID_DOMAIN)
  })

  test("cam's other presentation values are pinned as today's literals", () => {
    // No importable constant holds these yet (card.tsx, llms-txt.ts,
    // events.ts, event-details.tsx, login-form.tsx keep them module-private
    // or inline), so the literal is the safety net until L8 reads the profile.
    // `NOT_CAM_EMAIL` (betterAuth/auth.ts) is `memberTier.rejectMessage`, so
    // this is the only test pinning the server's refusal text.
    expect(CAMBRIDGE.brand.wordmark).toEqual({ lead: "CAM", rest: "socs" })
    expect(CAMBRIDGE.brand.shareHeadline).toEqual(["Everything on in", "Cambridge, in one place."])
    expect(CAMBRIDGE.brand.footerLine).toBe("Unofficial · every fact sourced")
    expect(CAMBRIDGE.brand.llmsSummary).toBe(
      "Cambridge student societies and sports clubs and the events they run, in one place. Every fact links to the page it came from.",
    )
    expect(CAMBRIDGE.brand.emailDisclaimer).toBe(
      "CAMsocs is an unofficial directory of Cambridge student societies. It is not affiliated with the University of Cambridge or Cambridge SU.",
    )
    expect(CAMBRIDGE.origin).toBe("https://camsocs.uk")
    expect(CAMBRIDGE.university).toEqual({
      name: "University of Cambridge",
      url: "https://www.cam.ac.uk",
      studentUnion: "Cambridge SU",
    })
    expect(CAMBRIDGE.place).toEqual({
      name: "Cambridge",
      addressLocality: "Cambridge",
      addressRegion: "Cambridgeshire",
      country: "GB",
      timeZone: "Europe/London",
      mapsSuffix: ", Cambridge",
    })
    expect(CAMBRIDGE.memberTier).toEqual({
      label: "Cambridge email",
      placeholder: "crsid@cam.ac.uk",
      tierLabel: "Cambridge-only",
      idName: "CRSid",
      loginSystem: "Raven",
      signInHref: "/sign-in?cam=1",
      rejectMessage: "Use your @cam.ac.uk address",
    })
  })
})

describe("deployment campus", () => {
  const saved = process.env.CAMSOCS_CAMPUS
  afterEach(() => {
    if (saved === undefined) delete process.env.CAMSOCS_CAMPUS
    else process.env.CAMSOCS_CAMPUS = saved
  })

  test("unset or empty is cam; an unknown id throws", () => {
    expect(deploymentCampus({})).toBe("cam")
    expect(deploymentCampus({ CAMSOCS_CAMPUS: "" })).toBe("cam")
    expect(deploymentCampus({ CAMSOCS_CAMPUS: " cam " })).toBe("cam")
    expect(deploymentProfile({})).toBe(CAMBRIDGE)
    expect(() => deploymentCampus({ CAMSOCS_CAMPUS: "zz" })).toThrow(/not a known campus/)
    expect(() => deploymentCampus({ CAMSOCS_CAMPUS: "ox" })).toThrow(/not a known campus/)
  })

  test("read inside each call, so the Convex rules follow the env var", () => {
    delete process.env.CAMSOCS_CAMPUS
    expect(classifyEmail("abc12@cam.ac.uk")).toBe("personal_crsid")
    process.env.CAMSOCS_CAMPUS = "typo"
    expect(() => classifyEmail("abc12@cam.ac.uk")).toThrow(/not a known campus/)
  })

  test("Next's campus is cam when NEXT_PUBLIC_CAMPUS is unset", () => {
    expect(process.env.NEXT_PUBLIC_CAMPUS ?? "").toBe("")
    expect(currentCampus()).toBe(CAMBRIDGE)
  })
})

// --- term weeks ---------------------------------------------------------------------------------

/** derived.ts `termWeekLabel` as it was before the campus seam, verbatim:
 * the reference Cambridge's labels must keep matching. */
const LEGACY_PREFIX: Record<string, string> = { michaelmas: "MT", lent: "LT", easter: "ET" }
function legacyTermWeekLabel(ms: number, terms: readonly TermDates[]): string | undefined {
  const day = isoDateMs(londonIsoDate(ms))
  for (const term of terms) {
    const start = isoDateMs(term.fullTermStart)
    const end = isoDateMs(term.fullTermEnd)
    const firstThursday = start + ((4 - new Date(start).getUTCDay() + 7) % 7) * DAY_MS
    const week = Math.floor((day - firstThursday) / (7 * DAY_MS)) + 1
    if (week < 0 || day > end) continue
    const year = new Date(start).getUTCFullYear() % 100
    return `${LEGACY_PREFIX[term.term]}${String(year).padStart(2, "0")} Wk ${week}`
  }
  return undefined
}

/** The 2026-27 Full Term dates (source-research §19), then synthetic terms
 * starting on every weekday (Tue, Mon, Thu, Sun, Sat, Wed, Thu, Fri), so each
 * branch of the week-start arithmetic is exercised. */
const TERMS: TermDates[] = [
  {
    academicYear: "2026-27",
    term: "michaelmas",
    fullTermStart: "2026-10-06",
    fullTermEnd: "2026-12-04",
  },
  { academicYear: "2026-27", term: "lent", fullTermStart: "2027-01-19", fullTermEnd: "2027-03-19" },
  {
    academicYear: "2026-27",
    term: "easter",
    fullTermStart: "2027-04-27",
    fullTermEnd: "2027-06-18",
  },
  {
    academicYear: "2027-28",
    term: "michaelmas",
    fullTermStart: "2027-10-04",
    fullTermEnd: "2027-12-03",
  },
  { academicYear: "2027-28", term: "lent", fullTermStart: "2028-01-13", fullTermEnd: "2028-03-14" },
  {
    academicYear: "2027-28",
    term: "easter",
    fullTermStart: "2028-04-23",
    fullTermEnd: "2028-06-16",
  },
  {
    academicYear: "2028-29",
    term: "michaelmas",
    fullTermStart: "2028-10-07",
    fullTermEnd: "2028-12-08",
  },
  { academicYear: "2028-29", term: "lent", fullTermStart: "2029-01-17", fullTermEnd: "2029-03-16" },
  {
    academicYear: "2028-29",
    term: "easter",
    fullTermStart: "2029-04-26",
    fullTermEnd: "2029-06-15",
  },
  {
    academicYear: "2029-30",
    term: "michaelmas",
    fullTermStart: "2029-10-05",
    fullTermEnd: "2029-12-07",
  },
]

describe("termWeekLabel", () => {
  test("the synthetic terms start on all seven weekdays", () => {
    const weekdays = new Set(TERMS.map((t) => new Date(isoDateMs(t.fullTermStart)).getUTCDay()))
    expect([...weekdays].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test("cam labels equal today's derived output over 3.5 years, every six hours", () => {
    let labelled = 0
    for (
      let ms = london("2026-07-01T00:00:00");
      ms < london("2030-01-01T00:00:00");
      ms += DAY_MS / 4
    ) {
      const expected = legacyTermWeekLabel(ms, TERMS)
      expect(campusTermWeekLabel(ms, TERMS, CAMBRIDGE.facts.terms)).toBe(expected)
      expect(termWeekLabel(ms, TERMS)).toBe(expected)
      expect(termWeekLabel(ms, TERMS, CAMBRIDGE)).toBe(expected)
      if (expected) labelled += 1
    }
    expect(labelled).toBeGreaterThan(1000)
    expect(termWeekLabel(london("2026-10-08T09:00:00"), TERMS)).toBe("MT26 Wk 1")
  })

  test("zz weeks start on Sunday and use its own term codes", () => {
    const zzTerms = [
      { term: "michaelmas", fullTermStart: "2026-10-06", fullTermEnd: "2026-12-04" },
      { term: "hilary", fullTermStart: "2027-01-17", fullTermEnd: "2027-03-12" },
    ]
    const model = TESTFORD.facts.terms
    expect(firstWeekStart("2026-10-06", model)).toBe("2026-10-11")
    expect(firstWeekStart("2027-01-17", model)).toBe("2027-01-17")
    expect(campusTermWeekLabel(london("2026-10-03T12:00:00"), zzTerms, model)).toBeUndefined()
    expect(campusTermWeekLabel(london("2026-10-04T12:00:00"), zzTerms, model)).toBe("MT26 Wk 0")
    expect(campusTermWeekLabel(london("2026-10-10T23:30:00"), zzTerms, model)).toBe("MT26 Wk 0")
    expect(campusTermWeekLabel(london("2026-10-11T00:30:00"), zzTerms, model)).toBe("MT26 Wk 1")
    expect(campusTermWeekLabel(london("2026-10-17T12:00:00"), zzTerms, model)).toBe("MT26 Wk 1")
    expect(campusTermWeekLabel(london("2026-10-18T12:00:00"), zzTerms, model)).toBe("MT26 Wk 2")
    expect(campusTermWeekLabel(london("2026-12-05T12:00:00"), zzTerms, model)).toBeUndefined()
    expect(campusTermWeekLabel(london("2027-01-17T12:00:00"), zzTerms, model)).toBe("HT27 Wk 1")
    // The same instant under Cambridge's Thursday weeks is another week.
    expect(campusTermWeekLabel(london("2026-10-11T12:00:00"), zzTerms, CAMBRIDGE.facts.terms)).toBe(
      "MT26 Wk 1",
    )
    expect(campusTermWeekLabel(london("2026-10-15T12:00:00"), zzTerms, CAMBRIDGE.facts.terms)).toBe(
      "MT26 Wk 2",
    )
    expect(campusTermWeekLabel(london("2026-10-15T12:00:00"), zzTerms, model)).toBe("MT26 Wk 1")
  })

  test("the activity windows follow the campus's week start", () => {
    const michaelmas = TERMS[0]
    expect(termSpan(michaelmas)).toEqual({ start: "2026-10-01", end: "2026-12-04" })
    expect(termSpan(michaelmas, CAMBRIDGE)).toEqual({ start: "2026-10-01", end: "2026-12-04" })
    expect(termSpan(michaelmas, TESTFORD)).toEqual({ start: "2026-10-04", end: "2026-12-04" })
    const noon = london("2026-10-15T12:00:00")
    expect(weekWindow(TERMS, noon).from).toBe(londonMidnight("2026-10-15"))
    expect(weekWindow(TERMS, noon, TESTFORD).from).toBe(londonMidnight("2026-10-11"))
  })
})

// --- member email ------------------------------------------------------------------------------

describe("classifyEmail", () => {
  test("every emailCases row names a known campus", () => {
    // Else PROFILES[campus] is undefined and classifyEmail silently falls back
    // to the deployment profile (cam).
    for (const { campus } of facts.emailCases) expect(Object.keys(PROFILES)).toContain(campus)
  })

  test.each(
    facts.emailCases.map((c) => [c.campus, c.email, c.type]),
  )("%s: %s → %s", (campus, email, type) => {
    const profile = PROFILES[campus]
    if (!profile) throw new Error(`emailCases row names unknown campus ${campus}`)
    expect(classifyEmail(email, profile)).toBe(type as never)
  })

  test("cam through the profile is today's rule for every shared email-type case", () => {
    for (const { email, type } of emailTypes.cases) {
      expect(classifyEmail(email, CAMBRIDGE)).toBe(type as never)
      expect(classifyEmail(email)).toBe(type as never)
    }
  })

  test("cam is not strict about other universities (byte-identical)", () => {
    expect(classifyEmail("j.smith@unknown.ac.uk", CAMBRIDGE)).toBe("role_own_domain")
    expect(classifyEmail("jane.doe@chem.cam.ac.uk", CAMBRIDGE)).toBe("college_domain")
  })

  test("zz: name-shaped locals on its domains, unfamiliar ac.uk and alumni are personal", () => {
    expect(classifyEmail("chess@unknown.ac.uk", TESTFORD)).toBe("personal_crsid")
    expect(classifyEmail("abc12@cam.ac.uk", TESTFORD)).toBe("personal_crsid")
    expect(classifyEmail("jane.doe@testford.ac.uk", TESTFORD)).toBe("personal_crsid")
    expect(classifyEmail("jane.doe@testford-alumni.org", TESTFORD)).toBe("personal_crsid")
    expect(classifyEmail("president@testford-alumni.org", TESTFORD)).toBe("role_own_domain")
    expect(classifyEmail("chess@society.testford.ac.uk", TESTFORD)).toBe("college_domain")
    expect(classifyEmail("jane.doe@lists.testford.ac.uk", TESTFORD)).toBe("lists_cam")
    expect(classifyEmail("chess@srcf.net", TESTFORD)).toBe("role_own_domain")
    expect(classifyEmail("cuchess@gmail.com", TESTFORD)).toBe("webmail")
  })

  test("classifyMemberEmail answers only the personal rule", () => {
    expect(classifyMemberEmail("abc12", "cam.ac.uk", CAMBRIDGE)).toBe("personal_crsid")
    expect(classifyMemberEmail("abc12", "lists.cam.ac.uk", CAMBRIDGE)).toBeUndefined()
    expect(classifyMemberEmail("president", "cam.ac.uk", CAMBRIDGE)).toBeUndefined()
    expect(classifyMemberEmail("jane.doe", "chem.testford.ac.uk", TESTFORD)).toBe("personal_crsid")
    expect(classifyMemberEmail("chess", "testford.ac.uk", TESTFORD)).toBeUndefined()
  })
})

describe("isMemberEmail", () => {
  test("exactly a member domain, case-insensitive, trimmed, never a subdomain", () => {
    expect(isMemberEmail("  Ab123@CAM.AC.UK ", CAMBRIDGE)).toBe(true)
    expect(isMemberEmail("ab123@srcf.cam.ac.uk", CAMBRIDGE)).toBe(false)
    expect(isMemberEmail("ab123@cam.ac.uk.evil.com", CAMBRIDGE)).toBe(false)
    expect(isMemberEmail("ab123@camxac.uk", CAMBRIDGE)).toBe(false)
    expect(isMemberEmail("a b@cam.ac.uk", CAMBRIDGE)).toBe(false)
    expect(isMemberEmail(`${"a".repeat(250)}@cam.ac.uk`, CAMBRIDGE)).toBe(false)
    expect(isMemberEmail("jane@testford.ac.uk", TESTFORD)).toBe(true)
    expect(isMemberEmail("jane@chem.testford.ac.uk", TESTFORD)).toBe(false)
    expect(isMemberEmail("ab123@cam.ac.uk", TESTFORD)).toBe(false)
  })
})

// --- other Convex rules -----------------------------------------------------------------------

describe("other campus rules", () => {
  test("the university's own listings are the campus's official sources", () => {
    const listing = { source: "uni_events_api", organiserKeys: [], coHostKeys: [] }
    expect(isUniversityListing(listing)).toBe(true)
    expect(isUniversityListing(listing, CAMBRIDGE)).toBe(true)
    expect(isUniversityListing(listing, TESTFORD)).toBe(false)
  })

  test("name stopwords are the campus's", () => {
    expect(nameTokens("cambridge university chess club")).toEqual(new Set(["chess"]))
    expect(nameTokens("cambridge university chess club", TESTFORD)).toEqual(
      new Set(["cambridge", "chess"]),
    )
    expect(nameTokens("testford university chess club", TESTFORD)).toEqual(new Set(["chess"]))
  })

  test("the sign-in email names the campus's product and disclaimer", () => {
    const url = "https://x.test/?a=1&b=2"
    const cam = buildSignInEmail("a@example.org", "ab123@cam.ac.uk", url)
    expect(cam).toEqual(buildSignInEmail("a@example.org", "ab123@cam.ac.uk", url, CAMBRIDGE))
    // Today's message, byte for byte.
    const href = "https://x.test/?a=1&amp;b=2"
    const note =
      "It works once and expires in 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the link."
    const disclaimer =
      "CAMsocs is an unofficial directory of Cambridge student societies. It is not affiliated with the University of Cambridge or Cambridge SU."
    expect(cam).toEqual({
      from: "a@example.org",
      to: ["ab123@cam.ac.uk"],
      subject: "Your CAMsocs sign-in link",
      text: ["Sign in to CAMsocs with this link:", "", url, "", note, "", disclaimer].join("\n"),
      html: [
        '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f1d24">',
        "<p>Sign in to CAMsocs with this link:</p>",
        `<p><a href="${href}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1f1d24;color:#ffffff;text-decoration:none">Sign in to CAMsocs</a></p>`,
        `<p style="font-size:13px;color:#5f5a66">Or paste this address into your browser:<br><span style="word-break:break-all">${href}</span></p>`,
        `<p style="font-size:13px;color:#5f5a66">${note}</p>`,
        `<p style="font-size:12px;color:#8a8590">${disclaimer}</p>`,
        "</div>",
      ].join(""),
    })
    const zz = buildSignInEmail("a@example.org", "jane@testford.ac.uk", "https://x.test/", TESTFORD)
    expect(zz.subject).toBe("Your ZZsocs sign-in link")
    expect(zz.text).not.toContain("Cambridge")
    expect(zz.html).not.toContain("Cambridge")
  })
})
