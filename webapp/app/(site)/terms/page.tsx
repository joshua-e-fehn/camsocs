import type { Metadata } from "next"
import Link from "next/link"
import { ProseSection } from "@/components/molecules/prose-section"
import { formatDate } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import { CONTACT_EMAIL, CONTROLLER_NAME, DISCLAIMER, SITE_NAME, TERMS_UPDATED } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Terms of use",
  description:
    "Terms for using camsocs: an unofficial project, information as found and not guaranteed, events run by others, and the law of England and Wales.",
  path: "/terms",
})

/**
 * The short terms of use and accuracy disclaimer (ENG-34, the launch audit
 * of 2 November 2026). Personal data is the privacy notice's business, and
 * copyright takedown is /about#copyright; this page links to both rather than
 * repeating them. A change in substance moves TERMS_UPDATED.
 */
export default function TermsPage() {
  const email = CONTACT_EMAIL ? (
    <>
      {" "}
      or email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
    </>
  ) : null

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
          Terms of use
        </h1>
        <p className="text-muted-foreground">
          What you can rely on when you use {SITE_NAME}, and what we ask of you. Last updated{" "}
          <span className="font-mono">{formatDate(TERMS_UPDATED)}</span>.
        </p>
      </header>

      <ProseSection id="unofficial" title="An unofficial project">
        <p>
          <strong>{DISCLAIMER}</strong> It is a free personal project run by {CONTROLLER_NAME}, a
          student at Cambridge. Nothing on it is the view of the University, a college, the SU or a
          society, unless a page quotes them as its source.
        </p>
        <p>
          By using {SITE_NAME} you accept these terms. How we use personal data is in the{" "}
          <Link href="/privacy">privacy notice</Link>.
        </p>
      </ProseSection>

      <ProseSection id="accuracy" title="Accuracy is not guaranteed">
        <p>
          Everything here is collected from public pages, mostly automatically, and shown as we
          found it, with its source, the date we read it and how sure we are. Committees change,
          events move, pages go out of date, and our harvester or the AI model can misread them. We
          do not guarantee that anything on {SITE_NAME} is accurate, complete or current.
        </p>
        <p>
          Before you rely on a detail, especially a time, a place, a price or who may come, check it
          with the organiser or on the source page each fact links to.
        </p>
      </ProseSection>

      <ProseSection id="others" title="Events, talks and societies run by others">
        <p>
          The societies, clubs, events and talks listed here are run by others, not by {SITE_NAME}.
          We do not organise, check or endorse them, and listing one is not a recommendation.
          Whether to join or go, and what happens there, is between you and the organiser. Links to
          other sites are there for convenience; we are not responsible for what those sites say or
          do.
        </p>
      </ProseSection>

      <ProseSection id="liability" title="Our liability">
        <p>
          {SITE_NAME} is provided free and as it is. As far as the law allows, we are not liable for
          any loss that comes from using the site, from relying on what it says, or from an event,
          talk, society or club listed on it.
        </p>
        <p>
          Nothing in these terms excludes or limits a liability that the law does not allow to be
          excluded or limited, such as for death or personal injury caused by negligence, or for
          fraud, and nothing here affects your rights as a consumer.
        </p>
      </ProseSection>

      <ProseSection id="use" title="Using the site">
        <ul>
          <li>
            Use the request form and our email address for real requests about a listing, a talk or
            your own data. Do not send false information, or someone else’s details without their
            agreement, and do not use them for advertising.
          </li>
          <li>
            Do not try to get around the site’s security or reach anything that is not public. To
            report a security problem, see <Link href="/about#security">Security</Link>.
          </li>
          <li>
            Automated agents may read what our robots.txt allows, at a pace that does not burden the
            site.
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="correct" title="Correcting or removing something">
        <ul>
          <li>
            A society can claim, correct or remove its listing, and anyone can ask for a missing
            society to be added, through the <Link href="/request">request form</Link>
            {email}. A person reads every request.
          </li>
          <li>
            If you hold the rights in a description, logo or image shown here, see{" "}
            <Link href="/about#copyright">Copyright and takedown</Link>.
          </li>
          <li>
            If the request is about you, such as your name on a talk, see{" "}
            <Link href="/privacy#rights">your rights</Link> in the privacy notice.
          </li>
        </ul>
      </ProseSection>

      <ProseSection id="changes" title="Changes to these terms">
        <p>
          If we change these terms, we update this page and its date. The version on this page when
          you use the site is the one that applies.
        </p>
      </ProseSection>

      <ProseSection id="law" title="Governing law">
        <p>
          These terms are governed by the law of England and Wales, and the courts of England and
          Wales have jurisdiction over any dispute about them. If you live in Scotland or Northern
          Ireland, you may also bring proceedings in the courts where you live.
        </p>
      </ProseSection>
    </div>
  )
}
