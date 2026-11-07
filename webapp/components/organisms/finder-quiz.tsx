"use client"

import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, RotateCcwIcon, SparklesIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { track } from "@/lib/analytics"
import type { CollegeInfo } from "@/lib/colleges"
import type { FinderAnswers, FinderQuestion } from "@/lib/finder"
import { cn } from "@/lib/utils"

export type FinderResult = { answers: FinderAnswers; collegeKey?: string; restart: () => void }

/**
 * A Finder quiz (ENG-127): one question at a time, big emoji tiles, a
 * progress bar, then the results the page renders. Single-choice questions
 * move on by themselves; "At my college" opens a picker with the crests.
 * Motion is spring-based and switches off for people who ask for reduced
 * motion. Answers live in this component only.
 */
export function FinderQuiz({
  eyebrow,
  questions,
  colleges,
  finishLabel,
  children,
}: {
  eyebrow: string
  questions: readonly FinderQuestion[]
  colleges: readonly Pick<CollegeInfo, "key" | "shortName" | "crest">[]
  finishLabel: string
  children: (result: FinderResult) => React.ReactNode
}) {
  const reduce = useReducedMotion()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [collegeKey, setCollegeKey] = useState<string>()
  const [direction, setDirection] = useState(1)
  const [phase, setPhase] = useState<"quiz" | "thinking" | "results">("quiz")
  const question = questions[step]
  const chosen = answers[question?.id] ?? []
  const needsCollege = question?.id === "where" && chosen[0] === "college"
  const canGo = question
    ? (question.optional || chosen.length > 0) && (!needsCollege || collegeKey !== undefined)
    : false
  const last = step === questions.length - 1
  const top = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  // On a phone the next question can start below the fold: bring the quiz's
  // top back into view on every step after the first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step and phase changes
  useEffect(() => {
    if (!moved.current) {
      moved.current = true
      return
    }
    const box = top.current?.getBoundingClientRect()
    if (box && box.top < 0)
      top.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" })
  }, [step, phase])

  useEffect(() => {
    if (phase !== "thinking") return
    const timer = setTimeout(() => setPhase("results"), reduce ? 0 : 900)
    return () => clearTimeout(timer)
  }, [phase, reduce])

  function go(delta: number) {
    setDirection(delta)
    if (delta > 0 && last) {
      setPhase("thinking")
      return
    }
    setStep((s) => Math.min(questions.length - 1, Math.max(0, s + delta)))
  }

  function pick(optionId: string) {
    setAnswers((prev) => {
      const current = prev[question.id] ?? []
      const next = question.multi
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : [optionId]
      return { ...prev, [question.id]: next }
    })
    if (!question.multi && !(question.id === "where" && optionId === "college")) {
      setTimeout(() => go(1), reduce ? 0 : 280)
    }
  }

  const restart = useCallback(() => {
    setAnswers({})
    setCollegeKey(undefined)
    setStep(0)
    setDirection(-1)
    setPhase("quiz")
  }, [])

  const result = useMemo<FinderResult>(
    () => ({
      answers,
      collegeKey: answers.where?.[0] === "college" ? collegeKey : undefined,
      restart,
    }),
    [answers, collegeKey, restart],
  )

  if (phase === "results") {
    return (
      <div ref={top} className="flex scroll-mt-20 flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            {eyebrow}
          </p>
          <button
            type="button"
            onClick={restart}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm underline underline-offset-4 sm:min-h-0"
          >
            <RotateCcwIcon aria-hidden className="size-3.5" />
            Start again
          </button>
        </div>
        {children(result)}
      </div>
    )
  }

  const progress = phase === "thinking" ? 1 : step / questions.length
  const slide = reduce
    ? {}
    : {
        initial: { opacity: 0, x: 48 * direction },
        animate: { opacity: 1, x: 0 },
        // A short, timed exit: the next question never waits long behind it.
        exit: { opacity: 0, x: -48 * direction, transition: { duration: 0.12 } },
        transition: { type: "spring" as const, stiffness: 380, damping: 34 },
      }

  return (
    <div ref={top} className="flex scroll-mt-20 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between font-mono text-xs tracking-wider text-muted-foreground uppercase">
          <span>{eyebrow}</span>
          <span aria-live="polite">
            {phase === "thinking" ? "Matching…" : `${step + 1} of ${questions.length}`}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
          <motion.div
            className="h-full rounded-full bg-brand"
            initial={false}
            animate={{ width: `${Math.max(6, progress * 100)}%` }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 20 }}
          />
        </div>
      </div>

      {/* popLayout: the next question renders at once while the old one fades
          out on top, so nothing ever waits on an exit animation (a background
          tab pauses animation frames). */}
      <div className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          {phase === "thinking" ? (
            <motion.div
              key="thinking"
              {...slide}
              className="flex min-h-72 flex-col items-center justify-center gap-4 text-center"
            >
              <motion.span
                aria-hidden
                className="text-5xl"
                animate={reduce ? {} : { rotate: [0, 14, -10, 0], scale: [1, 1.15, 1] }}
                transition={{ duration: 0.9, repeat: Number.POSITIVE_INFINITY }}
              >
                ✨
              </motion.span>
              <p className="font-serif text-2xl">Finding your matches…</p>
            </motion.div>
          ) : (
            <motion.fieldset key={question.id} {...slide} className="flex min-w-0 flex-col gap-5">
              <legend className="sr-only">{question.prompt}</legend>
              <div className="flex flex-col gap-1">
                <h2 className="font-serif text-3xl leading-tight tracking-[-0.01em] text-balance sm:text-4xl">
                  {question.prompt}
                </h2>
                {question.help && <p className="text-muted-foreground">{question.help}</p>}
              </div>
              <div
                className={cn(
                  "grid gap-2.5",
                  question.options.length > 6
                    ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                    : "grid-cols-1 sm:grid-cols-2",
                )}
              >
                {question.options.map((option, index) => {
                  const on = chosen.includes(option.id)
                  return (
                    <motion.button
                      key={option.id}
                      type="button"
                      role={question.multi ? "checkbox" : "radio"}
                      aria-checked={on}
                      onClick={() => pick(option.id)}
                      initial={reduce ? false : { opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={
                        reduce
                          ? { duration: 0 }
                          : { delay: index * 0.025, type: "spring", stiffness: 420, damping: 30 }
                      }
                      whileTap={reduce ? undefined : { scale: 0.96 }}
                      className={cn(
                        "relative flex min-h-16 items-center gap-3 rounded-2xl border-2 px-3.5 py-3 text-left text-[0.9375rem] leading-snug transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        on
                          ? "border-brand bg-accent/70"
                          : "border-border bg-card hover:border-brand/50",
                      )}
                    >
                      <motion.span
                        aria-hidden
                        className="text-2xl"
                        animate={
                          on && !reduce ? { scale: [1, 1.35, 1], rotate: [0, -8, 0] } : { scale: 1 }
                        }
                        transition={{ duration: 0.35 }}
                      >
                        {option.emoji}
                      </motion.span>
                      <span className="min-w-0 flex-1">{option.label}</span>
                      {on && (
                        <motion.span
                          aria-hidden
                          initial={reduce ? false : { scale: 0 }}
                          animate={{ scale: 1 }}
                          className="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground"
                        >
                          <CheckIcon className="size-3.5" />
                        </motion.span>
                      )}
                    </motion.button>
                  )
                })}
              </div>

              {needsCollege && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Which college?</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {colleges.map((college) => (
                      <button
                        key={college.key}
                        type="button"
                        aria-pressed={collegeKey === college.key}
                        onClick={() => setCollegeKey(college.key)}
                        className={cn(
                          "flex min-h-11 items-center gap-2 rounded-xl border-2 px-2.5 py-1.5 text-left text-sm transition-colors",
                          collegeKey === college.key
                            ? "border-brand bg-accent/70"
                            : "border-border hover:border-brand/50",
                        )}
                      >
                        <CollegeCrest crest={college.crest} size={24} decorative />
                        {college.shortName}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={step === 0}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground disabled:invisible"
                >
                  <ArrowLeftIcon aria-hidden className="size-4" />
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={!canGo}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition-opacity",
                    "disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  {last ? (
                    <>
                      <SparklesIcon aria-hidden className="size-4" />
                      {finishLabel}
                    </>
                  ) : question.optional && chosen.length === 0 ? (
                    <>
                      Skip
                      <ArrowRightIcon aria-hidden className="size-4" />
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRightIcon aria-hidden className="size-4" />
                    </>
                  )}
                </button>
              </div>
            </motion.fieldset>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** Sends `finder_completed` once, when a finished quiz has its results (ENG-133). */
export function useFinderCompleted(
  finder: "societies" | "events" | "talks",
  resultCount: number | undefined,
) {
  const sent = useRef(false)
  useEffect(() => {
    if (resultCount === undefined || sent.current) return
    sent.current = true
    track("finder_completed", { finder, resultCount: Math.min(resultCount, 15) })
  }, [finder, resultCount])
}
