"use client"

import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { LockKeyholeIcon, MailCheckIcon, MailIcon, ShieldCheckIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSignInOptions } from "@/hooks/convex"
import { withSignInMarker } from "@/lib/analytics-events"
import { authClient } from "@/lib/auth-client"
import { currentCampus } from "@/lib/campus"
import { isMemberEmail, normaliseEmail } from "@/lib/campus/member-email"
import type { CampusProfile } from "@/lib/campus/profile"
import { focusOnMount } from "@/lib/focus"
import { cn } from "@/lib/utils"

export type SignInMethod = "cam" | "google"

// The member tier's words come from the campus this build serves (lib/campus,
// decision D8); for Cambridge they are the literals they replaced. Each piece
// of copy is one template string, so the server renders one text node, as
// before.
const campus = currentCampus()
const tier = campus.memberTier
const memberDomain = campus.facts.memberEmail.domains[0]

/**
 * Whether the member-tier form accepts `email`: the campus's own rule
 * (`isMemberEmail`), the same one the server gates the sign-in link on
 * (convex/betterAuth/auth.ts asks `deploymentProfile()`), so the client and
 * the server never disagree. For Cambridge it is exactly `isCamEmail`.
 */
export function acceptsMemberAddress(email: string, profile: CampusProfile = campus): boolean {
  return isMemberEmail(normaliseEmail(email), profile)
}

/** `auth.getSignInOptions`: which options this deployment has switched on. */
export type SignInOptions = { google: boolean; camEmail: boolean }

/** The options to offer, Cambridge first; undefined while loading. */
export function signInMethods(options: SignInOptions | undefined): SignInMethod[] | undefined {
  if (!options) return undefined
  const methods: SignInMethod[] = []
  if (options.camEmail) methods.push("cam")
  if (options.google) methods.push("google")
  return methods
}

/** Messages for the `?error=` Better Auth appends to the error callback. */
const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: "Sign-in links are no longer used. Ask for a sign-in code instead.",
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
 * Only the options the deployment has switched on are shown
 * (`auth.getSignInOptions`), with no toggle when there is one; with none, the
 * page says sign-in is not open rather than offering dead buttons (ENG-35).
 * Signing in creates the account on first use, so there is no separate
 * sign-up page.
 */
export function LoginForm(props: Omit<React.ComponentProps<typeof SignInCard>, "options">) {
  return <SignInCard options={useSignInOptions()} {...props} />
}

/** The form for given `options` (undefined while loading), for tests. */
export function SignInCard({
  className,
  options,
  defaultMethod = "cam",
  linkError,
  next,
  ...props
}: React.ComponentProps<"div"> & {
  options: SignInOptions | undefined
  defaultMethod?: SignInMethod
  /** `error` from a failed link, e.g. `INVALID_TOKEN`. */
  linkError?: string
  /** Where to land after a Cambridge sign-in; a same-origin path. */
  next?: string
}) {
  const [chosen, setChosen] = useState<SignInMethod>(defaultMethod)
  const reduceMotion = useReducedMotion()
  const methods = signInMethods(options)
  const method = methods?.includes(chosen) ? chosen : methods?.[0]

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle>
            {/* The page's one heading: /sign-in has no other. */}
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          </CardTitle>
          {method && (
            <CardDescription>
              {method === "cam"
                ? `${campus.place.name} members see ${tier.tierLabel} events`
                : `For the ${campus.brand.name} administrator`}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {methods === undefined ? (
            <div className="flex min-h-32 items-center justify-center" aria-busy>
              <Spinner />
              <span className="sr-only">Checking the sign-in options…</span>
            </div>
          ) : method === undefined ? (
            <NotOpen next={next} />
          ) : (
            <>
              {methods.length > 1 && (
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={method}
                  onValueChange={(value) => value && setChosen(value as SignInMethod)}
                  className="w-full"
                  aria-label="Sign-in method"
                >
                  <ToggleGroupItem value="cam" className="flex-1">
                    <MailIcon />
                    {tier.label}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="google" className="flex-1">
                    <ShieldCheckIcon />
                    Admin
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
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
                      initialError={linkError ? (LINK_ERRORS[linkError] ?? "Sign-in failed.") : ""}
                      next={next}
                    />
                  ) : (
                    <GoogleButton />
                  )}
                </motion.div>
              </AnimatePresence>
            </>
          )}
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        {`Browsing the directory needs no account. ${campus.brand.name} is unofficial and not affiliated with the ${campus.university.name} or ${campus.university.studentUnion}.`}
      </FieldDescription>
    </div>
  )
}

/** No option is switched on: say so, and send the visitor back. */
function NotOpen({ next }: { next?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center" role="status">
      <LockKeyholeIcon className="size-12 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">Sign-in is not open yet</p>
      <p className="text-sm text-muted-foreground">
        {`${tier.label} sign-in opens later. Until then ${tier.tierLabel} events stay hidden, and everything else can be read without an account.`}
      </p>
      <Button variant="outline" asChild>
        <Link href={next ?? "/events"}>{next ? "Go back" : "See what’s on"}</Link>
      </Button>
    </div>
  )
}

/** Messages for the email-OTP error codes Better Auth answers with. */
const CODE_ERRORS: Record<string, string> = {
  INVALID_OTP: "That code is not right. Check the email and try again.",
  OTP_EXPIRED: "That code has expired. Send a new one.",
  TOO_MANY_ATTEMPTS: "Too many wrong codes. Send a new one.",
}

/**
 * Two steps: the address, then the 6-digit code we email to it. A code, not a
 * link, because Exchange's scanning spent every emailed link before the member
 * saw it (convex/lib/signInEmail.ts).
 */
function CamEmailForm({ initialError, next }: { initialError: string; next?: string }) {
  const [email, setEmail] = useState("")
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState(initialError)
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const address = normaliseEmail(email)
  const invalid = touched && address !== "" && !acceptsMemberAddress(address)

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!acceptsMemberAddress(address)) {
      setError(tier.rejectMessage)
      return
    }
    setError("")
    setSending(true)
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: address,
        type: "sign-in",
      })
      if (result.error) setError(result.error.message ?? "The code could not be sent")
      else setSentTo(address)
    } catch {
      setError("Something went wrong. Try again.")
    } finally {
      setSending(false)
    }
  }

  if (sentTo) {
    return (
      <CodeForm
        email={sentTo}
        next={next}
        onChangeAddress={() => {
          setSentTo(null)
          setError("")
        }}
      />
    )
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={send} noValidate>
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor="cam-email">{tier.label}</FieldLabel>
        <Input
          id="cam-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={tier.placeholder}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
            if (error) setError("")
          }}
          onBlur={() => setTouched(true)}
          aria-invalid={invalid || undefined}
          required
        />
        {invalid ? (
          <FieldError>{`Only @${memberDomain} addresses can sign in here`}</FieldError>
        ) : (
          <FieldDescription>We email you a 6-digit code. No password.</FieldDescription>
        )}
      </Field>
      <Button type="submit" disabled={sending}>
        {sending ? <Spinner /> : <MailIcon />}
        {sending ? "Sending…" : "Email me a sign-in code"}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** The code step: six digits, then a full page load so every part of the site
 * reads the new session (the JWT cookie the sign-in response set). */
