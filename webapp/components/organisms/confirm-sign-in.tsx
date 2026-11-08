"use client"

import { LockKeyholeIcon } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { currentCampus } from "@/lib/campus"
import { verifyPathFromFragment } from "@/lib/sign-in-link"

const product = currentCampus().brand.name

/**
 * The page the emailed sign-in link opens (lib/sign-in-link.ts). The token is in
 * the URL fragment; it is spent only when the person presses Sign in, so a mail
 * scanner that opens the link (Exchange Safe Links) cannot use it up.
 *
 * The fragment is read once and removed from the address bar, so it is not left
 * in history or copied along with the page address.
 */
export function ConfirmSignIn() {
  // undefined while reading the fragment; null when it holds no sign-in link.
  const [target, setTarget] = useState<string | null | undefined>(undefined)
  const [going, setGoing] = useState(false)

  useEffect(() => {
    setTarget(verifyPathFromFragment(window.location.hash))
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search)
    }
  }, [])

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <LockKeyholeIcon aria-hidden className="size-5" />
            Finish signing in
          </span>
        </CardTitle>
        <CardDescription>
          {target === null
            ? "This page needs the link from your sign-in email."
            : `Press the button to sign in to ${product}. The link works once.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {target === null ? (
          <Button asChild variant="outline">
            <Link href="/sign-in?cam=1">Request a sign-in link</Link>
          </Button>
        ) : (
          <Button
            disabled={!target || going}
            onClick={() => {
              if (!target) return
              setGoing(true)
              window.location.assign(target)
            }}
          >
            {going ? "Signing in…" : "Sign in"}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
