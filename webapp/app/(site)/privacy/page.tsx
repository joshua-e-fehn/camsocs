import type { Metadata } from "next"
import Link from "next/link"
import { ProseSection } from "@/components/molecules/prose-section"
import { formatDate } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import {
  CONTACT_EMAIL,
  CONTROLLER_NAME,
  ICO_REGISTRATION_NUMBER,
  PRIVACY_NOTICE_UPDATED,
  SITE_NAME,
} from "@/lib/site"

/** Inline code (storage names), styled as on the About page. */
const CODE = "rounded bg-muted px-1 font-mono text-xs text-foreground"

export const metadata: Metadata = pageMetadata({
  title: "Privacy notice",
  description:
    "How camsocs uses personal data under UK GDPR: who is responsible, what is collected and from where, why, for how long, and your rights, including the right to object.",
  path: "/privacy",
})

/**
 * The UK GDPR privacy notice (Arts 13 and 14) for the public site, the data
 * behind it and the private contact notes. Kept in step with
 * docs/compliance/ (record of processing, retention, LIA, DPIA-lite); change
 * those first, then this page and PRIVACY_NOTICE_UPDATED.
 *
 * The analytics wording (ENG-3, 2026-11-01) describes the PostHog design as it
 * ships with ENG-2 and ENG-4 to ENG-9: nothing loads before "Accept analytics",
 * the choice lives in `camsocs-consent` (lib/consent.ts) and "Cookie settings"
 * in the footer reopens it. Keep the three in step.
 */
