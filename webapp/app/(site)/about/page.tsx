import { fetchQuery } from "convex/nextjs"
import { CircleDashedIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { ProseSection } from "@/components/molecules/prose-section"
import { StatusChip } from "@/components/molecules/source-line"
import { api } from "@/convex/_generated/api"
import { formatInstantDate, londonTime } from "@/lib/calendar"
import { BOT_USER_AGENT, CONTACT_EMAIL, CONTROLLER_NAME, DISCLAIMER } from "@/lib/site"
import { type KnownStatus, MISSING_DETAILS, STATUS_DETAILS } from "@/lib/source-line"

export const metadata: Metadata = {
  title: "About",
  description:
    "What camsocs is, who runs it, and how it collects data: public sources only, robots.txt respected, no Instagram scraping, every fact sourced.",
  alternates: { canonical: "/about" },
}

const SOURCES = [
  ["Cambridge SU society directory", "society names, categories, descriptions, contact links"],
  ["Proctors' register of societies", "which societies are registered this year"],
  ["Sport Cambridge club pages and Sports Club Guide", "sports clubs, Blues status, training"],
  ["Camdram", "theatre companies, shows and venues"],
  ["CUCBC", "college boat clubs and the rowing calendar"],
  ["College, JCR and MCR websites", "student bodies and their role contacts"],
  ["Societies' own websites and Linktree pages", "how to join, membership, contacts, socials"],
  ["Public calendar feeds (Google Calendar, Luma, iCal)", "events societies publish"],
  ["talks.cam", "talks, read by a parser only, never by an AI model"],
  ["Playwaze, SU What's On, the University events listing", "leagues and events"],
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
          <h1 className="text-3xl font-bold tracking-tight">About camsocs</h1>
          <p className="text-lg text-muted-foreground">
            A directory of Cambridge student societies and sports clubs, with an events calendar, in
            which every fact says where it came from.
          </p>
        </header>

        <ProseSection id="what" title="What it is">
          <p>
            Cambridge has well over a thousand student groups, listed in many places that rarely
            agree: the SU directory, the Proctors&apos; register, Sport Cambridge, Camdram, college
            and JCR/MCR sites, and each society&apos;s own pages. camsocs brings them together into
            one record per group, keeps the record current, and shows the source, date and status of
            every fact, so you can judge it for yourself.
          </p>
          <p>
            It is a personal project by <strong>{CONTROLLER_NAME}</strong>, a student at Cambridge.
          </p>
        </ProseSection>

        <ProseSection id="unofficial" title="Unofficial and independent">
          <p>
            <strong>{DISCLAIMER}</strong> It does not use the University&apos;s name, crest or logo
            as branding, and nothing here should be read as the University&apos;s or the SU&apos;s
            view. Societies registered with the Proctors or the SU are bodies independent of both.
          </p>
        </ProseSection>

        <ProseSection id="data" title="How we collect data">
          <ul>
            <li>
              <strong>Public sources only.</strong> An automated harvester reads publicly accessible
              pages and feeds. It identifies itself honestly as{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                {BOT_USER_AGENT}
              </code>
              .
            </li>
            <li>
              <strong>Societies&apos; own pages, at a polite pace.</strong> A society&apos;s
              website, the calendars and files it links to, and college society lists are read even
              where robots.txt asks crawlers to stay away; every other site&apos;s robots.txt is
              respected in full. The harvester makes one request at a time per site and honours
              crawl delays.
            </li>
            <li>
              <strong>Nothing behind a login.</strong> Pages that need a Raven or members&apos;
              login, or that refuse access, are never fetched. Email addresses a site has hidden or
              obscured are never decoded.
            </li>
            <li>
              <strong>No Instagram, Facebook or LinkedIn scraping.</strong> We store links to those
              profiles only. Instagram posts are read, if at all, only through Meta&apos;s official
              API for public professional accounts.
            </li>
            <li>
              <strong>AI extraction, checked.</strong> An AI language model, run by a third-party
              provider, reads free text from societies&apos; own pages to pull out facts such as how
              to join. A fact counts as <em>found</em> only when the model quotes the source word
              for word and the quote is checked; otherwise it is labelled <em>inferred</em>. Content
              from talks.cam and tbc.xyz is never given to an AI model.
            </li>
            <li>
              <strong>Mailing lists.</strong> Events announced on society mailing lists are shown
              only to visitors signed in with a verified @cam.ac.uk address, and the messages
              themselves are never published.
            </li>
            <li>
              <strong>Societies, not people.</strong> Public listings show organisations and the
              role addresses they publish (president@…, secretary@…). Personal student addresses are
              not shown.
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
            whose page, and how many independent sources agree). It is never the AI model&apos;s own
            estimate.
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
            your rights.
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
            ["#statuses", "What the labels mean"],
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
