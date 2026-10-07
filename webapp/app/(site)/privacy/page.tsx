import type { Metadata } from "next"
import Link from "next/link"
import { ProseSection } from "@/components/molecules/prose-section"
import { formatDate } from "@/lib/calendar"
import {
  CONTACT_EMAIL,
  CONTROLLER_NAME,
  ICO_REGISTRATION_NUMBER,
  PRIVACY_NOTICE_UPDATED,
  SITE_NAME,
} from "@/lib/site"

export const metadata: Metadata = {
  title: "Privacy notice",
  description:
    "How camsocs uses personal data under UK GDPR: who is responsible, what is collected and from where, why, for how long, and your rights, including the right to object.",
  alternates: { canonical: "/privacy" },
}

/**
 * The UK GDPR privacy notice (Arts 13 and 14) for the public site, the data
 * behind it and the private contact notes. Kept in step with
 * docs/compliance/ (record of processing, retention, LIA, DPIA-lite); change
 * those first, then this page and PRIVACY_NOTICE_UPDATED.
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
        <h1 className="text-3xl font-bold tracking-tight">Privacy notice</h1>
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
        <h3>Committee members (private, never published)</h3>
        <p>
          Where a society names its committee on its own public pages, the operator may keep the
          names and roles in private notes, used to contact societies and to make introductions
          between them and possible partners. These notes are not public, are marked out of date
          after each year&apos;s handover, and are deleted on the schedule below.
        </p>
        <h3>Society mailing lists</h3>
        <p>
          Messages sent to society mailing lists that the operator subscribes to are forwarded to{" "}
          {SITE_NAME} so that the events they announce can be listed. They contain the sender&apos;s
          name and address. The messages are kept privately; only the events taken from them are
          shown, and only to visitors signed in with a verified @cam.ac.uk address.
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
        <h3>Sources</h3>
        <p>
          Apart from what you send us, the data comes from publicly accessible sources: the
          Cambridge SU society directory, the Proctors&apos; register, Sport Cambridge, Camdram,
          CUCBC, college and JCR/MCR websites, societies&apos; own websites, Linktree pages and
          public calendars, talks.cam, Playwaze and the University&apos;s events listing; and from
          society mailing lists as described above. The full list and our collection rules are on
          the <Link href="/about#data">About page</Link>.
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
        </ul>
        <p>
          We do not infer anyone&apos;s religion, politics, ethnicity, health or sexuality, and we
          make no automated decisions about people.
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
            extracts facts from public pages and mailing-list messages.
          </li>
        </ul>
        <p>
          Some of these providers process data outside the UK, in particular in the United States.
          Where they do, we rely on the safeguards each provider offers for transfers from the UK.
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
            Mailing-list messages: 90 days, then deleted. Events taken from them are deleted a year
            after they took place.
          </li>
          <li>
            Requests and complaints: two years after they are closed. If you ask us to remove a
            listing, we keep a minimal record so it is not added back.
          </li>
          <li>Sign-in accounts: until you ask us to delete them, or after two years unused.</li>
          <li>Copies of public web pages read by the harvester: 90 days.</li>
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
          <li>complain to us, and to the Information Commission.</li>
        </ul>
        <p>
          To use any of these rights, use {contact}. We reply within one month. We acknowledge a
          complaint within 30 days and tell you the outcome.
        </p>
        <p>
          You can also complain to the UK regulator, the Information Commission (formerly the
          Information Commissioner&apos;s Office), at{" "}
          <a href="https://ico.org.uk/make-a-complaint/" rel="noopener noreferrer">
            ico.org.uk
          </a>
          .
        </p>
      </ProseSection>

      <ProseSection id="cookies" title="Cookies">
        <p>
          {SITE_NAME} uses no analytics, advertising or tracking cookies. If you sign in, we set the
          cookies needed to keep you signed in; they are strictly necessary for the service you
          asked for. If you switch between light and dark mode, your browser remembers the choice
          locally. Neither is used to follow you elsewhere.
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
