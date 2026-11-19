import { TrophyIcon } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { FormalLeaderboardRow } from "@/hooks/convex/formals"
import { cn } from "@/lib/utils"

/** The top opted-in members: rank, chosen name, home college, colleges and
 * formals. The reader's own row is marked "you". */
export function FormalLeaderboard({ rows }: { rows: readonly FormalLeaderboardRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
        <TrophyIcon aria-hidden className="size-10 text-muted-foreground" />
        <p className="font-medium">Nobody on the leaderboard yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Choose a leaderboard name above and switch it on to be the first.
        </p>
      </div>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="hidden sm:table-cell">College</TableHead>
          <TableHead className="text-right">Colleges</TableHead>
          <TableHead className="text-right">Formals</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.rank} className={cn(row.isMe && "bg-muted font-medium")}>
            <TableCell className="font-mono tabular-nums">{row.rank}</TableCell>
            <TableCell>
              {row.displayName}
              {row.isMe && <span className="ml-2 font-mono text-xs text-brand-text">you</span>}
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {row.homeCollege ?? "—"}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{row.colleges}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{row.visits}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
