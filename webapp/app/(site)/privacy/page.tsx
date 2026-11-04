import type { Metadata } from "next"
import Link from "next/link"
import { InlineCode } from "@/components/molecules/inline-code"
import { ProseSection } from "@/components/molecules/prose-section"
import { formatDate } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import {
  CONTACT_EMAIL,
  CONTROLLER_NAME,
  ICO_REGISTRATION_NUMBER,
  PRIVACY_NOTICE_UPDATED,
  SECURITY_CONTACT_EMAIL,
  SITE_NAME,
} from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Privacy notice",
  description:
    "How CAMsocs uses personal data under UK GDPR: who is responsible, what is collected and from where, why, for how long, and your rights, including the right to object.",
  path: "/privacy",
})

/**
 * The UK GDPR privacy notice (Arts 13 and 14) for the public site, the data
 * behind it and the private contact notes. Kept in step with
 * docs/compliance/ (record of processing, retention, LIA, DPIA-lite); change
 * those first, then this page and PRIVACY_NOTICE_UPDATED.
 *
 * The analytics wording (ENG-3) describes the PostHog design as it ships: the
 * consent banner (ENG-2, #6) and the browser client with its `/relay` hop
 * (ENG-4, #9) merge together with this page on 1 November 2026, after the
 * harvester and LLM telemetry (ENG-8, ENG-9) already on main. Nothing loads
 * before "Accept analytics", the choice lives in `camsocs-consent`
 * (lib/consent.ts), "Cookie settings" in the footer reopens it, and the
 * client's `before_send` (lib/analytics-client.ts) and relay (lib/relay.ts)
 * send no more than "When you browse" lists. Its list of things you do names
 * every event of the taxonomy (ENG-5, lib/analytics-events.ts,
 * docs/analytics.md) with exactly the properties each carries: an event or a
 * property added there is added here first. Keep them in step; if this page
 * ships on a later date than its partners, move PRIVACY_NOTICE_UPDATED to it.
 *
 * ENG-34 (3 November 2026, the launch audit): the sources name the
 * University's events programme and Meta Business Discovery; the VPS host is
 * named; the AI model is described as it is reached today, a ChatGPT
 * subscription through cliproxy with no API data processing agreement.
 * Training is off since 3 November 2026, and Joshua decided to stay on the
 * subscription rather than move to the API (ENG-41): change "The AI model" if
 * that changes.
 *
 * ENG-44 (4 November 2026, each provider's terms read from its own pages,
 * record-of-processing "International transfers"): Convex and Vercel's
 * functions are in the US (both deployments `aws-us-east-1`, `iad1`), the VPS
 * is in Frankfurt by its address's geolocation (⚠ Joshua to confirm in
 * hPanel, then drop "as far as we can tell"). OpenAI's Europe terms give a UK
 * resident's subscription to OpenAI OpCo, LLC and an EEA resident's to OpenAI
 * Ireland; which one holds Joshua's account is ⚠ not yet confirmed (its
 * country and invoices), so the notice names both and says so. Once he has,
 * name the one, here and in dpia-lite R-4 alike. The consumer terms give us
 * no transfer safeguard: the notice says OpenAI's own SCCs are its
 * arrangement, not one with us, and does not claim a safeguard we lack.
 *
 * The Art 14 notice to societies (J7, ENG-32) is not sent yet, so
 * "If we have not written to you" and "Changes" say "we are writing"; put
 * them back in the present tense once it has gone out. "If we have not
 * written to you" is the published side of the Art 14(5)(e) assessment
 * (dpia-lite §4), and the faith, political, LGBTQ+, ethnic, national, health
 * and disability society officers sentences
 * follow the Art 9 decision (dpia-lite §5, ENG-42, 3 November 2026): such
 * names are kept under Art 9(2)(e), only as the society's own pages list its
 * officers, never published or passed to a partner without the officer's
 * agreement; if that changes (the names dropped, another source), change
 * "Committee members" and the lawful basis here too. The regulator is the
 * Information Commission (the ICO until 30 September 2026): each mention
 * gives the old name too, as the Art 14 notice (lib/broker/outreach.ts)
 * should.
 */