export default function PrivacyPage() {
  const contact = CONTACT_EMAIL ? (
    <>
      the <Link href="/request?kind=object">request form</Link> or{" "}
      <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
    </>
  ) : (
    <>
      the <Link href="/request?kind=object">request form</Link>
    </>
  )

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
          Privacy notice
        </h1>
        <p className="text-muted-foreground">
          How {SITE_NAME} uses personal data, and your rights. Last updated{" "}
          <span className="font-mono">{formatDate(PRIVACY_NOTICE_UPDATED)}</span>.
        </p>
      </header>

      <ProseSection id="who" title="Who is responsible">
        <p>
          {SITE_NAME} is run by <strong>{CONTROLLER_NAME}</strong> as an individual. He is the
          controller of the personal data described here under the UK GDPR and the Data Protection
          Act 2018. {SITE_NAME} is not run by, and does not speak for, the University of Cambridge,
          its colleges or Cambridge SU.
        </p>
        <p>Contact for anything in this notice: {contact}.</p>
        {ICO_REGISTRATION_NUMBER && (
          <p>
            Registered with the Information Commission under number{" "}
            <span className="font-mono">{ICO_REGISTRATION_NUMBER}</span>.
          </p>
        )}
      </ProseSection>

      <ProseSection id="what" title="What we collect, and from where">
        <p>
          Most of {SITE_NAME} is about organisations, not people. Personal data comes in only in the
          ways below.
        </p>
        <h3>Role contact addresses (public)</h3>
        <p>
          Listings show the contact addresses societies publish for a role, such as
          president@society.org. Such an address can point to whoever holds the role. Addresses that
          name an individual student (a personal Cambridge CRSid address) are never shown in public
          listings.
        </p>
        <h3>Names in descriptions (replaced before publishing)</h3>
        <p>
          Descriptions copied from public pages sometimes name committee members, performers or
          other students. Before a description is published, such names are replaced by the person’s
          role or a neutral phrase, for example “contact our President”. The original wording is
          kept privately, with the record of where each fact came from, for as long as the listing
          exists. Speakers announced for public talks are shown by name, as the organiser published
          them.
        </p>
        <h3>Speakers at academic talks (public)</h3>
        <p>
          The Talks pages list public academic talks with their speakers’ names and affiliations, as
          the organiser published them on talks.cam or on a department’s own website. They are read
          by fixed parser code only: no AI model reads these listings or the names in them. A talk
          links to the page it was read from, disappears when that page no longer lists it, and is
          deleted 30 days after it took place. If you are named on a talk and want your name
          corrected or removed, write to us (see <a href="#rights">Your rights</a>) with the talk’s
          link; we will also point you to the organiser, whose listing we follow.
        </p>
        <h3>Committee members (private, never published)</h3>
        <p>
          Where a society names its committee on its own public pages, the operator may keep the
          names and roles in private notes, used to contact societies and to make introductions
          between them and possible partners. These notes are not public, are marked out of date
          after each year’s handover, and are deleted on the schedule below.
        </p>
        <h3>Society mailing lists</h3>
        <p>
          Messages sent to society mailing lists that the operator subscribes to are forwarded to{" "}
          {SITE_NAME} so that the events they announce can be listed. They contain the sender’s name
          and address. The messages are kept privately; only the events taken from them are shown,
          and only to visitors signed in with a verified @cam.ac.uk address.
        </p>
        <h3>When you contact us</h3>
        <p>
          If you use the request form, we keep your email address, any role you give and your
          message.
        </p>
        <h3>When you sign in</h3>
        <p>
          Signing in is optional. If you sign in with a @cam.ac.uk email link, we keep that address
          and a session record. The operator signs in with a Google account.
        </p>
        <h3>When you browse (analytics, only if you allow it)</h3>
        <p>
          Only if you choose “Accept analytics” (see <a href="#cookies">Cookies</a>), your browser
          sends PostHog, our analytics provider, a record of the pages you view and a few things you
          do on them: which society, event or talk page you opened (by its reference, never a talk’s
          title or speaker), how long a search was and how many results it found (never what you
          typed), when you subscribe to a calendar or follow a link off the site (the kind of link,
          not its address), and errors the page runs into. Each record carries the page address
          without anything after “?” or “#”, the page you came from, your browser, device type and
          screen size, and the random identifier in the analytics cookie.
        </p>
        <p>
          Your IP address is discarded and never stored. We record no session replays, clicks or
          mouse movements, never link the records to your name, email address or sign-in, and never
          track the sign-in page or the operator’s dashboard.
        </p>
        <p>
          Separately, and without storing anything in your browser, our servers report their own
          errors to PostHog (the page path, the kind of error and where in our code it happened;
          never your IP address, cookies or anything you sent) and count calendar-feed downloads and
          request-form submissions by kind. These reports and counts contain no personal data.
        </p>
        <h3>Sources</h3>
        <p>
          Apart from what you send us, and what your browser sends if you allow analytics, the data
          comes from publicly accessible sources: the Cambridge SU society directory, the Proctors’
          register, Sport Cambridge, Camdram, CUCBC, college and JCR/MCR websites, societies’ own
          websites, Linktree pages and public calendars, talks.cam, departments’ and institutes’
          public talk listings, and Playwaze; and from society mailing lists as described above. The
          full list and our collection rules are on the <Link href="/about#data">About page</Link>.
        </p>
      </ProseSection>

      <ProseSection id="why" title="Why we use it, and on what lawful basis">
        <ul>
          <li>
            <strong>Publishing the directory and calendar</strong> so students can find societies
            and their events: our legitimate interests, and those of students and societies (UK GDPR
            Article 6(1)(f)). We have weighed these against the interests of the people concerned,
            which is why public listings are limited to role addresses.
          </li>
          <li>
            <strong>Publishing academic talks with their speakers</strong>, so anyone can find
            public talks across the University: legitimate interests, the same that the organisers
            serve by publishing them. We show only what the organiser published, and nothing is
            inferred about the speakers.
          </li>
          <li>
            <strong>Private notes for contacting societies and making introductions</strong> between
            them and possible partners: legitimate interests. We do not send marketing email without
            the consent the law requires, and every message says how to opt out.
          </li>
          <li>
            <strong>Answering requests and complaints</strong>: legitimate interests, and our legal
            obligation to respond to data protection requests (Article 6(1)(c)).
          </li>
          <li>
            <strong>Sign-in and the Cambridge-only tier</strong>: legitimate interests, to show
            events shared on Cambridge mailing lists only to Cambridge members.
          </li>
          <li>
            <strong>Site analytics in your browser</strong>, to see in aggregate which pages and
            features are used and where the site fails, so we can improve it: your consent (Article
            6(1)(a)), given with “Accept analytics” and withdrawn at any time under “Cookie
            settings”. The law on storing information on your device (PECR) also requires consent
            for it, so nothing is stored or read for analytics without it.
          </li>
          <li>
            <strong>Error reports and anonymous counts from our servers</strong>, to keep the site
            working and see which features are used: our legitimate interests. They hold no IP
            addresses, cookies or anything you typed, and nothing is stored on your device for them.
          </li>
        </ul>
        <p>
          We do not infer anyone’s religion, politics, ethnicity, health or sexuality, and we make
          no automated decisions about people. Analytics is not used to profile or identify anyone,
          and signed-in visitors are never identified in it.
        </p>
      </ProseSection>

      <ProseSection id="sharing" title="Who else handles it">
        <p>
          We do not sell or rent personal data, and we do not hand contact lists to sponsors or
          other organisations: introductions are made by passing messages on, not by sharing
          addresses. Service providers process data on our behalf:
        </p>
        <ul>
          <li>Vercel (website hosting) and Convex (database and server code);</li>
          <li>Resend (sign-in emails and receiving forwarded mailing-list messages);</li>
          <li>Google (sign-in for the operator only);</li>
          <li>
            OpenAI, through a relay server the operator rents, which provides the AI model that
            extracts facts from public pages and mailing-list messages and replaces names in
            descriptions with roles. Talk listings are never sent to it.
          </li>
          <li>
            PostHog (analytics and error reports), on its EU Cloud: the data is stored in the EU, in
            Frankfurt. PostHog, Inc. acts as our processor under its data processing agreement,
            which we accepted on 1 November 2026. It also receives the harvester’s run statistics
            and the AI model’s usage figures (counts, durations, token numbers), which contain no
            personal data and none of the text read.
          </li>
        </ul>
        <p>
          Some of these providers process data outside the UK, in particular in the United States.
          Where they do, we rely on the safeguards each provider offers for transfers from the UK.
          PostHog, a US company, stores analytics in the EU; where it or its subprocessors handle
          the data elsewhere, its agreement applies the UK’s International Data Transfer Addendum to
          the EU standard contractual clauses and the UK Extension to the EU–US Data Privacy
          Framework.
        </p>
      </ProseSection>

      <ProseSection id="retention" title="How long we keep it">
        <ul>
          <li>
            Public listings: while the organisation is active. Listings are refreshed every academic
            year; one with no sign of activity for two years is archived and then removed.
          </li>
          <li>
            Private committee notes: until the end of the academic year in which they were collected
            (30 June), then deleted within 30 days unless the person has agreed to more.
          </li>
          <li>
            Mailing-list messages: their text and attachments are deleted 30 days after we have read
            them for events, and the rest of the message after 90 days (we keep only its date, its
            list and which events it gave, without sender or subject).
          </li>
          <li>Events: deleted a year after they took place.</li>
          <li>Academic talks: deleted 30 days after they took place.</li>
          <li>Notes of our own contacts with a society: three years after the last contact.</li>
          <li>
            Requests and complaints: two years after they are closed (a request we turned down: 90
            days). If you ask us to remove a listing, a detail or an address, we keep a minimal
            record — the listing’s key, the field, or only a one-way hash of the address — so it is
            not added back.
          </li>
          <li>Sign-in accounts: until you ask us to delete them, or after two years unused.</li>
          <li>Copies of public web pages read by the harvester: 90 days.</li>
          <li>
            Analytics and error records in PostHog: up to one year (the retention of PostHog’s plan
            we use), then deleted by PostHog.
          </li>
          <li>
            Your cookie choice: 180 days in your browser, then we ask again. The analytics cookie:
            180 days, or until you withdraw consent.
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="rights" title="Your rights">
        <p>You have the right to:</p>
        <ul>
          <li>
            <strong>object</strong> to our use of personal data about you (Article 21). We will stop
            unless we have compelling grounds that override your interests; an objection to direct
            marketing is always upheld;
          </li>
          <li>ask for a copy of personal data we hold about you;</li>
          <li>have it corrected, or deleted;</li>
          <li>ask us to restrict its use while a question is resolved;</li>
          <li>
            <strong>withdraw your consent</strong> to analytics at any time, as easily as you gave
            it, under “Cookie settings” at the foot of any page (Article 7(3));
          </li>
          <li>complain to us, and to the Information Commission.</li>
        </ul>
        <p>
          To use any of these rights, use {contact}. We reply within one month. We acknowledge a
          complaint within 30 days and tell you the outcome.
        </p>
        <p>
          You can also complain to the UK regulator, the Information Commission (formerly the
          Information Commissioner’s Office), at{" "}
          <a href="https://ico.org.uk/make-a-complaint/" rel="noopener noreferrer">
            ico.org.uk
          </a>
          .
        </p>
      </ProseSection>

      <ProseSection id="cookies" title="Cookies">
        <p>
          {SITE_NAME} stores something on your device only where it is needed for what you asked
          for, or where you have agreed to it:
        </p>
        <ul>
          <li>
            <strong>Your cookie choice.</strong> When you choose “Accept analytics” or “Reject”,
            your browser keeps the choice and its date in local storage under the name{" "}
            <code className={CODE}>camsocs-consent</code>, so we do not ask on every page. It is
            strictly necessary, holds nothing else and is never sent to us. After 180 days we ask
            again.
          </li>
          <li>
            <strong>Analytics, only if you accept.</strong> If you choose “Accept analytics”,
            PostHog’s analytics code loads from our own address and sets a first-party cookie and
            local storage entries whose names begin <code className={CODE}>ph_</code>. They hold a
            random identifier, so that visits can be counted without knowing who you are; the cookie
            lasts 180 days. If you choose “Reject”, or choose nothing, the analytics code is not
            loaded at all and nothing is stored or read for analytics.
          </li>
          <li>
            <strong>Signing in.</strong> If you sign in, we set the cookies needed to keep you
            signed in; they are strictly necessary for the service you asked for.
          </li>
          <li>
            <strong>Recent searches.</strong> The search box remembers your last five searches in
            your browser’s local storage so you can repeat them. They stay on your device.
          </li>
        </ul>
        <p>
          You can change your mind at any time: choose <strong>“Cookie settings”</strong> at the
          foot of any page and choose again. Choosing “Reject” stops analytics at once and deletes
          the <code className={CODE}>ph_</code> cookie and storage from your browser; records
          already sent carry only that random identifier, so nothing then links them to you, and
          they are deleted with the rest. None of this is used for advertising or to follow you to
          other websites.
        </p>
      </ProseSection>

      <ProseSection id="changes" title="Changes to this notice">
        <p>
          If we change how we use personal data, we update this page and its date. Societies whose
          role addresses we list are told directly about the listing and how to object.
        </p>
      </ProseSection>
    </div>
  )
}
