import theatre from "@/lib/data/guides/theatre.json"
import sport from "@/lib/data/guides/university-sport.json"
import type { GuideSection } from "./guide-content"

/**
 * The University sport and theatre guides' researched text (ENG-114,
 * ENG-115), from the Sports Service, the Hawks' Club, the clubs, the ADC
 * Theatre, the societies and Camdram (`checkedOn`).
 */

export type ClubNote = { slug: string; name: string; note: string; sources: string[] }

export const SPORT_CHECKED_ON: string = sport.checkedOn
export const SPORT_SECTIONS: readonly GuideSection[] = sport.sections
export const SPORT_CLUBS: readonly ClubNote[] = sport.clubs

export const THEATRE_CHECKED_ON: string = theatre.checkedOn
export const THEATRE_SECTIONS: readonly GuideSection[] = theatre.sections