export default function PrivacyPage() {
  const contact = CONTACT_EMAIL ? (
    <>
      the{" "}
      <Link href="/request?kind=object" rel="nofollow">
        request form
      </Link>{" "}
      or <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
    </>
  ) : (
    <>
      the{" "}
      <Link href="/request?kind=object" rel="nofollow">
        request form
      </Link>
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
        <p>
          To report a security problem, or personal data from {SITE_NAME} where it should not be,
          email <a href={`mailto:${SECURITY_CONTACT_EMAIL}`}>{SECURITY_CONTACT_EMAIL}</a> (also
          given in <a href="/.well-known/security.txt">security.txt</a>).
        </p>
        {ICO_REGISTRATION_NUMBER && (
          <p>
            Registered with the Information Commission (formerly the Information Commissioner’s
            Office, ICO) under number <span className="font-mono">{ICO_REGISTRATION_NUMBER}</span>.
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
          them, and so are speakers named in the titles of the University’s public events programme.
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
          after each year’s handover, and are deleted on the schedule below. Some societies are
          about a faith, a political view, LGBTQ+ identity, or an ethnic, national, health or
          disability identity, so being named as one of their officers can itself say something
          about a person. We keep such names only as the society’s own pages list its officers, on
          the basis that the officers made them public there (UK GDPR Article 9(2)(e)). They are
          never published, nothing is inferred from them, they are not passed to a partner without
          the officer’s agreement, and you can object or ask for yours to be deleted and kept out at
          any time (see <a href="#rights">Your rights</a>).
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
          message. When you send it, Vercel, our host, checks that the request comes from a person’s
          browser rather than an automated script (Vercel BotID): a script from our own address
          reads technical signals from your browser for that one check. What you wrote is not part
          of it.
        </p>
        <h3>When you sign in</h3>
        <p>
          Signing in is optional. If you sign in with a @cam.ac.uk email link, we keep that address
          and a session record. The operator signs in with a Google account.
        </p>
        <h3>When you browse (analytics, only if you allow it)</h3>
        <p>
          Only if you choose “Accept analytics” (see <a href="#cookies">Cookies</a>), your browser
          sends PostHog, our analytics provider, a record of the pages you view and of these things
          you do on them, each with only the details named. A “reference” is our short code for a
          listing: for a society or department, its name in lower case with hyphens (such as{" "}
          <InlineCode>org-chess</InlineCode>); for an event or talk, a code of letters and digits
          that does not contain its title or speaker:
        </p>
        <ul>
          <li>
            opening a society’s page (<InlineCode>society_viewed</InlineCode>): its reference and
            its categories;
          </li>
          <li>
            opening an event (<InlineCode>event_viewed</InlineCode>): its reference, its organisers’
            references, and whether they run it or take part in it;
          </li>
          <li>
            opening a talk (<InlineCode>talk_viewed</InlineCode>): its reference and its
            department’s reference, never its title or speaker;
          </li>
          <li>
            searching (<InlineCode>search_performed</InlineCode>, and{" "}
            <InlineCode>search_zero_results</InlineCode> when nothing matched): where you searched
            (societies, events, talks or the search box), how long the search was and how many
            results it found, never what you typed;
          </li>
          <li>
            choosing a calendar link (<InlineCode>calendar_subscribe_clicked</InlineCode>): whether
            it is for one event, one talk or the talks feed, and that item’s or department’s
            reference;
          </li>
          <li>
            following a link off the site (<InlineCode>outbound_link_clicked</InlineCode>): its kind
            (website, social media, source or other) and, from a society’s or event’s page, the
            society’s reference, never the link’s address;
          </li>
          <li>
            sending the request form (<InlineCode>listing_request_submitted</InlineCode>): only its
            kind, never the listing, your address or what you wrote;
          </li>
          <li>
            finishing a Cambridge sign-in (<InlineCode>sign_in_completed</InlineCode>): only that it
            was by email link, never who;
          </li>
          <li>errors the page runs into: the error’s message and where in our code it happened.</li>
        </ul>
        <p>
          Each record carries the page address without anything after “?” or “#”, the page you came
          from, your browser and operating system (by name and version, not the full identification
          string your browser sends), its language and time zone, your device type and screen size,
          and random identifiers: one stored in your browser for analytics, and others that change
          with each visit, browser tab and page view.
        </p>
        <p>
          Your browser sends these records to our own site, which passes them on to PostHog without
          your IP address, cookies or browser identification string, so PostHog sees our server, not
          you; it derives no location and keeps no IP address. Like any visit to the site, your IP
          address appears briefly in our hosting provider’s request logs. We record no session
          replays, clicks or mouse movements, never link the records to your name, email address or
          account, never identify you when you are signed in, and never track the sign-in page or
          the operator’s dashboard.
        </p>
        <p>
          Separately, and without storing anything in or reading anything from your browser, our
          servers report their own errors to PostHog (the page path, the error and its message, and
          where in our code it happened; never your IP address, cookies or anything you sent) and
          count calendar-feed downloads (which feed, and which event or talk) and request-form
          submissions (only the kind of request). None of these carries your IP address, browser
          details, cookies or anything you typed, and they are built to contain no personal data. A
          request-form count is sent the moment we store your request, so we could match the two by
          time; it adds nothing to what the stored request already says.
        </p>
        <h3>Sources</h3>
        <p>
          Apart from what you send us, and what your browser sends if you allow analytics, the data
          comes from publicly accessible sources: the Cambridge SU society directory, the Proctors’
          register, Sport Cambridge, Camdram, CUCBC, college and JCR/MCR websites, societies’ own
          websites, Linktree pages and public calendars, talks.cam, departments’ and institutes’
          public talk listings, Playwaze and SU What’s On; the University of Cambridge’s public
          events programme (What’s On, the Cambridge Festival and Open Cambridge), read with the
          permission of the University offices that run it; public posts of professional Instagram
          accounts, read only through Meta’s official Business Discovery API (part of the Instagram
          API), never by scraping; and society mailing lists as described above. The full list and
          our collection rules are on the <Link href="/about#data">About page</Link>.
        </p>
        <h3>If we have not written to you</h3>
        <p>
          We are writing to every society we list about its listing, at the role address it
          publishes (by 9 November 2026). We do not write to each speaker on a talk or event, each
          person named in the title of a University event, or each sender of a mailing-list message:
          there are thousands of them, for most we have no address, and finding one would mean
          collecting more about them than the listing needs. This notice is how we tell them
          instead. To protect them, we show only what the organiser published and link to it, infer
          nothing about anyone, delete talks 30 days and events a year after they took place, keep
          mailing-list messages private and delete them on the schedule below, and remove a name for
          good when its owner asks.
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
            them and possible partners: legitimate interests. For officers of faith, political,
            LGBTQ+ and ethnic, national, health or disability societies, also that the officers made
            their names public on the society’s own pages (Article 9(2)(e)). We do not send
            marketing email without the consent the law requires, and every message says how to opt
            out.
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
            working and see which features are used: our legitimate interests. We never attach IP
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
          <li>
            Vercel (website hosting; its server code runs in Washington, D.C., in the United States)
            and Convex (database and server code, in Northern Virginia, in the United States);
          </li>
          <li>
            Hostinger, from which the operator rents the virtual server that runs the harvester on a
            schedule (in Frankfurt, Germany, as far as we can tell from its network address). It
            holds the harvester’s working copies: the public pages it reads, staged listings and
            talks, and mailing-list messages being processed, for up to 90 days (list mail for 30
            days), and it runs the relay to the AI model described below;
          </li>
          <li>Resend (sign-in emails and receiving forwarded mailing-list messages);</li>
          <li>Google (sign-in for the operator only);</li>
          <li>
            PostHog (analytics and error reports), on its EU Cloud: the data is stored in the EU, in
            Frankfurt. PostHog, Inc. acts as our processor (see its{" "}
            <a href="https://posthog.com/dpa" rel="noopener noreferrer">
              data processing agreement
            </a>
            ). It also receives the harvester’s run statistics and the AI model’s usage figures
            (counts, durations, token numbers), which contain no personal data and none of the text
            read.
          </li>
        </ul>
        <h3>The AI model</h3>
        <p>
          The AI model that extracts facts from public pages, the University of Cambridge’s public
          events programme (with its permission) and mailing-list messages, and replaces names in
          descriptions with roles, is one of OpenAI’s. We do not use OpenAI’s API service for it:
          the operator reaches the models through his own ChatGPT subscription, by way of a relay
          (cliproxy) on our server at Hostinger. The text is therefore sent to OpenAI under the
          subscription’s own terms. We have no data processing agreement with OpenAI, so it is not a
          provider acting only on our instructions like those above. Under OpenAI’s terms for
          Europe, a subscription held by someone living in the UK is with OpenAI OpCo, LLC in the
          United States, and one held by someone living in the European Economic Area with OpenAI
          Ireland Ltd; we have not yet confirmed which of the two holds the operator’s subscription,
          and will say so here once we have. Either way OpenAI processes the text outside the UK,
          including in the United States. OpenAI’s privacy policy says it relies on adequacy
          decisions and on the standard contractual clauses with the UK’s addendum for those
          transfers, but that is OpenAI’s own arrangement: the subscription’s terms give us no
          safeguard of our own for sending the text to OpenAI, and OpenAI is not certified under the
          UK Extension to the EU–US Data Privacy Framework. The account setting that lets OpenAI use
          what it is sent to train its models is switched off (since 3 November 2026), and we send
          it as little as we can: talk listings from talks.cam and departments never, and
          mailing-list messages only after quoted replies, signatures, addresses and phone numbers
          are cut out.
        </p>
        <p>
          Some of these providers process data outside the UK, in particular in the United States.
          Where they do, we rely on the safeguards in each provider’s data processing agreement,
          part of its terms: the EU standard contractual clauses with the UK’s International Data
          Transfer Addendum (Vercel, Convex, Resend, and Hostinger for anything it handles outside
          Europe); Vercel and Resend are also certified under the UK Extension to the EU–US Data
          Privacy Framework. OpenAI is the exception (see above). PostHog, a US company, stores
          analytics in the EU; where it or its subprocessors handle the data elsewhere, its data
          processing agreement provides for the UK’s International Data Transfer Addendum to the EU
          standard contractual clauses and the UK Extension to the EU–US Data Privacy Framework. Ask
          us (see <a href="#rights">Your rights</a>) for a copy of the safeguards for any provider.
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
            Backups of our database: one a night, kept on our own server for 14 nights and readable
            only by its administrator. Something deleted from the site leaves the backups as the
            older ones are deleted; if we ever have to restore one, we delete again whatever had
            been deleted since it was made.
          </li>
          <li>
            Analytics and error records in PostHog: up to one year, the retention of the PostHog
            plan we use; each July we check that nothing older is kept.
          </li>
          <li>
            Your cookie choice: 180 days in your browser, then we ask again. The two analytics
            cookies: 180 days from your last visit. The analytics entries in local storage: until
            you withdraw consent, your choice runs out after 180 days (they are deleted on your next
            visit) or you clear your browser’s data for this site; in session storage: until you
            close the tab.
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
            receive the data your browser sent with your consent in a portable, machine-readable
            form (Article 20);
          </li>
          <li>
            <strong>withdraw your consent</strong> to analytics at any time, as easily as you gave
            it, under “Cookie settings” at the foot of any page (Article 7(3)). Withdrawing does not
            make the processing before it unlawful;
          </li>
          <li>
            complain to us, and to the Information Commission (formerly the Information
            Commissioner’s Office, ICO).
          </li>
        </ul>
        <p>
          To use any of these rights, use {contact}. We reply within one month. We acknowledge a
          complaint within 30 days and tell you the outcome. Analytics records carry only random
          identifiers, not your name, so we can find yours only if you tell us the identifier stored
          in your browser (Article 11).
        </p>
        <p>
          You can also complain to the UK regulator, the Information Commission (formerly the
          Information Commissioner’s Office, ICO), at{" "}
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
            <InlineCode>camsocs-consent</InlineCode>, so we do not ask on every page. It is strictly
            necessary, holds nothing else and is never sent to us. After 180 days we ask again.
          </li>
          <li>
            <strong>Analytics, only if you accept.</strong> If you choose “Accept analytics”,
            PostHog’s analytics code loads from our own address and stores two first-party cookies (
            <InlineCode>ph_&lt;key&gt;_posthog</InlineCode>, and{" "}
            <InlineCode>ph_&lt;key&gt;_posthog_cpm</InlineCode>, which records which entries the
            first one holds; <InlineCode>&lt;key&gt;</InlineCode> is our PostHog project’s public
            key), local storage entries and session storage entries whose names begin{" "}
            <InlineCode>ph_</InlineCode> or <InlineCode>__ph_</InlineCode>. They hold random
            identifiers for your browser, the current visit and the current tab, so that visits can
            be counted without knowing who you are, PostHog’s own record of your choice, and
            settings for the current visit. The cookies last 180 days from your last visit, the
            session storage entries until you close the tab, and the local storage entries until you
            withdraw consent, your choice runs out (they are deleted on your next visit after that)
            or you clear your browser’s data for this site. If you choose “Reject”, or choose
            nothing, the analytics code is not loaded at all and nothing is stored or read for
            analytics.
          </li>
          <li>
            <strong>Signing in.</strong> If you sign in, we set the cookies needed to keep you
            signed in; they are strictly necessary for the service you asked for.
          </li>
          <li>
            <strong>Sending the request form.</strong> The bot check above runs only when you send
            the form. It may store security cookies whose names begin <InlineCode>KP_</InlineCode>.
            They are strictly necessary to keep the form open to people and closed to spam.
          </li>
          <li>
            <strong>Recent searches.</strong> The search box remembers your last five searches in
            your browser’s local storage so you can repeat them. They stay on your device.
          </li>
          <li>
            <strong>An old theme setting.</strong> Earlier versions of the site stored a light or
            dark choice in local storage under <InlineCode>theme</InlineCode>, which the site no
            longer reads or writes; you can delete it.
          </li>
        </ul>
        <p>
          You can change your mind at any time: choose <strong>“Cookie settings”</strong> at the
          foot of any page and choose again. Choosing “Reject” stops analytics at once and deletes
          the <InlineCode>ph_</InlineCode> and <InlineCode>__ph_</InlineCode> cookies and storage
          from your browser. Records already sent stay in PostHog under the deleted random
          identifiers: we can no longer tell which of them came from your browser, and they are kept
          no longer than the rest (see <a href="#retention">How long we keep it</a>). None of this
          is used for advertising or to follow you to other websites.
        </p>
      </ProseSection>

      <ProseSection id="changes" title="Changes to this notice">
        <p>
          If we change how we use personal data, we update this page and its date. We are writing to
          the societies whose role addresses we list, to tell them about the listing and how to
          object.
        </p>
      </ProseSection>
    </div>
  )
}
