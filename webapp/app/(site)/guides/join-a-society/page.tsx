import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { CategoryLinks } from "@/components/molecules/category-links"
import { Cite, EditorNote } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { GuideArticle } from "@/components/organisms/guide-article"
import { api } from "@/convex/_generated/api"
import { linkProps } from "@/lib/crawl-traps"
import { CATEGORIES_PATH, categoryHubPath } from "@/lib/directory-hubs"
import { guide, guidesInReview } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { loadTermClock } from "@/lib/term-dates"
import { startsIn, TERM_NAMES, weekOfTerm } from "@/lib/term-week"

const GUIDE = guide("join-a-society")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  // A draft asks not to be indexed (lib/guides.ts REVIEW_NOTES).
  ...(guidesInReview() ? { robots: { index: false, follow: true } } : {}),
}

/** The directory's counts (the same cached read as /categories); null when
 * they cannot be read, and the page says less. */
async function loadFacets() {
  try {
    return await publicQuery(api.orgs.facets, {})
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

const TOC = [
  ["#short", "In short"],
  ["#what", "What a society is here"],
  ["#fairs", "The fairs"],
  ["#later", "Joining later in the year"],
  ["#sport", "Sport"],
  ["#lists", "Mailing lists and socials"],
  ["#cost", "What it costs"],
  ["#rights", "What a society owes you"],
  ["#help", "If something goes wrong"],
  ["#postgrads", "Postgraduates"],
  ["#tips", "From experience"],
] as const

export default async function JoinASocietyGuide() {
  const [facets, { clock }] = await Promise.all([loadFacets(), loadTermClock()])
  const sport = facets?.categories.sport
  const outdoors = facets?.categories.outdoors
  const beginners = facets?.beginnerFriendly.true

  return (
    <GuideArticle
      guide={GUIDE}
      toc={TOC}
      lede={
        <>
          Where Cambridge students find their societies and clubs, how to sign up, and what to do if
          you missed the fairs. Written for new and returning students, undergraduate and
          postgraduate.
        </>
      }
      aside={
        <>
          {clock && (
            <div className="flex flex-col gap-1 rounded-xl border p-5">
              <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                Where we are now
              </h2>
              <p className="font-serif text-lg leading-snug">
                {clock.kind === "term"
                  ? `${TERM_NAMES[clock.term]}, ${weekOfTerm(clock.week)}`
                  : clock.next
                    ? `${TERM_NAMES[clock.next.term]} Full Term starts ${startsIn(clock.next.inDays)}`
                    : "Vacation"}
              </p>
              <p className="text-muted-foreground">
                Many clubs take new members throughout the year.{" "}
                <Link href="/term-dates" className="text-foreground underline underline-offset-4">
                  Term dates
                </Link>
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2 rounded-xl border p-5">
            <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              Browse on CAMsocs
            </h2>
            <Link {...linkProps("/societies")} className="underline underline-offset-4">
              {facets ? `All ${facets.total} societies and clubs` : "All societies and clubs"}
            </Link>
            <Link href={CATEGORIES_PATH} className="underline underline-offset-4">
              By category
            </Link>
            <Link {...linkProps("/events")} className="underline underline-offset-4">
              What's on this week
            </Link>
          </div>
        </>
      }
    >
      <ProseSection id="short" title="In short">
        <ul>
          <li>
            The easiest way in is the fairs in the first days of Michaelmas: one for sport, one for
            University-wide societies and one in each college.
          </li>
          <li>
            Signing up at a stall usually puts you on a mailing list. You are not committing to
            anything; go to a few first meetings and keep what you enjoy.
          </li>
          <li>
            Missed the fairs? Search the directories, write to the society directly, and look out
            for taster sessions. Many clubs take new members all year.
          </li>
          <li>Costs vary by society. Some are free; others sell a membership.</li>
        </ul>
      </ProseSection>

      <ProseSection id="what" title="What a society is here">
        <p>
          In Cambridge, a “society” simply means a club.
          <Cite id="su-what-is" /> There are three main layers:
        </p>
        <ul>
          <li>
            <strong>University-wide societies</strong>, open to students of any college. Cambridge
            SU says over 500 are registered with it, sorted into seven groups such as Cultural &
            Faith, Creative & Media and Academic Life.
            <Cite id="su-what-is" /> Many are also registered with the Junior Proctor, who keeps a
            public list.
            <Cite id="proctors-list" />
          </li>
          <li>
            <strong>University sports clubs</strong>, run with the Sports Service rather than the
            SU. It lists more than 75 of them.
            <Cite id="sport-clubs" />
          </li>
          <li>
            <strong>College societies and teams</strong>, run and funded by your college, often
            including sport and music.
            <Cite id="su-what-is" />
            <Cite id="pembroke-fairs" /> Each college keeps its own list, sometimes only in a
            members' area.
            <Cite id="lucy-societies" />
          </li>
        </ul>
        <EditorNote id="join-counts" />
        {facets && (
          <>
            <p>
              CAMsocs brings these lists together:{" "}
              <strong>{facets.total} societies and clubs</strong> at the last count, in sixteen
              categories. Each category has its own page.
            </p>
            <CategoryLinks counts={facets.categories} />
          </>
        )}
      </ProseSection>

      <ProseSection id="fairs" title="The fairs at the start of the year">
        <p>
          There are usually three, close together at the start of Michaelmas Term.
          <Cite id="pembroke-fairs" />
        </p>
        <h3>The Sports Fair</h3>
        <p>
          The Sports Service holds a fair where you can meet the University's clubs, ask questions
          and sign up on the spot; its clubs page gives the date as 5 October, the Monday before the
          2026 SU fair.
          <Cite id="sport-clubs" /> Its club guide adds a tour of the Sports Centre and a chance to
          meet the Sports Service's staff.
          <Cite id="sport-guide" /> Pembroke's guide for freshers puts it on the Monday of Freshers'
          Week, from midday to 5pm at the Sports Centre.
          <Cite id="pembroke-fairs" />
        </p>
        <EditorNote id="join-sports-fair-time" />
        <h3>The SU Freshers' Fair</h3>
        <p>
          Cambridge SU's fair is the big one. In 2026 it ran on Tuesday 6 and Wednesday 7 October,
          10am to 4pm, on Parker's Piece, with 300+ clubs and societies and some local and national
          organisations.
          <Cite id="su-fair-2026" /> Those were the first two days of Full Term.
          <Cite id="term-dates" />
        </p>
        <ul>
          <li>
            Entry is free and needs no ticket, but your Camcard is scanned at the entrance. It is
            open to every Cambridge student, new or returning.
            <Cite id="su-fair" />
          </li>
          <li>
            Societies are spread over three marquees and outdoor stalls, beside an avenue of brands
            handing out free samples and a showcase of student performances.
            <Cite id="su-fair" />
          </li>
          <li>
            An access hour, with limited entry, no music and stallholders staying behind their
            stalls, ran from 3 to 4pm on the Tuesday and 10 to 11am on the Wednesday.
            <Cite id="su-fair" />
          </li>
          <li>
            Questions about the fair go to activities@cambridgesu.co.uk.
            <Cite id="su-fair" />
          </li>
        </ul>
        <EditorNote id="join-fair-year" />
        <h3>Your college's fair</h3>
        <p>
          Colleges hold their own fairs for college societies and teams.
          <Cite id="pembroke-fairs" /> At Christ's, for example, the college's student union runs
          it, normally in your first few days.
          <Cite id="christs-fair" />
        </p>
        <h3>How to use a fair</h3>
        <ul>
          <li>
            You sign up at each society's stall, usually by giving your email for its mailing list.
            <Cite id="christs-fair" />
            <Cite id="su-what-is" />
          </li>
          <li>
            The SU's own advice is to sign up to plenty, try a few and keep a couple.
            <Cite id="su-what-is" />
          </li>
          <li>
            Not every society keeps its website up to date, so ask at the stall or the first
            meeting.
            <Cite id="christs-fair" />
          </li>
        </ul>
        <EditorNote id="join-tip-week0" />
      </ProseSection>

      <ProseSection id="later" title="Joining later in the year">
        <p>If you missed the fairs, there are other ways in.</p>
        <ul>
          <li>
            <strong>Search the SU's directory.</strong> Find a Society lists the societies
            registered with the SU, with a search box and a category filter. A profile shows the
            society's contacts and links, and a Join button once you log in.
            <Cite id="su-find" />
          </li>
          <li>
            <strong>Search CAMsocs.</strong> The <Link {...linkProps("/societies")}>directory</Link>{" "}
            puts the SU's list together with sports clubs, college societies and others, and{" "}
            <Link {...linkProps("/events")}>Events</Link> shows what they have on this week.
          </li>
          <li>
            <strong>Write to the society.</strong> The Sports Service advises contacting its clubs
            directly, by email or social media; many of them take new members all year.
            <Cite id="sport-clubs" />
          </li>
          <li>
            <strong>Go to the Refreshers' Fair.</strong> The SU has held a smaller fair in January.
            In 2024 it filled three floors of the University Centre on Mill Lane, 10am to 4pm, with
            about 70 societies, an access hour and a quiet welfare area.
            <Cite id="su-refreshers-2024" />
          </li>
        </ul>
        <EditorNote id="join-refreshers" />
      </ProseSection>

      <ProseSection id="sport" title="Sport">
        <ul>
          <li>
            <strong>University clubs.</strong> Over half welcome complete beginners. Contact a club
            directly, ideally before you arrive, as many train before term starts. Most hold taster
            sessions at the start of term; competitive clubs also hold trials.
            <Cite id="sport-clubs" /> Over 4,500 students belong to one, and many clubs play weekly
            BUCS fixtures on Wednesday afternoons.
            <Cite id="sport-guide" />
          </li>
          <li>
            <strong>Blues.</strong> A club's first team is known as the Blues. Representing
            Cambridge in a Varsity match, in more than 60 sports and mostly in February and March,
            can earn a Blue or Half Blue, by each sport's criteria.
            <Cite id="sport-varsity" />
          </li>
          <li>
            <strong>Who can play.</strong> You need to be a fully registered member of a college and
            the University on a recognised course. The University says it does not support limiting
            anyone's place by matriculation date or course.
            <Cite id="sport-eligibility" />
          </li>
          <li>
            <strong>Just for fun.</strong> Give It a Go runs free, beginner-friendly weekly sessions
            with no commitment to come every week. You book through the CamUniSport app or website
            with its free Pay As You Train membership, up to 7 days ahead.
            <Cite id="sport-give-it-a-go" />
          </li>
          <li>
            <strong>College sport.</strong> Over 4,000 students play each year. College leagues are
            open to every level, with fixtures usually at weekends, and Cuppers is the inter-college
            knockout cup. Ask your college captain or JCR/MCR sports officer, or write to
            collegesport@sport.cam.ac.uk.
            <Cite id="sport-college" />
          </li>
          <li>
            <strong>Accessible sport.</strong> The Sports Service links to an adult disability
            multi-sport club and a page on accessible sport and facilities.
            <Cite id="sport-clubs" />
          </li>
          <li>
            Questions go to support@sport.cam.ac.uk.
            <Cite id="sport-clubs" />
          </li>
        </ul>
        {facets && (
          <p>
            On CAMsocs:{" "}
            <Link href={categoryHubPath("sport")}>
              {sport ?? 0} sports {sport === 1 ? "listing" : "listings"}
            </Link>{" "}
            and{" "}
            <Link href={categoryHubPath("outdoors")}>
              {outdoors ?? 0} outdoors {outdoors === 1 ? "listing" : "listings"}
            </Link>
            {beginners
              ? `; ${beginners} ${beginners === 1 ? "listing says" : "listings say"} beginners are welcome`
              : ""}
            .
          </p>
        )}
      </ProseSection>

      <ProseSection id="lists" title="Mailing lists and social media">
        <ul>
          <li>
            Many student societies have their own mailing lists. Lists on the University's list
            service have addresses ending @lists.cam.ac.uk; you sign in with Raven to search for
            lists, join them, and leave them again from your account page.
            <Cite id="uis-lists" />
          </li>
          <li>
            Some lists let you subscribe yourself at lists.cam.ac.uk; for others you email the
            list's managers. You do not need a Cambridge address to receive a list's messages.
            <Cite id="uis-subscribe" />
          </li>
          <li>
            Cambridge SU posts as @YourCambridgeSU on Instagram, Facebook and TikTok, and the Sports
            Service as @camunisport; it suggests following clubs' own Instagram pages too.
            <Cite id="su-freshers" />
            <Cite id="sport-clubs" />
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="cost" title="What it costs">
        <p>
          There is no standard fee: each society sets its own, and some charge nothing. Some sell
          membership through an outside ticketing or payment site linked from their SU profile;
          others ask you only to join a free group or mailing list.
          <Cite id="su-profile-paid-a" />
          <Cite id="su-profile-paid-b" />
          <Cite id="su-profile-free" /> A society's own page, or its stall, is the place to ask.
        </p>
      </ProseSection>

      <ProseSection id="rights" title="What a registered society owes you">
        <p>
          A society registered with Cambridge SU agrees, among other things, to the SU's terms
          <Cite id="su-terms" />:
        </p>
        <ul>
          <li>
            to let any student member of the University join, unless that would directly conflict
            with its legitimate aims;
          </li>
          <li>to act with due regard for its members' safety and wellbeing;</li>
          <li>to keep its finances open to its members' scrutiny;</li>
          <li>
            not to discriminate, unless that is both lawful and directly necessary for its
            legitimate aims, and not to engage in abusive, offensive, violent or criminal behaviour.
          </li>
        </ul>
        <p>
          Complaints about a registered society go through the SU's complaints procedure.
          <Cite id="su-terms" />
        </p>
        <EditorNote id="join-initiations" />
      </ProseSection>

      <ProseSection id="help" title="If something goes wrong">
        <ul>
          <li>
            <strong>If anyone is in immediate danger, call 999 first.</strong>
            <Cite id="su-safeguarding" />
          </li>
          <li>
            The SU's Student Advice Service gives free, confidential and impartial advice on any
            problem you might have as a student. The SU is on the 3rd floor of the University
            Centre, Mill Lane; its reception is open weekdays 9:30am to 5pm, and its phone number is
            0808 1641 222.
            <Cite id="su-advice" />
          </li>
          <li>
            Safeguarding concerns about SU activities go to safeguarding@cambridgesu.co.uk or the
            SU's incident form.
            <Cite id="su-safeguarding" />
          </li>
          <li>
            Harassment, bullying, discrimination or sexual misconduct can be reported anonymously,
            but the University cannot act on an anonymous report. For action, report formally to
            your college, the University or the police.
            <Cite id="anon-reporting" />
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="postgrads" title="Postgraduates">
        <p>
          The SU's fair is open to postgraduates as well as undergraduates.
          <Cite id="su-fair" />
        </p>
        <EditorNote id="join-postgrads" />
      </ProseSection>

      <ProseSection id="tips" title="From experience">
        <EditorNote id="join-tip-keeping" />
        <EditorNote id="join-published" />
      </ProseSection>
    </GuideArticle>
  )
}
