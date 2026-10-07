import { fetchQuery } from "convex/nextjs"
import type { Metadata } from "next"
import Link from "next/link"
import { RequestForm } from "@/components/organisms/request-form"
import { api } from "@/convex/_generated/api"
import { isRequestKind } from "@/lib/listing-request"
import { CONTACT_EMAIL } from "@/lib/site"
import type { SearchParams } from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

export const metadata: Metadata = {
  title: "Claim, correct or remove a listing",
  description:
    "Societies can claim, correct or remove their camsocs listing, ask for a missing society to be added, or object to how their data is used.",
  alternates: { canonical: "/request" },
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function one(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function RequestPage({ searchParams }: Props) {
  const params = await searchParams
  const kindParam = one(params.kind)
  const slug = one(params.org)
  const page = slug && SLUG.test(slug) ? await fetchQuery(api.orgs.getBySlug, { slug }) : null
  const org = page ? { key: page.org.key, slug: page.org.slug, name: page.org.name } : null

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_20rem]">
      <div className="flex max-w-2xl flex-col gap-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">
            {org ? `About the listing for ${org.name}` : "Claim, correct or remove a listing"}
          </h1>
          <p className="text-muted-foreground">
            Societies decide what is said about them. Tell us what is wrong, missing or unwanted and
            a person will act on it.
          </p>
        </div>
        <RequestForm
          initialKind={isRequestKind(kindParam) ? kindParam : "claim"}
          initialOrg={org}
        />
      </div>

      <aside className="flex flex-col gap-6 text-sm">
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">How requests are handled</h2>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-muted-foreground">
            <li>Every request is read by a person, not acted on automatically.</li>
            <li>We reply within one month, usually much sooner.</li>
            <li>
              Corrections we confirm are marked owner-confirmed and take precedence over what we
              harvest.
            </li>
            <li>Removed listings stay removed: the harvester is told not to add them back.</li>
          </ul>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Your right to object</h2>
          <p className="text-muted-foreground">
            If personal data about you appears on camsocs, you can object to its use at any time (UK
            GDPR Article 21). Choose “Object to processing” above
            {CONTACT_EMAIL ? (
              <>
                , or email{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-4">
                  {CONTACT_EMAIL}
                </a>
              </>
            ) : null}
            . This form is also how to complain to us; you can complain to the Information
            Commission too. Details are in the{" "}
            <Link href="/privacy" className="underline underline-offset-4">
              privacy notice
            </Link>
            .
          </p>
        </div>
      </aside>
    </div>
  )
}
