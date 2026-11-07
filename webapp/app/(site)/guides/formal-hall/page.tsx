import type { Metadata } from "next"
import Link from "next/link"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { GuideArticle } from "@/components/organisms/guide-article"
import { formatDate } from "@/lib/calendar"
import { COLLEGE_INFO, COLLEGES_PATH, FORMAL_ANCHOR, FORMALS_CHECKED_ON } from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"
import { formalGuideSources, FORMAL_SOURCES as S } from "@/lib/formal-guide"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"

/**
 * Formal hall (ENG-112): how a student goes to another college's formal and
 * what each college publishes about it. The text is the Cambridge Tracker's
 * research of 8 Oct 2026, re-checked against every cited page on 7 Nov
 * (lib/colleges.ts); the table is built from lib/data/colleges.json, so a
 * college's row and its own page never disagree.
 */

const GUIDE = guide("formal-hall")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

const TOC = [
  ["#routes", "Getting into another college’s formal"],
  ["#before", "Before you pay"],
  ["#feasts", "Feasts and invitation-only dinners"],
  ["#colleges", "College by college"],
] as const

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"

export default function FormalHallGuide() {
  return (
    <GuideArticle
      guide={GUIDE}
      sources={formalGuideSources()}
      toc={TOC}
      lede={
        <>
          Formal hall is a college’s served dinner in its hall, on set evenings in term. Members
          book through their college; a student from another college usually goes as a member’s
          guest or on a swap run by a common room or society. Here is how that works, and what all{" "}
          {COLLEGE_INFO.length} colleges publish about guests, gowns and booking.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Every college’s rules</h2>
          <p className="text-muted-foreground">
            Each college’s own page on CAMsocs has its formal hall rules, its JCR, MCR and
            societies.
          </p>
          <Link
            href={COLLEGES_PATH}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            All colleges compared
          </Link>
        </div>
      }
    >
      <ProseSection id="routes" title="Getting into another college’s formal">
        <p>
          The usual way in is a member of that college booking you as their guest, or an organised
          swap through a common room or society. Colleges differ: Downing describes formal hall as
          an occasion for its students to bring in students from other colleges as guests
          <Cite source={S.downing} />, while Darwin lets only its current members book and the
          member who booked must come with their guests
          <Cite source={S.darwin} />. A University card or a Raven login does not by itself let you
          book at another college.
        </p>
        <h3>1. Ask a member to host you</h3>
        <p>
          The host books your place with their college account. Where asked, give your full name and
          dietary needs in advance, and arrive with your host. Check the rules before taking over
          someone else’s ticket: at Hughes Hall bookings cannot be transferred, guests cannot attend
          without their host, and only the Conference Office may reassign a ticket, if asked by
          14:30 the day before
          <Cite source={S.hughes} />.
        </p>
        <h3>2. Use your JCR’s or MCR’s formal swaps</h3>
        <p>
          The JCR and MCR are a college’s undergraduate and postgraduate common rooms. Many run
          swaps with other colleges: you sign up through your own common room’s announcement, which
          gives the places and how to pay. Christ’s MCR, for example, emails members when a swap is
          coming up and shares out the usually limited places so that everyone can go to at least
          one
          <Cite source={S.christsMcr} />. Lucy Cavendish MCR lists mcr-comms@lucy.cam.ac.uk as its
          contact
          <Cite source={S.lucyMcr} />. Your college’s page on{" "}
          <Link href={COLLEGES_PATH}>/colleges</Link> links its JCR and MCR.
        </p>
        <h3>3. Follow a society that organises formals</h3>
        <p>
          The{" "}
          <Link href="/societies/formal-hall-networking-society">
            Formal Hall Networking Society
          </Link>{" "}
          describes regular formal swaps across colleges and has a mailing list
          <Cite source={S.fhn} />. Check each event’s eligibility and ticket release: a listing does
          not guarantee places this term.
        </p>
        <h3>4. For a group, ask for the group route</h3>
        <p>
          A group may need the college’s permission, a minimum share of the college’s own members,
          or a special night. The rules differ a lot between colleges (see the table below); do not
          split a group across several ordinary guest bookings without asking.
        </p>
      </ProseSection>

      <ProseSection id="before" title="Before you pay for a guest place">
        <p>Ask your host or the organiser to confirm:</p>
        <ul>
          <li>the date, the kind of dinner and the current price;</li>
          <li>how many guests a member may bring, and whether the host must come with you;</li>
          <li>when booking and cancellation close;</li>
          <li>your name and dietary needs, if the college asks for them;</li>
          <li>what to wear, and whether guests wear gowns;</li>
          <li>when to arrive, and the rules on bringing wine.</li>
        </ul>
        <p>
          Prices, guest limits and deadlines given for an earlier academic year below need checking
          for the dinner you want.
        </p>
      </ProseSection>

      <ProseSection id="feasts" title="Feasts and invitation-only dinners">
        <p>
          An ordinary guest ticket is not an invitation to a feast. Churchill’s undergraduate
          handbook treats ordinary guests at formal hall separately from invitations to its major
          feasts
          <Cite source={S.churchill} />. Some dinners are by invitation only, such as King’s 1441
          Foundation Dinner for members of the college’s donor group and their guests
          <Cite source={S.kings} />; that tells you nothing about King’s student formals.
        </p>
      </ProseSection>

      <section
        id="colleges"
        aria-labelledby="colleges-title"
        className="flex scroll-mt-20 flex-col gap-3"
      >
        <h2 id="colleges-title" className="font-serif text-2xl font-normal tracking-[-0.01em]">
          College by college
        </h2>
        <p className="text-sm text-muted-foreground">
          What each college publishes for a visitor from another college, checked{" "}
          {formatDate(FORMALS_CHECKED_ON)}. “Host” means the published route is a member booking
          you; it does not mean every other way is ruled out. Each college links its full rules and
          sources.
        </p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <caption className="sr-only">Formal hall rules for visitors, by college</caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className={TH}>
                  College
                </th>
                <th scope="col" className={TH}>
                  How a visitor gets in
                </th>
                <th scope="col" className={TH}>
                  Main rule
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {COLLEGE_INFO.map((college) => (
                <tr key={college.key}>
                  <th scope="row" className="px-3 py-2.5 text-left align-top font-medium">
                    <Link
                      href={`${collegeHubPath(college)}#${FORMAL_ANCHOR}`}
                      className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                    >
                      <CollegeCrest crest={college.crest} size={28} decorative />
                      {college.shortName}
                    </Link>
                  </th>
                  <td className="px-3 py-2.5 align-top">{college.formal.bookingSummary}</td>
                  <td className="px-3 py-2.5 align-top text-muted-foreground">
                    {college.formal.rulesSummary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </GuideArticle>
  )
}
