import Link from "next/link"

/** "On CAMsocs: A, B" — a guide section's clubs, linking their pages. */
export function ClubLinks({ clubs }: { clubs: readonly (readonly [string, string])[] }) {
  if (clubs.length === 0) return null
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">On CAMsocs: </span>
      {clubs.map(([slug, name], index) => (
        <span key={slug}>
          {index > 0 && ", "}
          <Link href={`/societies/${slug}`} className="underline underline-offset-4">
            {name}
          </Link>
        </span>
      ))}
    </p>
  )
}
