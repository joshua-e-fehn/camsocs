"use client"

import { useConvexAuth } from "convex/react"
import { ArrowRightIcon, LockIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { FormalBadges } from "@/components/molecules/formal-badges"
import { FormalCollegeDetail } from "@/components/molecules/formal-college-detail"
import { FormalCollegeTile } from "@/components/molecules/formal-college-tile"
import { FormalLeaderboard } from "@/components/molecules/formal-leaderboard"
import { FormalProfileForm } from "@/components/molecules/formal-profile-form"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useSignInOptions } from "@/hooks/convex"
import {
  formalErrorMessage,
  type FormalTracker as Tracker,
  useEraseFormalTracker,
  useFormalLeaderboard,
  useFormalTracker,
  useSetFormalAttended,
} from "@/hooks/convex/formals"
import type { CollegeRef } from "@/lib/colleges"
import { linkProps } from "@/lib/crawl-traps"
import { formalCollegePath } from "@/lib/formal-paths"
import { badgeProgress, nextRank, percentDone, rankFor, TOTAL_COLLEGES } from "@/lib/formal-ranks"

/** Where a signed-out reader signs in: the Cambridge option, back here after. */
export const TRACKER_SIGN_IN = "/sign-in?cam=1&next=/formals/tracker"

/** The crest grid's columns, shared by the grid and its skeleton. */
const COLLEGE_GRID =
  "grid grid-cols-2 gap-3 min-[420px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7"

const SECTION_HEAD =
  "border-t-2 border-foreground pt-3 font-serif text-2xl font-medium tracking-tight"

/**
 * The member's formal tracker (/formals/tracker, ENG-272), ported from the
 * Cambridge Tracker: progress and rank, badges, a crest grid to tick, each
 * college's details, the leaderboard opt-in and the leaderboard, and
 * "Erase my tracker". Everything personal is read in the browser once the
 * session reaches the Convex client. The server's HTML (cached, anonymous)
 * and the loading state are the signed-out view: the sign-in prompt above a
 * plain grid of the colleges, each linking its formal hall page, so a
 * signed-out reader (every search visitor) sees nothing move on hydration
 * (formals SEO audit 2026-11-19: CLS) and crawlers get real links. Only a
 * signed-in reader's tracker replaces it.
 */
export function FormalTracker({ colleges }: { colleges: readonly CollegeRef[] }) {
  const { isAuthenticated } = useConvexAuth()
  const tracker = useFormalTracker()
  if (isAuthenticated && tracker) return <SignedInTracker tracker={tracker} colleges={colleges} />
  return (
    <div className="flex flex-col gap-12">
      <SignInPrompt loading={isAuthenticated} />
      <CollegeGrid colleges={colleges} />
    </div>
  )
}

