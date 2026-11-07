import type { GuideSource } from "./guides"

/**
 * The sources of the two society guides (/guides/join-a-society,
 * /guides/start-a-society; ENG-106): every page they cite, read on
 * 2026-11-04 and fact-checked statement by statement (13 corrections). A
 * page cites one with `<Cite source={SOCIETY_SOURCES["su-fair"]} />`; its
 * source list is `societyGuideSources(slug)`, in the order below.
 */

const READ = "2026-11-04"

export const SOCIETY_SOURCES = {
  "su-fair": {
    publisher: "Cambridge SU",
    title: "Freshers' Fair",
    url: "https://www.cambridgesu.co.uk/freshers/freshersfair",
    retrieved: READ,
  },
  "su-fair-2026": {
    publisher: "Cambridge SU",
    title: "Freshers' Fair stallholder page (archived 22 August 2026)",
    url: "https://web.archive.org/web/20260822202000/https://www.cambridgesu.co.uk/opportunities/freshersfair/",
    retrieved: READ,
  },
  "su-fair-pack": {
    publisher: "Cambridge SU",
    title: "Freshers' Fair information pack for stallholders",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/freshersfair/Freshers-Fair-Information-Pack.pdf",
    retrieved: READ,
  },
  "su-what-is": {
    publisher: "Cambridge SU",
    title: "Freshers: what is a society? (9 September 2025)",
    url: "https://www.cambridgesu.co.uk/news/article/cambridgesu/Freshers-What-is-a-society/",
    retrieved: READ,
  },
  "su-find": {
    publisher: "Cambridge SU",
    title: "Find a Society",
    url: "https://www.cambridgesu.co.uk/opportunities/societies/",
    retrieved: READ,
  },
  "su-profile-paid-a": {
    publisher: "Cambridge SU",
    title: "A society's directory profile selling membership through an outside ticketing site",
    url: "https://www.cambridgesu.co.uk/organisation/10201/",
    retrieved: READ,
  },
  "su-profile-paid-b": {
    publisher: "Cambridge SU",
    title: "A society's directory profile selling membership through an outside payment site",
    url: "https://www.cambridgesu.co.uk/organisation/10021/",
    retrieved: READ,
  },
  "su-profile-free": {
    publisher: "Cambridge SU",
    title: "A society's directory profile with a free members' group",
    url: "https://www.cambridgesu.co.uk/organisation/10001/",
    retrieved: READ,
  },
  "su-refreshers-2024": {
    publisher: "Cambridge SU",
    title: "Refreshers' Fair: what to expect (January 2024)",
    url: "https://www.cambridgesu.co.uk/news/article/cambridgesu/Refreshers-Fair-What-to-expect-amp-why-you-should-go/",
    retrieved: READ,
  },
  "su-freshers": {
    publisher: "Cambridge SU",
    title: "Freshers",
    url: "https://www.cambridgesu.co.uk/freshers/",
    retrieved: READ,
  },
  "su-advice": {
    publisher: "Cambridge SU",
    title: "Student Advice Service",
    url: "https://www.cambridgesu.co.uk/advice",
    retrieved: READ,
  },
  "su-safeguarding": {
    publisher: "Cambridge SU",
    title: "Safeguarding",
    url: "https://www.cambridgesu.co.uk/safeguarding/",
    retrieved: READ,
  },
  "su-terms": {
    publisher: "Cambridge SU",
    title: "Registration terms and conditions for clubs and societies (updated August 2024)",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/start-a-society/SU-club-and-Soc-tscs(1).pdf",
    retrieved: READ,
  },
  "su-start": {
    publisher: "Cambridge SU",
    title: "Start a Society",
    url: "https://www.cambridgesu.co.uk/opportunities/start-a-society/",
    retrieved: READ,
  },
  "su-constitution": {
    publisher: "Cambridge SU",
    title: "Constitution template",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/support/resources/Cambridge-SU-Constitution-Template.pdf",
    retrieved: READ,
  },
  "su-logo": {
    publisher: "Cambridge SU",
    title: "Guidance for student societies on using the University logo",
    url: "https://www.cambridgesu.co.uk/pageassets/opportunities/start-a-society/Guidance-for-using-the-University-logo-Student-Societies.pdf",
    retrieved: READ,
  },
  "su-finance": {
    publisher: "Cambridge SU",
    title: "Society finance and grants",
    url: "https://www.cambridgesu.co.uk/opportunities/support/finance/",
    retrieved: READ,
  },
  "su-rooms": {
    publisher: "Cambridge SU",
    title: "Room hire",
    url: "https://www.cambridgesu.co.uk/opportunities/support/roomhire/",
    retrieved: READ,
  },
  "su-promotion": {
    publisher: "Cambridge SU",
    title: "Promotion for societies",
    url: "https://www.cambridgesu.co.uk/opportunities/support/promotion/",
    retrieved: READ,
  },
  "su-resources": {
    publisher: "Cambridge SU",
    title: "Committee resources",
    url: "https://www.cambridgesu.co.uk/opportunities/support/resources/",
    retrieved: READ,
  },
  "proctors-clubs": {
    publisher: "The Proctors",
    title: "Clubs and societies",
    url: "https://www.proctors.cam.ac.uk/clubsandsocs",
    retrieved: READ,
  },
  "proctors-list": {
    publisher: "The Proctors",
    title: "Societies registered with the Junior Proctor",
    url: "https://www.proctors.cam.ac.uk/clubsandsocs/registered-societies",
    retrieved: READ,
  },
  "proctors-notice": {
    publisher: "The Proctors",
    title: "Proctorial Notice 5, 2026–27: University clubs and societies",
    url: "https://www.proctors.cam.ac.uk/sites/default/files/5.%20University%20Clubs%20and%20Societies.pdf",
    retrieved: READ,
  },
  "jp-notes": {
    publisher: "The Junior Proctor",
    title: "Notes of guidance for clubs and societies (revised October 2026)",
    url: "https://www.proctors.cam.ac.uk/sites/default/files/202610.13%20JP%20Notes%20of%20Guidance%20for%20Societies%202026%20%28uploaded%20Oct%202026%29.pdf",
    retrieved: READ,
  },
  "syndicate-grants": {
    publisher: "The Proctors",
    title: "Grants from the Societies Syndicate",
    url: "https://www.proctors.cam.ac.uk/clubsandsocs/grants-from-the-societies-syndicate",
    retrieved: READ,
  },
  "free-speech": {
    publisher: "University governance and compliance",
    title: "Code of Practice on Freedom of Speech",
    url: "https://www.governanceandcompliance.admin.cam.ac.uk/policies-and-guidance/university-code-practice-freedom-speech",
    retrieved: READ,
  },
  "term-dates": {
    publisher: "The University",
    title: "Term dates and calendars",
    url: "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars",
    retrieved: READ,
  },
  "uis-lists": {
    publisher: "University Information Services",
    title: "Mailing lists",
    url: "https://help.uis.cam.ac.uk/service/email/lists",
    retrieved: READ,
  },
  "uis-subscribe": {
    publisher: "University Information Services",
    title: "Subscribing to a mailing list",
    url: "https://help.uis.cam.ac.uk/node/1450",
    retrieved: READ,
  },
  "anon-reporting": {
    publisher: "Student complaints office",
    title: "Anonymous reporting for students and staff",
    url: "https://www.studentcomplaints.admin.cam.ac.uk/anonymous-reporting-students-and-staff",
    retrieved: READ,
  },
  "sport-clubs": {
    publisher: "Sports Service",
    title: "University sports clubs",
    url: "https://www.sport.cam.ac.uk/student-sport/university-sports-clubs",
    retrieved: READ,
  },
  "sport-guide": {
    publisher: "Sports Service",
    title: "Sports Club Guide 2026–27 (PDF, as linked from its clubs page)",
    url: "https://live-cambridge-sports-cwp.pantheonsite.io/sites/default/files/UoC%20Sports%20Club%20Guide%2026-27_web.pdf",
    retrieved: READ,
  },
  "sport-eligibility": {
    publisher: "Sports Service",
    title: "Student eligibility criteria",
    url: "https://www.sport.cam.ac.uk/student-sport/university-sports-clubs/student-eligibility-criteria",
    retrieved: READ,
  },
  "sport-varsity": {
    publisher: "Sports Service",
    title: "Varsity matches",
    url: "https://www.sport.cam.ac.uk/varsity-matches",
    retrieved: READ,
  },
  "sport-give-it-a-go": {
    publisher: "Sports Service",
    title: "Recreational sport: Give It a Go",
    url: "https://www.sport.cam.ac.uk/recreational-sport-give-it-go",
    retrieved: READ,
  },
  "sport-college": {
    publisher: "Sports Service",
    title: "College sport",
    url: "https://www.sport.cam.ac.uk/college-sport",
    retrieved: READ,
  },
  "sport-student": {
    publisher: "Sports Service",
    title: "Student sport",
    url: "https://www.sport.cam.ac.uk/student-sport",
    retrieved: READ,
  },
  "pembroke-fairs": {
    publisher: "Pembroke College",
    title: "Freshers' guide: Freshers' Fair",
    url: "https://gp.pem.cam.ac.uk/freshers-guide/freshers-fair/",
    retrieved: READ,
  },
  "christs-fair": {
    publisher: "Christ's College",
    title: "Freshers' Fair",
    url: "https://www.christs.cam.ac.uk/student-life-1/freshers-fair",
    retrieved: READ,
  },
  "lucy-societies": {
    publisher: "Lucy Cavendish College",
    title: "Clubs and societies",
    url: "https://lucy.cam.ac.uk/our-college/place-live-and-study/clubs-and-societies",
    retrieved: READ,
  },
  "queens-form": {
    publisher: "Queens' College JCR",
    title: "Society registration form (Word document)",
    url: "https://www.qjcr.org.uk/content/SocietyRegistrationForm.docx",
    retrieved: READ,
  },
} as const satisfies Record<string, GuideSource>

