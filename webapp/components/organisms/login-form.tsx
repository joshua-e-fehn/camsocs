"use client"

import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { MailCheckIcon, MailIcon, ShieldCheckIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSignInOptions } from "@/hooks/convex"
import { authClient } from "@/lib/auth-client"
import { isCamEmail, normaliseCamEmail } from "@/lib/cam-email"
import { cn } from "@/lib/utils"

export type SignInMethod = "cam" | "google"

/** Messages for the `?error=` Better Auth appends to the error callback. */
const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: "That sign-in link has expired or was already used. Request a new one.",
  new_user_signup_disabled: "Sign-up is closed for this address.",
}

/**
 * Two ways in (convex/betterAuth/auth.ts):
 *
 *  - **Cambridge email**: a one-time sign-in link to an `@cam.ac.uk` address.
 *    A verified session unlocks the Cambridge-only events. The server refuses
 *    any other address; checking here only saves a round trip.
 *  - **Admin**: Google. A session alone grants nothing — the private area is
 *    limited to the addresses in the Convex env var BROKER_EMAILS.
 *
 * Either option is greyed out with a reason when the deployment has not
 * switched it on (`auth.getSignInOptions`). Signing in creates the account on
 * first use, so there is no separate sign-up page.
 */
export function LoginForm({
  className,
  defaultMethod = "google",
  linkError,
  next,
  ...props
}: React.ComponentProps<"div"> & {
  defaultMethod?: SignInMethod
  /** `error` from a failed link, e.g. `INVALID_TOKEN`. */
  linkError?: string
  /** Where to land after a Cambridge sign-in; a same-origin path. */
  next?: string
}) {
  const [method, setMethod] = useState<SignInMethod>(defaultMethod)
  const options = useSignInOptions()
  const reduceMotion = useReducedMotion()

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl tracking-tight">Sign in</CardTitle>
          <CardDescription>
            {method === "cam"
              ? "Cambridge members see Cambridge-only events"
              : "For the camsocs administrator"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ToggleGroup
            type="single"
            variant="outline"
            value={method}
            onValueChange={(value) => value && setMethod(value as SignInMethod)}
            className="w-full"
            aria-label="Sign-in method"
          >
            <ToggleGroupItem value="cam" className="flex-1">
              <MailIcon />
              Cambridge email
            </ToggleGroupItem>
            <ToggleGroupItem value="google" className="flex-1">
              <ShieldCheckIcon />
              Admin
            </ToggleGroupItem>
          </ToggleGroup>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={method}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            >
              {method === "cam" ? (
                <CamEmailForm
                  enabled={options?.camEmail}
                  initialError={linkError ? (LINK_ERRORS[linkError] ?? "Sign-in failed.") : ""}
                  next={next}
                />
              ) : (
                <GoogleButton enabled={options?.google} />
              )}
            </motion.div>
          </AnimatePresence>
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        Browsing the directory needs no account. camsocs is unofficial and not affiliated with the
        University of Cambridge or Cambridge SU.
      </FieldDescription>
    </div>
  )
}

function CamEmailForm({
  enabled,
  initialError,
  next,
}: {
  /** undefined while loading. */
  enabled: boolean | undefined
  initialError: string
  next?: string
}) {
  const [email, setEmail] = useState("")
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState(initialError)
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const address = normaliseCamEmail(email)
  const invalid = touched && address !== "" && !isCamEmail(address)

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!isCamEmail(address)) {
      setError("Use your @cam.ac.uk address")
      return
    }
    setError("")
    setSending(true)
    try {
      const result = await authClient.signIn.magicLink({
        email: address,
        callbackURL: next ?? "/",
        errorCallbackURL: "/sign-in?cam=1",
      })
      if (result.error) setError(result.error.message ?? "The link could not be sent")
      else setSentTo(address)
    } catch {
      setError("Something went wrong. Try again.")
    } finally {
      setSending(false)
    }
  }

  if (enabled === false) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        Cambridge email sign-in is not switched on yet, so Cambridge-only events stay hidden for
        now.
      </p>
    )
  }

  if (sentTo) {
    return (
      <div className="flex flex-col items-center gap-3 text-center" role="status">
        <MailCheckIcon className="size-10 text-primary" aria-hidden="true" />
        <p className="font-medium">Check your inbox</p>
        <p className="text-sm text-muted-foreground">
          We sent a sign-in link to <span className="font-mono text-foreground">{sentTo}</span>. It
          works once and expires in 10 minutes.
        </p>
        <Button variant="ghost" size="sm" onClick={() => setSentTo(null)}>
          Use a different address
        </Button>
      </div>
    )
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={send} noValidate>
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor="cam-email">Cambridge email</FieldLabel>
        <Input
          id="cam-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="crsid@cam.ac.uk"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            if (error) setError("")
          }}
          onBlur={() => setTouched(true)}
          aria-invalid={invalid || undefined}
          disabled={enabled === undefined}
          required
        />
        {invalid ? (
          <FieldError>Only @cam.ac.uk addresses can sign in here</FieldError>
        ) : (
          <FieldDescription>We email you a one-time link. No password.</FieldDescription>
        )}
      </Field>
      <Button type="submit" disabled={sending || enabled === undefined}>
        {sending ? <Spinner /> : <MailIcon />}
        {sending ? "Sending…" : "Email me a sign-in link"}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function GoogleButton({ enabled }: { enabled: boolean | undefined }) {
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const signInWithGoogle = async () => {
    setError("")
    setLoading(true)
    try {
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/dashboard",
      })
      if (error) setError(error.message ?? "Sign in failed")
    } catch {
      setError("Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        type="button"
        disabled={loading || enabled !== true}
        onClick={signInWithGoogle}
      >
        {loading ? (
          <Spinner />
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
              fill="currentColor"
            />
          </svg>
        )}
        {loading ? "Redirecting…" : "Continue with Google"}
      </Button>
      <FieldDescription className="text-center">
        {enabled === false
          ? "Google sign-in is not configured on this deployment."
          : "Only listed broker accounts see the private area."}
      </FieldDescription>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
