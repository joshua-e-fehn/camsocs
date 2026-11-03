import { fetchQuery } from "convex/nextjs"
import { CircleDashedIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { InlineCode } from "@/components/molecules/inline-code"
import { ProseSection } from "@/components/molecules/prose-section"
import { StatusChip } from "@/components/molecules/source-line"
import { api } from "@/convex/_generated/api"
import { formatInstantDate, londonTime } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import {
  BOT_USER_AGENT,
  CONTACT_EMAIL,
  CONTROLLER_NAME,
  DISCLAIMER,
  SECURITY_CONTACT_EMAIL,
  SITE_NAME,
} from "@/lib/site"
import { type KnownStatus, MISSING_DETAILS, STATUS_DETAILS } from "@/lib/source-line"

export const metadata: Metadata = pageMetadata({
  title: "About",
  description:
    "What camsocs is, who runs it, and how it collects data: public sources only, polite crawling, no Instagram scraping, names replaced by roles, talks read by parsers alone, every fact sourced. How to have material taken down.",
  path: "/about",
})

const SOURCES = [
  ["Cambridge SU society directory", "society names, categories, descriptions, contact links"],
  ["Proctors' register of societies", "which societies are registered this year"],
  ["Sport Cambridge club pages and Sports Club Guide", "sports clubs, Blues status, training"],
  ["Camdram", "theatre companies, shows and venues"],
  ["CUCBC", "college boat clubs and the rowing calendar"],
  ["College, JCR and MCR websites", "student bodies and their role contacts"],
  ["Societies' own websites and Linktree pages", "how to join, membership, contacts, socials"],
  ["Public calendar feeds (Google Calendar, Luma, iCal)", "events societies publish"],
  [
    "talks.cam, through its public API",
    "academic talks, read by a parser only, never by an AI model",
  ],
  [
    "Department and institute websites (their calendar feeds and event pages)",
    "academic talks, read by parsers where robots.txt allows, never by an AI model",
  ],
  ["Playwaze and SU What's On", "leagues and events"],
  [
    "The University of Cambridge's public events programme (What's On, the Cambridge Festival, Open Cambridge)",
    "every public event it lists, with its images, read with the University's permission",
  ],
  [
    "Instagram, only through Meta's official Business Discovery API",
    "event posts of societies' public professional accounts, never scraped",
  ],
  ["The University's term-dates page", "Full Term dates, for week numbers"],
] as const

/** When the pipeline last finished a harvest, or null when unknown. */
async function lastHarvest(): Promise<number | null> {
  try {
    return (await fetchQuery(api.runs.lastHarvest, {}))?.finishedAt ?? null
  } catch {
    return null
  }
}

export default async function AboutPage() {
  const harvestedAt = await lastHarvest()

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_18rem]">
      <div className="flex max-w-3xl flex-col gap-10">
        <header className="flex flex-col gap-3">
          <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
            About camsocs
          </h1>
          <p className="text-lg text-muted-foreground">
            Cambridge student societies and sports clubs, their events, and the public academic
            talks across the University’s departments, with every fact saying where it came from.
          </p>
        </header>

        <ProseSection id="what" title="What it is">
          <p>
            Cambridge has well over a thousand student groups, listed in many places that rarely
            agree: the SU directory, the Proctors’ register, Sport Cambridge, Camdram, college and
            JCR/MCR sites, and each society’s own pages. camsocs brings them together into one
            record per group, keeps the record current, and shows the source, date and status of
            every fact, so you can judge it for yourself.
          </p>
          <p>
            It is a personal project by <strong>{CONTROLLER_NAME}</strong>, a student at Cambridge.
          </p>
        </ProseSection>

        <ProseSection id="unofficial" title="Unofficial and independent">
          <p>
            <strong>{DISCLAIMER}</strong> It does not use the University’s name, crest or logo as
            branding, and nothing here should be read as the University’s or the SU’s view.
            Societies registered with the Proctors or the SU are bodies independent of both.
          </p>
        </ProseSection>

        <ProseSection id="data" title="How we collect data">
          <ul>
            <li>
              <strong>Public sources only.</strong> An automated harvester reads publicly accessible
              pages and feeds. It identifies itself honestly as{" "}
              <InlineCode>{BOT_USER_AGENT}</InlineCode>.
            </li>
            <li>
              <strong>robots.txt, with two exceptions.</strong> The harvester follows robots.txt on
              every site except the pages societies publish about themselves: their own websites and
              Linktree pages, the public Google calendars they link, files on their SU listing, and
              college, JCR and MCR society lists. Those are read, also by the AI model, even where
              robots.txt or an AI opt-out asks otherwise, because they exist to tell students about
              the society. The other exception is the University of Cambridge’s public events
              programme (What’s On, the Cambridge Festival and Open Cambridge, and their event
              images): University Information Services, which runs the events service, and the
              Office of External Affairs and Communications, which runs the programme, gave
              permission on 2 November 2026 for it to be read and for the AI model to read its text.
              Permission to read the programme is not an endorsement: camsocs remains unofficial and
              is not run by or for the University. The rest of that site keeps its robots.txt. Crawl
              delays always apply, and the harvester makes one request at a time per site.
            </li>
            <li>
              <strong>Nothing behind a login.</strong> Pages that need a Raven or members’ login, or
              that refuse access, are never fetched. Email addresses a site has hidden or obscured
              are never decoded.
            </li>
            <li>
              <strong>No Instagram, Facebook or LinkedIn scraping.</strong> We store links to those
              profiles only. Instagram posts are read, if at all, only through Meta’s official API
              for public professional accounts.
            </li>
            <li>
              <strong>AI extraction, checked.</strong> An AI language model, one of OpenAI’s,
              reached through the operator’s own ChatGPT subscription rather than OpenAI’s API
              service (the <Link href="/privacy#sharing">privacy notice</Link> says what that
              means), reads free text from societies’ own pages to pull out facts such as how to
              join, and the University’s public events listings (with the permission above) to keep
              private individuals’ names and notices out of them. A fact counts as <em>found</em>{" "}
              only when the model quotes the source word for word and the quote is checked;
              otherwise it is labelled <em>inferred</em>. Content from talks.cam, departments’ talk
              listings and tbc.xyz is never given to an AI model.
            </li>
            <li>
              <strong>Mailing lists.</strong> Events announced on society mailing lists are shown
              only to visitors signed in with a verified @cam.ac.uk address, and the messages
              themselves are never published.
            </li>
            <li>
              <strong>Societies, not people.</strong> Public listings show organisations and the
              role addresses they publish (president@…, secretary@…). Personal student addresses are
              not shown. Where a description names a committee member, performer or other student,
              the name is replaced by their role (“contact our President”) before it is published.
              Speakers announced for public talks keep their names.
            </li>
          </ul>
          <h3>Sources</h3>
          <ul>
            {SOURCES.map(([source, what]) => (
              <li key={source}>
                <strong>{source}</strong>: {what}
              </li>
            ))}
          </ul>
        </ProseSection>

        <ProseSection id="talks" title="Talks">
          <p>
            The Talks pages list public academic talks: seminars, lectures, workshops and
            conferences that departments, institutes and lecture series open to anyone. They are
            separate from society events, and are collected differently.
          </p>
          <ul>
            <li>
              <strong>Two kinds of source.</strong> talks.cam is read through its public API, at
              most one request every ten seconds. Departments’ own websites are read through the
              calendar feeds and event pages they publish, only where their robots.txt allows it;
              the society exception above never applies to them. Nothing behind a login is read.
            </li>
            <li>
              <strong>Parsers only, no AI.</strong> Every talk is read by fixed code that picks out
              the title, speakers, time and place. No language model reads talks.cam or a
              department’s pages, and none writes or rewrites a talk. Our robots.txt asks AI
              crawlers to keep off the talk pages and calendar feeds, as talks.cam’s own does.
            </li>
            <li>
              <strong>Speakers as published.</strong> A talk’s speakers and their affiliations are
              shown as the organiser listed them, because a speaker is the point of a public talk.
              Titles and abstracts are the organisers’ own words.
            </li>
            <li>
              <strong>One source per talk.</strong> Each talk links to the page it was read from and
              says when. A talk listed in two places is shown once; a talk its source no longer
              lists disappears, and talks are deleted 30 days after they took place.
            </li>
          </ul>
          <p>
            To correct or remove a talk, or your name on one,{" "}
            {CONTACT_EMAIL ? (
              <>
                email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the talk’s link
              </>
            ) : (
              <>
                use the <Link href="/request?kind=object">request form</Link> with the talk’s link
              </>
            )}
            . The organiser’s own listing is the place to change it for good: what it says is what
            we show at the next read.
          </p>
        </ProseSection>

        <ProseSection id="statuses" title="What the labels mean">
          <p>Under every fact is a line saying where it came from and how sure we are.</p>
          <dl className="flex flex-col gap-2.5">
            {(Object.keys(STATUS_DETAILS) as KnownStatus[]).map((status) => (
              <div key={status} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt>
                  <StatusChip status={status} />
                </dt>
                <dd>{STATUS_DETAILS[status].description}</dd>
              </div>
            ))}
            {(["not_published", "not_attempted"] as const).map((reason) => (
              <div key={reason} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <dt className="inline-flex items-center gap-1 text-xs">
                  <CircleDashedIcon aria-hidden className="size-3.5" />
                  {MISSING_DETAILS[reason].label}
                </dt>
                <dd>{MISSING_DETAILS[reason].detail}</dd>
              </div>
            ))}
          </dl>
          <p>
            The percentage is a confidence computed by fixed rules (how the value was read, from
            whose page, and how many independent sources agree). It is never the AI model’s own
            estimate.
          </p>
        </ProseSection>

        <ProseSection id="copyright" title="Copyright and takedown">
          <p>
            Descriptions, logos and event images on {SITE_NAME} are copied from the public pages
            listed above, so that each listing can show them beside their source. They remain the
            work of whoever made them. If you hold the rights in something shown here, or act for
            whoever does, and want it taken down or credited differently, email{" "}
            {CONTACT_EMAIL ? (
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            ) : (
              <>
                us through the <Link href="/request?kind=object">request form</Link>
              </>
            )}
            . You do not need to be the society concerned.
          </p>
          <p>Please include:</p>
          <ul>
            <li>the link to the page on {SITE_NAME} and what on it you mean;</li>
            <li>where the original is, if you can say;</li>
            <li>that you own the rights, or on whose behalf you write;</li>
            <li>what you would like us to do: remove it, credit it differently or link to you.</li>
          </ul>
          <p>
            We act promptly and tell you what we did. For a society’s listing or an event, we aim to
            take the material down within two working days of a clear request, while we look into
            it, and we record the removal so that the harvester does not bring it back (an event’s
            image goes with the event). A talk is shown as its organiser publishes it, so for a talk
            we ask the organiser to change the listing at its source, and ours follows. If the
            request is about personal data rather than copyright, such as your name or address, the{" "}
            <Link href="/privacy#rights">privacy notice</Link> explains your rights.
          </p>
        </ProseSection>

        <ProseSection id="contact" title="Corrections, removal and contact">
          <p>
            Societies decide what is said about them. To claim, correct or remove a listing, or to
            object to how data about you is used, use the <Link href="/request">request form</Link>
            {CONTACT_EMAIL ? (
              <>
                {" "}
                or email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              </>
            ) : null}
            . A person reads every request. See the <Link href="/privacy">privacy notice</Link> for
            your rights, its <Link href="/privacy#cookies">cookies section</Link> for the visit
            statistics we collect only if you allow them, and the{" "}
            <Link href="/terms">terms of use</Link> for what you can rely on.
          </p>
          <h3 id="security">Security</h3>
          <p>
            To report a security problem, or personal data from {SITE_NAME} where it should not be,
            email <a href={`mailto:${SECURITY_CONTACT_EMAIL}`}>{SECURITY_CONTACT_EMAIL}</a>. Please
            give us a chance to fix it before telling anyone else, and do not access more data than
            you need to show the problem. The address is also in{" "}
            <a href="/.well-known/security.txt">security.txt</a>.
          </p>
        </ProseSection>
      </div>

      <aside className="flex flex-col gap-4 lg:pt-16">
        <div className="flex flex-col gap-1 rounded-xl border p-5">
          <h2 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Last harvest
          </h2>
          {harvestedAt ? (
            <p className="font-mono text-sm">
              {formatInstantDate(harvestedAt)}, {londonTime(harvestedAt)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No harvest recorded yet.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Each listing also shows when its own facts were last read.
          </p>
        </div>
        <nav
          aria-label="On this page"
          className="flex flex-col gap-1 rounded-xl border p-5 text-sm"
        >
          <h2 className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            On this page
          </h2>
          {[
            ["#what", "What it is"],
            ["#unofficial", "Unofficial and independent"],
            ["#data", "How we collect data"],
            ["#talks", "Talks"],
            ["#statuses", "What the labels mean"],
            ["#copyright", "Copyright and takedown"],
            ["#contact", "Corrections and contact"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="text-muted-foreground hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
      </aside>
    </div>
  )
}
