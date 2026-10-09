import {
  BriefcaseIcon,
  DicesIcon,
  DramaIcon,
  FlaskConicalIcon,
  GlobeIcon,
  GraduationCapIcon,
  HandHeartIcon,
  HeartHandshakeIcon,
  type LucideIcon,
  MountainIcon,
  MusicIcon,
  NewspaperIcon,
  PaletteIcon,
  RocketIcon,
  ScaleIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react"
import type { Category } from "@/lib/vocab"

/** One icon per category (data-model §5): the home page's tiles and the
 * fallback mark of an organisation without a logo. */
export const CATEGORY_ICONS: Record<Category, LucideIcon> = {
  academic: GraduationCapIcon,
  science_tech: FlaskConicalIcon,
  careers_professional: BriefcaseIcon,
  entrepreneurship: RocketIcon,
  arts_creative: PaletteIcon,
  music: MusicIcon,
  theatre_film_dance: DramaIcon,
  media_publishing: NewspaperIcon,
  cultural_international: GlobeIcon,
  faith: HandHeartIcon,
  politics_debate: ScaleIcon,
  causes_volunteering: HeartHandshakeIcon,
  identity_wellbeing: UsersIcon,
  sport: TrophyIcon,
  outdoors: MountainIcon,
  hobbies_games: DicesIcon,
}
