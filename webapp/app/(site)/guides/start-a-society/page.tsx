import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { GuideArticle } from "@/components/organisms/guide-article"
import { api } from "@/convex/_generated/api"
import { londonIsoDate } from "@/lib/calendar"
import { linkProps } from "@/lib/crawl-traps"
import { CATEGORIES_PATH } from "@/lib/directory-hubs"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { SOCIETY_SOURCES, type SocietySourceId, societyGuideSources } from "@/lib/society-guides"
import { formatDayWithYear } from "@/lib/term-calendar"

const GUIDE = guide("start-a-society")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
}

/** How many listings CAMsocs has (the same cached read as /categories), or
 * null when it cannot be read. */
async function loadTotal(): Promise<number | null> {
  try {
    return (await publicQuery(api.orgs.facets, {})).total
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

/** Grant deadlines for 2026–27, as their pages publish them. */
const DEADLINES: readonly { what: string; date: string; source: SocietySourceId }[] = [
  { what: "SU grants, Michaelmas window closes", date: "2026-12-06", source: "su-finance" },
  { what: "SU grants, Michaelmas claims due", date: "2026-12-13", source: "su-finance" },
  { what: "SU grants, Lent window opens", date: "2027-01-11", source: "su-finance" },
  {
    what: "Societies Syndicate, Lent applications due",
    date: "2027-02-01",
    source: "syndicate-grants",
  },
  { what: "SU grants, Lent window closes", date: "2027-03-22", source: "su-finance" },
  { what: "SU grants, Lent claims due", date: "2027-04-11", source: "su-finance" },
  { what: "SU grants, Easter window opens", date: "2027-04-26", source: "su-finance" },
  {
    what: "Societies Syndicate, Easter applications due",
    date: "2027-05-03",
    source: "syndicate-grants",
  },
  { what: "SU grants, Easter window closes", date: "2027-05-25", source: "su-finance" },
  { what: "SU grants, Easter claims due", date: "2027-06-15", source: "su-finance" },
]

const TOC = [
  ["#short", "In short"],
  ["#exists", "Does it exist already?"],
  ["#routes", "Three ways to register"],
  ["#steps", "Step by step"],
  ["#constitution", "The constitution"],
  ["#name", "The name and the logo"],
  ["#money", "Money"],
  ["#events", "Rooms, events and publicity"],
  ["#safety", "Safety, insurance and the law"],
  ["#keeping", "Keeping it going"],
  ["#listed", "Getting listed on CAMsocs"],
] as const

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"
const TD = "px-3 py-2.5 align-top"

export default async function StartASocietyGuide() {
  const total = await loadTotal()
  const today = londonIsoDate(Date.now())
  const upcoming = DEADLINES.filter((deadline) => deadline.date >= today)

  return (
    <GuideArticle
      guide={GUIDE}
      toc={TOC}
      sources={societyGuideSources("start-a-society")}
      lede={
        <>
          What it takes to set up a new student society in Cambridge: who to register with, what
          they ask for, where the money comes from, and the rules that come with running one.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Next grant deadlines
          </h2>
          {upcoming.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {upcoming.slice(0, 3).map((deadline) => (
                <li key={deadline.what} className="flex flex-col">
                  <span className="font-mono text-xs tabular-nums">
                    {formatDayWithYear(deadline.date)}
                  </span>
                  <span className="text-muted-foreground">{deadline.what}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              The 2026–27 deadlines have passed. Check the SU's and the Syndicate's pages for the
              next year's.
            </p>
          )}
          <a href="#money" className="underline underline-offset-4">
            All of them
          </a>
        </div>
      }
    >
      <ProseSection id="short" title="In short">
        <ul>
          <li>Check that the society does not exist already. Duplicates are not approved.</li>
          <li>
            Find at least two co-founders for a committee of three, at least five members and a
            constitution. Then register with Cambridge SU, which takes up to 14 working days.
          </li>
          <li>
            Registering with the Junior Proctor is optional and separate. It needs a Senior
            Treasurer and brings University grants, insurance and the right to use the University's
            name.
          </li>
          <li>A society within one college starts with its JCR or MCR.</li>
        </ul>
      </ProseSection>

      <ProseSection id="exists" title="Does it exist already?">
        <p>
          The SU will not approve an exact duplicate of a society it already has, so look first.
          <Cite source={SOCIETY_SOURCES["su-start"]} />
        </p>
        <ul>
          <li>
            The SU's <strong>Find a Society</strong> directory lists every society registered with
            it.
            <Cite source={SOCIETY_SOURCES["su-find"]} />
          </li>
          <li>
            The Proctors publish the list of societies registered with the Junior Proctor.
            <Cite source={SOCIETY_SOURCES["proctors-list"]} />
          </li>
          <li>
            CAMsocs puts both together with sports clubs and college societies:{" "}
            <Link {...linkProps("/societies")}>
              {total ? `${total} listings` : "the directory"}
            </Link>
            , also <Link href={CATEGORIES_PATH}>by category</Link>. Each listing says where its
            facts came from and when they were read.
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="routes" title="Three ways to register">
        <p>
          A society can register with Cambridge SU, with the Junior Proctor (the University), with
          its college, or with more than one. They are separate, and each brings something
          different.
          <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />
        </p>
        <div className="overflow-x-auto rounded-xl border text-foreground">
          <table className="w-full text-sm">
            <caption className="sr-only">
              What each kind of registration asks for and what it brings
            </caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className={TH}>
                  With
                </th>
                <th scope="col" className={TH}>
                  You need
                </th>
                <th scope="col" className={TH}>
                  You get
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <th scope="row" className={`${TD} text-left font-medium`}>
                  Cambridge SU
                </th>
                <td className={TD}>
                  A committee of three, a student president, five members, a constitution
                  <Cite source={SOCIETY_SOURCES["su-terms"]} />
                </td>
                <td className={TD}>
                  Fair stalls, the SU directory and events listings, room booking, promotion
                  <Cite source={SOCIETY_SOURCES["su-start"]} />
                  <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />
                </td>
              </tr>
              <tr>
                <th scope="row" className={`${TD} text-left font-medium`}>
                  Junior Proctor
                </th>
                <td className={TD}>
                  A Senior Treasurer, a constitution, signed accounts, a list of officers
                  <Cite source={SOCIETY_SOURCES["jp-notes"]} />
                </td>
                <td className={TD}>
                  The University's name, Societies Syndicate grants, insurance cover, IT services
                  <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />
                </td>
              </tr>
              <tr>
                <th scope="row" className={`${TD} text-left font-medium`}>
                  Your college
                </th>
                <td className={TD}>
                  It varies; Queens', for one, asks for evidence of support
                  <Cite source={SOCIETY_SOURCES["queens-form"]} />
                </td>
                <td className={TD}>
                  College rooms and college funding, at Queens' for one
                  <Cite source={SOCIETY_SOURCES["queens-form"]} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>Cambridge SU</h3>
        <p>
          The SU's terms (updated August 2024) ask that a society
          <Cite source={SOCIETY_SOURCES["su-terms"]} />:
        </p>
        <ul>
          <li>
            has a committee of three, at least half of them current students, and a president who is
            a current student;
          </li>
          <li>has at least five members, most of them current students;</li>
          <li>
            has a constitution or guiding document, available to members and uploaded to its SU
            profile;
          </li>
          <li>is active through the year with a programme of events, and not for profit;</li>
          <li>is distinct from existing societies;</li>
          <li>
            is not a front for an outside organisation, and declares any affiliation, for example to
            a national charity, brand or political party.
          </li>
        </ul>
        <p>
          You apply through the SU's online form; new applications can take up to 14 working days.
          Questions go to activities@cambridgesu.co.uk with the subject “New Society Set-Up”.
          <Cite source={SOCIETY_SOURCES["su-start"]} />
        </p>

        <h3>The Junior Proctor</h3>
        <p>
          Registration with the Junior Proctor is voluntary. Any club or society made up wholly or
          partly of registered students can apply; sports clubs register with the Sports Service
          instead.
          <Cite source={SOCIETY_SOURCES["proctors-notice"]} /> Registering brings
          <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />:
        </p>
        <ul>
          <li>
            the use of the University's name and branding, which only registered societies may use;
          </li>
          <li>grants from the Societies Syndicate;</li>
          <li>cover under some of the University's insurance;</li>
          <li>
            IT services: a societies.cam.ac.uk web address, @cam mailing lists, shared mailboxes and
            Teams;
          </li>
          <li>a place on the public list of registered societies.</li>
        </ul>
        <p>
          It needs a <strong>Senior Treasurer</strong>, normally a member of the Regent House (whose
          roll is published each Michaelmas in the University's Reporter), or exceptionally someone
          else the Junior Proctor approves.
          <Cite source={SOCIETY_SOURCES["jp-notes"]} /> To apply, email the Junior Proctor (the
          Proctors' page gives junior.proctor@cam.ac.uk) at any time with the constitution, a
          statement of accounts signed by the Senior Treasurer (a new society's may show no
          transactions) and the list of officers. The Proctors' page has templates for all three.
          <Cite source={SOCIETY_SOURCES["proctors-clubs"]} /> A refusal can be appealed to the
          Societies Syndicate.
          <Cite source={SOCIETY_SOURCES["jp-notes"]} />
        </p>

        <h3>Your college</h3>
        <p>
          A society within one college should speak to its JCR or MCR first; the SU also recognises
          college-based societies set up there.
          <Cite source={SOCIETY_SOURCES["su-start"]} /> Each college has its own process. At
          Queens', for example, a new society sends a form with its name, a mission statement,
          evidence of support such as a petition of 10 students, and a proposer and seconder, to the
          JCR or MCR officer for societies. The college union's council meets twice a term, and an
          unregistered society cannot book college rooms or claim funding.
          <Cite source={SOCIETY_SOURCES["queens-form"]} />
        </p>

        <h3>Sports clubs</h3>
        <p>
          University sports clubs register with the Sports Service, not the Junior Proctor.
          <Cite source={SOCIETY_SOURCES["proctors-notice"]} /> Its pages give no public process for
          starting a new club; write to enquiries@sport.cam.ac.uk or call 01223 336580.
          <Cite source={SOCIETY_SOURCES["sport-student"]} />
        </p>
      </ProseSection>

      <ProseSection id="steps" title="Step by step">
        <ol className="flex list-decimal flex-col gap-1.5 pl-5">
          <li>
            <strong>Check it does not exist.</strong> Search the directories{" "}
            <a href="#exists">above</a>.
          </li>
          <li>
            <strong>Find your committee.</strong> Three people for the SU, with a student as
            president, and at least five members.
            <Cite source={SOCIETY_SOURCES["su-terms"]} />
          </li>
          <li>
            <strong>Write a constitution.</strong> Start from the SU's template or the Proctors'
            sample (<a href="#constitution">below</a>).
          </li>
          <li>
            <strong>Pick a name</strong> that does not suggest you are part of the University (
            <a href="#name">below</a>).
          </li>
          <li>
            <strong>Register with the SU</strong> through its online form, and allow 14 working
            days.
            <Cite source={SOCIETY_SOURCES["su-start"]} />
          </li>
          <li>
            <strong>If you want University registration</strong>, find a Senior Treasurer and email
            the Junior Proctor.
            <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />
          </li>
          <li>
            <strong>Open a bank account</strong> in the society's name, and apply for a start-up
            grant (<a href="#money">below</a>).
          </li>
          <li>
            <strong>Plan your first events</strong>, book rooms and tell people (
            <a href="#events">below</a>).
          </li>
          <li>
            <strong>Get listed on CAMsocs</strong> (<a href="#listed">below</a>).
          </li>
        </ol>
      </ProseSection>

      <ProseSection id="constitution" title="The constitution">
        <p>
          The SU has a constitution template. It covers the society's aims (and which of the SU's
          seven groups it belongs to), membership, the committee and its duties, meetings,
          amendments, SU registration and dissolution. It says only matriculated Cambridge students
          may hold committee posts, and that committee elections run by secret ballot on the SU's
          website.
          <Cite source={SOCIETY_SOURCES["su-constitution"]} />
        </p>
        <p>
          The Junior Proctor's guidance lists what a constitution should set out: the name and aims;
          who can be a member and vote; how elections work; the officers' powers and duties; general
          and extraordinary meetings; how to change the constitution; subscriptions; finance and
          audit; how the society is wound up and its assets disposed of; and a disciplinary process
          with an appeal.
          <Cite source={SOCIETY_SOURCES["jp-notes"]} /> For a registered society, most of the
          executive committee must be current students or members of the Regent House, most of the
          principal officers (such as the President, Secretary and Junior Treasurer) must be current
          students, and there must be a published complaints procedure.
          <Cite source={SOCIETY_SOURCES["jp-notes"]} />
        </p>
      </ProseSection>

      <ProseSection id="name" title="The name and the logo">
        <ul>
          <li>
            The Junior Proctor declines names that suggest a society is a University institution, or
            that are ambiguous or misleading.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
          <li>
            Only registered societies may use the University's shield, unaltered and shown apart
            from the society's own name.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} /> The SU's guidance for societies adds: use
            the full University logo, never the coat of arms alone, never altered or merged into
            your own logo, with clear space around it and at least 30mm wide.
            <Cite source={SOCIETY_SOURCES["su-logo"]} />
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="money" title="Money">
        <h3>A bank account</h3>
        <p>
          The SU is not taking new applications for its internal society finance accounts, which in
          any case are open only to societies registered with it for a year.
          <Cite source={SOCIETY_SOURCES["su-finance"]} /> So a new society needs its own account.
          The Junior Proctor's guidance: the account should be in the society's full name; two
          people should have to sign, so no one officer can authorise spending alone, ideally with
          the Senior Treasurer as a signatory; online banking passwords should never be shared, and
          should change when officers do.
          <Cite source={SOCIETY_SOURCES["jp-notes"]} />
        </p>

        <h3>Grants</h3>
        <ul>
          <li>
            <strong>SU Start-up Grant</strong>: up to £250, for societies registered with the SU
            within the last term. It cannot pay for SU services such as a Freshers' Fair stall.
            <Cite source={SOCIETY_SOURCES["su-finance"]} />
          </li>
          <li>
            <strong>SU Society Grants</strong>: three kinds (Education, Community-Building, and
            Liberation & Social Causes), up to £350 each. Apply through the “Grant Application”
            option on your society's SU page at least 14 days before the activity; a decision takes
            up to 14 days, and payment up to 14 more.
            <Cite source={SOCIETY_SOURCES["su-finance"]} />
          </li>
          <li>
            <strong>Societies Syndicate</strong>, for societies registered (or registering) with the
            Junior Proctor: launch grants, normally £200 or less, for start-up costs such as
            publicity, a first meeting or a fair stall, plus one-off and ongoing grants and
            guarantees against loss. Grants are not normally given to societies that charge no
            membership fee, and need a bank statement in the society's name and the Senior
            Treasurer's approval. Queries go to societiessyndicate@admin.cam.ac.uk.
            <Cite source={SOCIETY_SOURCES["syndicate-grants"]} />
          </li>
        </ul>
        <div className="overflow-x-auto rounded-xl border text-foreground">
          <table className="w-full text-sm">
            <caption className="sr-only">Grant deadlines for 2026–27</caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className={TH}>
                  Date
                </th>
                <th scope="col" className={TH}>
                  Deadline
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {DEADLINES.map((deadline) => {
                const passed = deadline.date < today
                return (
                  <tr key={deadline.what} className={passed ? "text-muted-foreground" : undefined}>
                    <td className={`${TD} font-mono whitespace-nowrap tabular-nums`}>
                      {formatDayWithYear(deadline.date)}
                    </td>
                    <td className={TD}>
                      {deadline.what}
                      {passed ? " (passed)" : ""}
                      <Cite source={SOCIETY_SOURCES[deadline.source]} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p>
          A society whose turnover passes £90,000 must register for VAT.
          <Cite source={SOCIETY_SOURCES["su-finance"]} />
        </p>
      </ProseSection>

      <ProseSection id="events" title="Rooms, events and publicity">
        <h3>Rooms</h3>
        <p>
          The SU Hub, in the University Centre, is free to SU-registered societies and booked
          through the SU's Activities Dashboard; book well ahead, as the SU's page asks for between
          five days' and two weeks' notice. In term it can be booked from 5pm to 8:45pm on Mondays,
          Wednesdays and Fridays and from 5pm to 7pm on Tuesdays and Thursdays, and holds 50 people
          (about 20 seated). The SU also publishes a room booking guide covering the colleges,
          University sites and others.
          <Cite source={SOCIETY_SOURCES["su-rooms"]} />
        </p>
        <h3>Events and speakers</h3>
        <ul>
          <li>
            On University premises, an event outside the curriculum needs a University organiser and
            permission, and rooms should be booked at least fourteen working days ahead. If you
            expect significant protest, consult the Proctors as early as you can, ideally at least
            seven working days ahead. Colleges have their own codes.
            <Cite source={SOCIETY_SOURCES["free-speech"]} />
          </li>
          <li>
            Registered societies are asked to send the Proctors their programme before each term. A
            public play or entertainment may need a licence from the City Council, with 14 days'
            written notice at a licensed venue and at least 30 days' otherwise; don't advertise a
            licensable event before the licence is granted. For an event in a college, ask the
            college.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
        </ul>
        <h3>Telling people</h3>
        <ul>
          <li>
            Any committee member of an SU-registered society can add events to the SU's What's On
            calendar, and apply for a Society Spotlight on the SU's Instagram.
            <Cite source={SOCIETY_SOURCES["su-promotion"]} />
          </li>
          <li>
            Stalls for the Freshers' Fair go on sale in July and August, and for the Refreshers'
            Fair in November and December; the SU emails registered committees when they do.
            <Cite source={SOCIETY_SOURCES["su-promotion"]} /> In 2026 a standard stall cost £50
            indoors or £40 outdoors.
            <Cite source={SOCIETY_SOURCES["su-fair-2026"]} /> No alcohol is allowed at the fair, and
            high-risk equipment needs a risk assessment.
            <Cite source={SOCIETY_SOURCES["su-fair-pack"]} />
          </li>
          <li>
            Once you have events, CAMsocs can show them on{" "}
            <Link {...linkProps("/events")}>Events</Link> and your society's page: see{" "}
            <a href="#listed">below</a>.
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="safety" title="Safety, insurance and the law">
        <ul>
          <li>
            <strong>Liability.</strong> Societies are independent of the University, which accepts
            no liability for their debts. Most are unincorporated members' clubs, so a claim can
            fall on officers or members personally.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
          <li>
            <strong>Insurance.</strong> The University's public liability insurance extends to
            societies registered with the Junior Proctor, subject to a risk assessment of their
            activities. It does not cover, among other things, personal accident, belongings,
            vehicles or travel.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
            <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />
          </li>
          <li>
            <strong>Health and safety.</strong> A society is responsible for its members' safety;
            its officers should carry out risk assessments, have their own electrical equipment
            tested each year and keep a written code of practice. Work with children or vulnerable
            adults may need DBS checks.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
          <li>
            <strong>Sponsors.</strong> A sponsorship needs the Senior Treasurer's agreement and a
            written agreement saying how the money is used and what the sponsor gets. A sponsor may
            not use the University's name or arms, and sharing members' data with one must follow
            data protection law. For an employer-related event, contact the Careers Service at least
            12 weeks ahead.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
          <li>
            The SU's committee resources include a finance guide, a guide to the society web page
            and guidance on the Foreign Influence Registration Scheme.
            <Cite source={SOCIETY_SOURCES["su-resources"]} />
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="keeping" title="Keeping it going">
        <ul>
          <li>
            <strong>SU.</strong> Registration renews every year; a society that does not re-register
            is archived. Tell the SU within a week if your contacts or membership rules change, or
            if the society disbands.
            <Cite source={SOCIETY_SOURCES["su-terms"]} /> The Proctors' page says the SU renews in
            June and July.
            <Cite source={SOCIETY_SOURCES["proctors-clubs"]} />
          </li>
          <li>
            <strong>Junior Proctor.</strong> Re-register between 1 July and 31 December through the
            Proctors' Moodle site, with your latest accounts, current officers and any changes to
            the constitution; miss the deadline and you must register from scratch.
            <Cite source={SOCIETY_SOURCES["proctors-clubs"]} /> The guidance asks for it ideally by
            30 September, with accounts signed by the Senior Treasurer.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
          <li>
            <strong>Winding up.</strong> When a society registered with the Junior Proctor is
            dissolved, its remaining funds go to the Societies Syndicate (or, under the model
            constitution, to another registered society), and the Syndicate may ask for its grants
            back.
            <Cite source={SOCIETY_SOURCES["jp-notes"]} />
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="listed" title="Getting listed on CAMsocs">
        <p>
          CAMsocs reads the SU's directory and the Proctors' list, so a registered society usually
          appears on its own after a while. To be listed sooner, or if you are not registered, use
          the <Link {...linkProps("/request?kind=add")}>“Add a missing society”</Link> form: the
          society's name, its website if it has one, an address to reply to and a short message. A
          person reads every request. Already listed? You can{" "}
          <Link href="/request">claim or correct the listing</Link>.
        </p>
      </ProseSection>
    </GuideArticle>
  )
}