function CodeForm({
  email,
  next,
  onChangeAddress,
}: {
  email: string
  next?: string
  onChangeAddress: () => void
}) {
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [checking, setChecking] = useState(false)
  const [resent, setResent] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const otp = code.replace(/\D/g, "")
    if (otp.length !== 6) {
      setError("Enter the 6 digits from the email.")
      return
    }
    setError("")
    setChecking(true)
    try {
      const result = await authClient.signIn.emailOtp({ email, otp })
      if (result.error) {
        setError(CODE_ERRORS[result.error.code ?? ""] ?? result.error.message ?? "Sign-in failed.")
        setChecking(false)
        return
      }
      // The marker lets the landing page count the sign-in (method only).
      window.location.assign(withSignInMarker(next ?? "/", "cam"))
    } catch {
      setError("Something went wrong. Try again.")
      setChecking(false)
    }
  }

  const resend = async () => {
    setError("")
    const result = await authClient.emailOtp
      .sendVerificationOtp({ email, type: "sign-in" })
      .catch(() => null)
    if (!result || result.error) setError(result?.error?.message ?? "The code could not be sent")
    else setResent(true)
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {/* Takes focus: the form that was submitted is gone (lib/focus.ts, ENG-37). */}
      <div
        className="flex flex-col items-center gap-2 rounded-lg text-center outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        role="status"
        ref={focusOnMount}
        tabIndex={-1}
      >
        <MailCheckIcon className="size-10 text-primary" aria-hidden="true" />
        <p className="font-medium">Check your inbox</p>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-mono text-foreground">{email}</span>. It
          works once and expires in 10 minutes. Mail to Cambridge can take a few minutes.
        </p>
      </div>
      <Field data-invalid={Boolean(error) || undefined}>
        <FieldLabel htmlFor="cam-code">Sign-in code</FieldLabel>
        <Input
          id="cam-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          placeholder="123456"
          className="text-center font-mono text-lg tracking-[0.4em]"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            if (error) setError("")
          }}
          aria-invalid={Boolean(error) || undefined}
          required
        />
      </Field>
      <Button type="submit" disabled={checking}>
        {checking ? <Spinner /> : <LockKeyholeIcon />}
        {checking ? "Signing in…" : "Sign in"}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={resend} disabled={resent}>
          {resent ? "New code sent" : "Send a new code"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onChangeAddress}>
          Use a different address
        </Button>
      </div>
    </form>
  )
}

function GoogleButton() {
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
      <Button variant="outline" type="button" disabled={loading} onClick={signInWithGoogle}>
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
        Only listed broker accounts see the private area.
      </FieldDescription>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
