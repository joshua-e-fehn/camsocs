# Retention schedule

What is kept, for how long, what ends it, and whether the deletion is automated yet. The public privacy notice (`/privacy`, "How long we keep it") states the same periods; change this file first, then the page and `PRIVACY_NOTICE_UPDATED` in `webapp/lib/site.ts`.

"Automated" means code in this repo enforces it today. Everything marked **manual** is Joshua's job until it is automated; the open items are listed at the end.

| ID | Data | Kept for | Ends with | How it is removed | Automated? |
|---|---|---|---|---|---|
| R1 | Organisation listings (`organisations`, `orgCards`, teams, sessions) | While the organisation is active | No activity and no current register for 2 academic years → marked defunct, so `archived` (left out of the directory's default view), then deleted 1 year later. A removal request ends it at once (R8) | Status is derived daily (`convex/derive.ts`: `dormant` after 180 days without activity or a current registration; `archived` once defunct) | `dormant`: yes. Archiving and deletion: **manual** |
| R2 | Provenance (`fieldClaims`, `sources`) | As long as the entity it describes | Entity deleted | Deleted with the entity (`ingest/purge:removeEntity`) | **manual** (run per entity) |
| R3 | Events (`events`, `eventOrganisers`), stored event images | 1 year after the event (longer than the 180-day activity window that `lastActiveAt` needs) | Age | Purge job | **manual** |
| R4 | Mailing-list messages (`inboundEmails`, their stored HTML and attachments) | 90 days from receipt | Age; extraction finished | Delete row and its `_storage` files | **manual** |
| R5 | Named committee members (`people`) | Until `staleAfter` (the next 30 June) + 30 days, unless the person consented to longer | Handover date | `stale` flag set daily (`convex/derive.ts`); row deleted 30 days later | Flag: yes. Deletion: **manual** |
| R6 | Interactions and introductions | 3 years after the last interaction with that organisation | Age | Delete rows | **manual** |
| R7 | Raw page cache (`var/cache/`) and LLM inputs/outputs kept locally | 90 days | Age | Delete files on the pipeline host | **manual** |
| R8 | Listing requests (`listingRequests`) | 2 years after resolution | Age | Delete row. For a removal or an objection, keep a suppression entry (organisation key or address hash, date, kind) indefinitely so a re-harvest does not bring the data back | **manual**; suppression list **not built yet** |
| R9 | Sign-in accounts and sessions (Better Auth) | Sessions: until expiry. Accounts: until deletion is requested, or 2 years unused | Expiry; request; inactivity | Better Auth expires sessions; account deletion by hand | Sessions: yes. Accounts: **manual** |
| R10 | Run log (`harvestRuns`) | 1 year | Age | Delete rows | **manual** (no personal data) |

## Annual review (each July)

1. Refresh every listing from its sources (a full harvest); anything no source still lists becomes a candidate for archiving.
2. Delete the `people` rows whose `staleAfter` passed more than 30 days ago.
3. Apply R3, R4, R6, R7, R8, R10.
4. Re-read this schedule against `docs/data-model.md` and the privacy notice.

## Open items

- A scheduled Convex job for R3, R4, R5 deletion, R8 and R10 (the daily cron in `convex/crons.ts` is the natural home).
- The suppression list (R8) and a pipeline check against it before any organisation is re-created or a person is re-added. The request form and `/request` already promise that a removed listing stays removed.
- A `var/cache/` pruning step in the pipeline (R7).
