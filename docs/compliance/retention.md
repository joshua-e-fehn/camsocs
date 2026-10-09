# Retention schedule

What is kept, for how long, what ends it, and whether the deletion is automated yet. The public privacy notice (`/privacy`, "How long we keep it") states the same periods; change this file first, then the page and `PRIVACY_NOTICE_UPDATED` in `webapp/lib/site.ts`.

"Automated" means code in this repo enforces it today: the daily Convex cron `retention-daily` (04:15 UTC, `webapp/convex/retention.ts`; one paginated walk per rule, all with one clock) or the pipeline command `camsocs prune-cache`. Everything marked **manual** is Joshua's job; the reason is given.

| ID | Data | Kept for | Ends with | How it is removed | Automated? |
|---|---|---|---|---|---|
| R1 | Organisation listings (`organisations`, `orgCards`, teams, sessions) | While the organisation is active | No activity and no current register for 2 academic years → marked defunct, so `archived` (left out of the directory's default view), then deleted 1 year later. A removal request ends it at once (R8) | Status is derived daily (`convex/derive.ts`: `dormant` after 180 days without activity or a current registration; `archived` once defunct). Deletion: `ingest/purge:removeEntity` | `dormant`: yes. Archiving and deletion: **manual** — the first harvest was in October 2026, so nothing can be due before July 2028, and deleting a listing is a judgement call (a quiet society is not a defunct one) |
| R2 | Provenance (`fieldClaims`, `sources`). `fieldClaims.valueRaw` holds the unredacted original of public free text (D1), names included | As long as the entity it describes | Entity deleted | Deleted with the entity (`ingest/purge:removeEntity`); an event's claims go with the event (R3) | With R1: **manual**. With R3: yes |
| R3 | Events (`events`, `eventOrganisers`), stored event images | 1 year after the event ended (longer than the 180-day activity window that `lastActiveAt` needs) | Age | `purgeEvents`: the event, its claims and organiser links; its stored image (and `storedFiles` row) unless another event or a logo still shows it; its organisers are re-derived | **yes** |
| R4 | Mailing-list messages (`inboundEmails`, their stored HTML and attachments) | Body (text, HTML, attachments): 30 days from receipt once processed. The row (sender, subject, extraction outcome): 90 days from receipt | Age; extraction finished | `stripMailBodies` empties the body and deletes the files (`bodyDeletedAt`); `purgeMail` deletes the row and anything left in storage, processed or not | **yes** |
| R5 | Named committee members (`people`) | Until `staleAfter` (the next 30 June, D2) + 30 days, unless the person consented to longer | Handover date | `stale` set daily (`convex/derive.ts`); `expirePeople`: past `staleAfter`, the broker's own rows are archived (the 30-day grace, in which the broker may extend `staleAfter`); 30 days past it every row is deleted, from public sources or the broker's own. Rows with `consentBasis: consent` stay | **yes** |
| R6 | Interactions and introductions | 3 years after the last interaction with that organisation | Age | `purgeInteractions`: an interaction 3 years old whose organisation has had none since; `purgeIntroductions`: introductions 3 years old | **yes** |
| R7 | Raw page cache (`var/cache/`), LLM inputs/outputs kept locally, staged observations (`var/staging/`) | 90 days | Age | `pixi run prune-cache` (`camsocs prune-cache --older-than 90d`): a page's body, meta and failure note go together once all are older; LLM replies one by one; superseded staging files, never the latest of each part | **yes**, when the command runs (add it to the pipeline host's cron next to the daily sync) |
| R8 | Listing requests (`listingRequests`) | 2 years after resolution; a rejected request 90 days after it was rejected | Age | `purgeRequests` deletes the row. Accepting a removal or objection creates **suppressions** (`suppressions`: the listing's key, a field name, an address only as a sha256, or a broker person's key; date and request kind), kept indefinitely: the pipeline filters by them before every load, and Convex refuses what slips through (`convex/lib/suppressions.ts`) | **yes** |
| R9 | Sign-in accounts and sessions (Better Auth) | Sessions: until expiry. Accounts: until deletion is requested, or 2 years unused | Expiry; request; inactivity | Better Auth expires sessions; account deletion by hand | Sessions: yes. Accounts: **manual** — they live in the Better Auth component's tables, which only its adapter should write; nobody but Joshua signs in before the `@cam.ac.uk` tier opens |
| R10 | Run log (`harvestRuns`) | 1 year | Age | `purgeRuns` | **yes** (no personal data) |

## Annual review (each July)

1. Refresh every listing from its sources (`pixi run harvest`); anything no source still lists becomes a candidate for archiving (R1).
2. Check that `retention-daily` ran (Convex dashboard, scheduled functions) and that `prune-cache` is in the host's cron.
3. Delete or archive by hand what R1 and R9 leave to Joshua.
4. Re-read this schedule against `docs/data-model.md` and the privacy notice.

## Open items

- R1 archiving and deletion, and R9 account deletion, stay manual (reasons above).
- `prune-cache` runs only where it is scheduled: add `pixi run prune-cache` to the host's cron (`scripts/daily-sync.sh` runs only `sync`).
- Clearing `valueRaw` on superseded free-text claims after each 30 June handover, so unredacted names (D1) do not outlive the year (DPIA-lite R-12).
