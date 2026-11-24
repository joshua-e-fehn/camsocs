import {
  BriefcaseIcon,
  BusIcon,
  CircleDotIcon,
  ClapperboardIcon,
  DramaIcon,
  DumbbellIcon,
  FrameIcon,
  GraduationCapIcon,
  HammerIcon,
  HandHeartIcon,
  type LucideIcon,
  MedalIcon,
  MessagesSquareIcon,
  MicIcon,
  PartyPopperIcon,
  PresentationIcon,
  TentIcon,
  TrophyIcon,
  UsersIcon,
  UtensilsCrossedIcon,
} from "lucide-react"
import type { EventType, ItemLocationPrecision, TalkKind } from "./vocab"

/**
 * One icon per event type and talk kind (and `film`, a film with no
 * screening venue), shown beside the type's text label on the map's pins and
 * rows, the event and talk lists and their pages. Always decorative
 * (`aria-hidden`): the label is never dropped for the icon (DESIGN.md
 * "Iconography"). Neutral by design: worship has no one religion's symbol.
 */
export const EVENT_TYPE_ICONS: Record<EventType, LucideIcon> = {
  talk: MicIcon,
  social: PartyPopperIcon,
  performance: DramaIcon,
  exhibition: FrameIcon,
  competition: TrophyIcon,
  match: MedalIcon,
  workshop: HammerIcon,
  trip: BusIcon,
  formal: UtensilsCrossedIcon,
  careers: BriefcaseIcon,
  meeting: MessagesSquareIcon,
  training: DumbbellIcon,
  worship: HandHeartIcon,
  fair: TentIcon,
  other: CircleDotIcon,
}

export const TALK_KIND_ICONS: Record<TalkKind, LucideIcon> = {
  seminar: UsersIcon,
  lecture: GraduationCapIcon,
  workshop: HammerIcon,
  conference: PresentationIcon,
  other: MicIcon,
}

/** A film production with no screening venue (precision `film`). */
export const FILM_ICON: LucideIcon = ClapperboardIcon

/** A stable name for each icon an item can have: `event-<type>`,
 * `talk-<kind>` or `film` (the map's pins look their icon up by it). */
export type ItemIconKey = `event-${EventType}` | `talk-${TalkKind}` | "film"

export const ITEM_ICONS: Record<ItemIconKey, LucideIcon> = {
  ...(Object.fromEntries(
    Object.entries(EVENT_TYPE_ICONS).map(([type, icon]) => [`event-${type}`, icon]),
  ) as Record<`event-${EventType}`, LucideIcon>),
  ...(Object.fromEntries(
    Object.entries(TALK_KIND_ICONS).map(([kind, icon]) => [`talk-${kind}`, icon]),
  ) as Record<`talk-${TalkKind}`, LucideIcon>),
  film: FILM_ICON,
}

/** The icon key of an event or a talk: the film icon for a film with no
 * screening venue, else its type's (`other` when it has none). */
export function itemIconKey(item: {
  kind: "event" | "talk"
  eventType?: EventType
  talkKind?: TalkKind
  precision?: ItemLocationPrecision
}): ItemIconKey {
  if (item.precision === "film") return "film"
  return item.kind === "talk"
    ? `talk-${item.talkKind ?? "other"}`
    : `event-${item.eventType ?? "other"}`
}
