import type { Metadata } from "next"
import { ConfirmSignIn } from "@/components/organisms/confirm-sign-in"
import { PublicHeader } from "@/components/organisms/public-header"

export const metadata: Metadata = {
  title: "Finish signing in",
  robots: { index: false },
  referrer: "no-referrer",
}

/** Where the emailed sign-in link lands (lib/sign-in-link.ts explains why). */
export default function ConfirmSignInPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <PublicHeader />
      <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <ConfirmSignIn />
        </div>
      </main>
    </div>
  )
}
