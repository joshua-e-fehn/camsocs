import type { Metadata } from "next"
import { LoginForm } from "@/components/organisms/login-form"
import { PublicHeader } from "@/components/organisms/public-header"

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in with a Cambridge email to see Cambridge-only events.",
  // Nothing here for a search engine.
  robots: { index: false },
}

/** A same-origin path, or undefined — never an absolute or protocol-relative URL. */
function safeNext(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  return /^\/(?![/\\])/.test(value) ? value : undefined
}

/**
 * `?cam=1` preselects the Cambridge email option (links from cam-only event
 * notices use it); `?next=/path` is where a Cambridge sign-in lands; `?error=`
 * is what a failed sign-in link reports back.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  return (
    <div className="flex min-h-svh flex-col">
      <PublicHeader />
      <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <LoginForm
            defaultMethod={params.cam === "1" ? "cam" : "google"}
            linkError={typeof params.error === "string" ? params.error : undefined}
            next={safeNext(params.next)}
          />
        </div>
      </main>
    </div>
  )
}
