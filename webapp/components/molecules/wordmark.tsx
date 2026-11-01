import { Crest } from "@/components/molecules/crest"
import { cn } from "@/lib/utils"

/**
 * The camsocs logo: the Three pillars crest and "camsocs" in Young Serif,
 * always lower case. The crest is our own (components/molecules/crest.tsx);
 * nothing in it is the University's arms or styling — the project is
 * unofficial (AGENTS.md).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 font-serif text-2xl leading-none tracking-[-0.01em]",
        className,
      )}
    >
      <Crest className="w-[1.3em]" />
      camsocs
    </span>
  )
}