export type SocietySourceId = keyof typeof SOCIETY_SOURCES

const GUIDE_SOURCES: Record<"join-a-society" | "start-a-society", readonly SocietySourceId[]> = {
  "join-a-society": [
    "su-what-is",
    "su-fair",
    "su-fair-2026",
    "term-dates",
    "pembroke-fairs",
    "christs-fair",
    "lucy-societies",
    "su-find",
    "proctors-list",
    "su-refreshers-2024",
    "sport-clubs",
    "sport-guide",
    "sport-eligibility",
    "sport-varsity",
    "sport-give-it-a-go",
    "sport-college",
    "uis-lists",
    "uis-subscribe",
    "su-freshers",
    "su-profile-paid-a",
    "su-profile-paid-b",
    "su-profile-free",
    "su-terms",
    "su-advice",
    "su-safeguarding",
    "anon-reporting",
  ],
  "start-a-society": [
    "su-start",
    "su-terms",
    "su-constitution",
    "su-find",
    "proctors-clubs",
    "proctors-list",
    "proctors-notice",
    "jp-notes",
    "queens-form",
    "sport-student",
    "su-finance",
    "syndicate-grants",
    "su-logo",
    "su-rooms",
    "free-speech",
    "su-promotion",
    "su-fair-2026",
    "su-fair-pack",
    "su-resources",
  ],
}

/** A society guide's sources, in the order its source list shows them. */
export function societyGuideSources(slug: "join-a-society" | "start-a-society"): GuideSource[] {
  return GUIDE_SOURCES[slug].map((id) => SOCIETY_SOURCES[id])
}