/** The colleges as crests and names, each linking its formal hall page. */
function CollegeGrid({ colleges }: { colleges: readonly CollegeRef[] }) {
  return (
    <section aria-labelledby="formal-colleges" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="formal-colleges" className={SECTION_HEAD}>
          The {colleges.length} colleges
        </h2>
        <p className="text-sm text-muted-foreground">
          Each college’s nights, price, dress code and how a visitor gets in.
        </p>
      </div>
      <ul className={COLLEGE_GRID}>
        {colleges.map((college) => (
          <li key={college.key} className="flex">
            <Link
              href={formalCollegePath(college.slug)}
              className="flex min-h-36 flex-1 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center transition-colors duration-150 hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <CollegeCrest crest={college.crest} size={48} decorative />
              <span className="text-sm leading-tight font-medium text-balance">
                {college.shortName}
              </span>
              <span className="font-mono text-xs text-muted-foreground">Formal hall</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Placeholder rows in the leaderboard's shape: 4 columns on a phone, 5 from `sm`. */
function LeaderboardSkeleton() {
  return (
    <div role="status" aria-label="Loading the leaderboard" className="flex flex-col">
      {["a", "b", "c", "d", "e"].map((row) => (
        <div key={row} className="flex items-center gap-4 border-b py-3">
          <Skeleton className="h-4 w-6" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  )
}

/** "Start your tracker", or, for a reader already signed in whose tracker
 * is still on its way, a note that it is loading. */
function SignInPrompt({ loading }: { loading: boolean }) {
  const options = useSignInOptions()
  if (loading)
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-xl border p-6 text-sm text-muted-foreground"
      >
        <Spinner className="size-4" />
        Loading your tracker…
      </div>
    )
  return (
    <div className="flex flex-col gap-4 rounded-xl border p-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <LockIcon aria-hidden className="mt-1 size-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="font-serif text-xl font-medium">Start your tracker</p>
          <p className="max-w-xl text-sm text-muted-foreground">
            {options?.camEmail === false
              ? "Signing in is not open at the moment, so the tracker is resting. The rest of this page still works."
              : "Sign in with your @cam.ac.uk address to tick off colleges, keep notes and join the leaderboard. Your tracker is private to your account."}
          </p>
        </div>
      </div>
      {options?.camEmail !== false && (
        <Button asChild className="min-h-11 self-start sm:self-center">
          <Link {...linkProps(TRACKER_SIGN_IN)}>
            Sign in to start
            <ArrowRightIcon data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      )}
    </div>
  )
}

function SignedInTracker({
  tracker,
  colleges,
}: {
  tracker: Tracker
  colleges: readonly CollegeRef[]
}) {
  const setAttended = useSetFormalAttended()
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<CollegeRef | null>(null)
  // Bumped only by a successful erase, so the profile form starts empty again
  // then, and never remounts (losing what is typed) when a tick creates the profile.
  const [erasures, setErasures] = useState(0)
  const leaderboard = useFormalLeaderboard(tracker.canJoinLeaderboard)

  const byKey = useMemo(
    () => new Map(tracker.entries.map((entry) => [entry.collegeKey, entry])),
    [tracker.entries],
  )
  const ticked = useMemo(
    () => new Set(tracker.entries.filter((e) => e.attended).map((e) => e.collegeKey)),
    [tracker.entries],
  )
  const done = ticked.size
  const formals = tracker.entries.reduce(
    (sum, e) => sum + (e.attended ? Math.max(1, e.visits) : 0),
    0,
  )
  const rank = rankFor(done)
  const next = nextRank(done)
  const percent = percentDone(done)

  async function toggle(college: CollegeRef) {
    const key = college.key
    setPending((current) => new Set(current).add(key))
    try {
      await setAttended({ collegeKey: key, attended: !ticked.has(key) })
    } catch (failure) {
      toast.error(formalErrorMessage(failure))
    } finally {
      setPending((current) => {
        const rest = new Set(current)
        rest.delete(key)
        return rest
      })
    }
  }

  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="formal-progress" className="flex flex-col gap-4">
        <h2 id="formal-progress" className="sr-only">
          Your progress
        </h2>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">Rank</p>
            <p className="font-serif text-4xl font-medium tracking-tight">{rank.title}</p>
            <p className="text-sm text-muted-foreground">
              {next
                ? `${next.needed} more ${next.needed === 1 ? "college" : "colleges"} to ${next.rank.title}.`
                : "Every college. Nothing left but seconds."}
            </p>
          </div>
          <p className="font-mono tabular-nums">
            <span className="text-4xl">{done}</span>
            <span className="text-lg text-muted-foreground"> / {TOTAL_COLLEGES}</span>
            <span className="ml-3 text-sm text-muted-foreground">
              {percent}% · {formals} {formals === 1 ? "formal" : "formals"}
            </span>
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="Colleges with a formal"
          aria-valuemin={0}
          aria-valuemax={TOTAL_COLLEGES}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${TOTAL_COLLEGES} colleges`}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </section>

      <section aria-labelledby="formal-colleges" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="formal-colleges" className={SECTION_HEAD}>
            The 31 colleges
          </h2>
          <p className="text-sm text-muted-foreground">
            Press a crest when you have had a formal there; “Details” for the date, how many and
            your notes.
          </p>
        </div>
        <ul className={COLLEGE_GRID}>
          {colleges.map((college) => {
            const entry = byKey.get(college.key)
            return (
              <FormalCollegeTile
                key={college.key}
                college={college}
                ticked={ticked.has(college.key)}
                visits={entry?.attended ? entry.visits : 0}
                pending={pending.has(college.key)}
                onToggle={() => toggle(college)}
                onOpen={() => setOpen(college)}
              />
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="formal-badges" className="flex flex-col gap-2">
        <h2 id="formal-badges" className={SECTION_HEAD}>
          Badges
        </h2>
        <FormalBadges progress={badgeProgress(ticked)} />
      </section>

      <section aria-labelledby="formal-leaderboard" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="formal-leaderboard" className={SECTION_HEAD}>
            Leaderboard
          </h2>
          <p className="text-sm text-muted-foreground">
            Off unless you switch it on, and only signed-in Cambridge members can see it.
          </p>
        </div>
        <FormalProfileForm
          colleges={colleges}
          key={erasures}
          profile={tracker.profile}
          canJoin={tracker.canJoinLeaderboard}
        />
        {tracker.canJoinLeaderboard &&
          (leaderboard === undefined ? (
            <LeaderboardSkeleton />
          ) : leaderboard ? (
            <FormalLeaderboard rows={leaderboard} />
          ) : null)}
      </section>

      <section aria-labelledby="formal-erase" className="flex flex-col gap-3">
        <h2 id="formal-erase" className={SECTION_HEAD}>
          Your data
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Your ticks, dates and notes are stored with your account and seen by nobody else. Erasing
          deletes all of them and your leaderboard entry at once; it cannot be undone.
        </p>
        <EraseTracker
          disabled={tracker.entries.length === 0 && tracker.profile === null}
          onErased={() => setErasures((count) => count + 1)}
        />
      </section>

      {open && (
        <FormalCollegeDetail
          key={open.key}
          college={open}
          entry={byKey.get(open.key)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function EraseTracker({ disabled, onErased }: { disabled: boolean; onErased: () => void }) {
  const erase = useEraseFormalTracker()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  async function confirm() {
    setPending(true)
    try {
      await erase({})
      onErased()
      setOpen(false)
      toast.success("Your tracker is erased.")
    } catch (failure) {
      toast.error(formalErrorMessage(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        className="min-h-11 self-start sm:min-h-0"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon data-icon="inline-start" aria-hidden />
        Erase my tracker
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Erase your tracker?</DialogTitle>
            <DialogDescription>
              Every tick, date, count and note, and your leaderboard entry, are deleted. This cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-0"
                disabled={pending}
              >
                Keep it
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11 sm:min-h-0"
              disabled={pending}
              onClick={confirm}
            >
              {pending && <Spinner className="size-3.5" />}
              Erase everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
