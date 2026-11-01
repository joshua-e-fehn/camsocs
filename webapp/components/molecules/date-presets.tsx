import { DATE_PRESET_LABELS, DATE_PRESETS, type DatePreset } from "@/lib/date-presets"
import { cn } from "@/lib/utils"

/**
 * Quick date ranges as one row of chips — Today · Tomorrow · This week ·
 * Weekend · Rest of term (lib/date-presets.ts computes the ranges). Generic
 * across the agendas: the caller passes the presets that apply today (no
 * "Rest of term" in the vacation) and what a tap does. Tapping the chip that
 * is on turns it off. The row scrolls sideways on a phone rather than wrap.
 *
 *   <DatePresets value={state.preset} available={availablePresets(today, termEnd)}
 *                onChange={(preset) => …} accent="talks" />
 */
export function DatePresets({
  value,
  onChange,
  available = DATE_PRESETS,
  labels = DATE_PRESET_LABELS,
  accent = "talks",
  className,
}: {
  value?: DatePreset
  onChange: (preset: DatePreset | undefined) => void
  available?: readonly DatePreset[]
  /** Override a label ("Rest of Mich"). */
  labels?: Partial<Record<DatePreset, string>>
  accent?: "talks" | "events" | "primary"
  className?: string
}) {
  const on = {
    talks: "border-talks bg-talks-tint text-talks",
    events: "border-events bg-events-tint text-events",
    primary: "border-primary bg-accent text-primary",
  }[accent]
  return (
    <fieldset
      className={cn(
        "-mx-4 flex min-w-0 items-center gap-1.5 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <legend className="sr-only">When</legend>
      {available.map((preset) => {
        const selected = value === preset
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? undefined : preset)}
            className={cn(
              "inline-flex h-11 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 sm:h-8",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              selected ? on : "bg-card hover:border-foreground/40",
            )}
          >
            {labels[preset] ?? DATE_PRESET_LABELS[preset]}
          </button>
        )
      })}
    </fieldset>
  )
}
