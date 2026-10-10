"""Event feeds (T6): the parsers and harvest logic behind the events stages.

One module per source, each with pure parsers (tested on fixtures) and a
``run(ctx)`` the stage module in `camsocs_pipeline.stages` delegates to:

=================  ======================================  =================
stage              module                                  source-research
=================  ======================================  =================
camdram_events     `events.camdram`                        §5
talks_cam          `events.talks_cam` (parser only)        §6
cucbc_events       `events.cucbc`                          §7
playwaze           `events.playwaze`                       §9
uni_events         `events.uni_events`                     §10
calendar_feeds     `events.calendar_feeds` + `events.ics`  §11
su_whatson         `events.su_whatson`                     §12
=================  ======================================  =================

Shared pieces:

- `events.common` — the London clock, the harvest window, `EventDraft` (what a
  parser produces) and `build_event_observation` (draft → staged
  `EventObservation`, every field through `claims.parser_field`);
- `events.checks` — date sanity (impossible years, end before start) and the
  "link in bio" flag;
- `resolve.lookup.OrgLookup` (not in this package: inbox, Instagram and
  termcards use it too) — the keyed organisations in staging plus the
  crosswalk (local and Convex's), which the events stages resolve organiser
  hints against (`reference_key`), and the feeds (`orgInternal`) they list;
- `events.ics` — generic iCalendar parsing: timezone normalisation to
  Europe/London (with the documented bogus-zone heuristic), recurrence
  expansion inside the window, de-duplication by UID;
- `events.seeds` — the few verified feeds that no harvested record lists yet;
- `events.duplicates` — one event, several sources: which staged readings the
  load stage folds into another source's event (data-model §2);
- `events.noise` — calendar noise (decision D6), the rules: which readings are
  no events (a prayer room closed, a deadline: dropped at load) and which are
  someone else's event a society only takes part in (a CTF on its calendar:
  ``hosting: takes_part``). The model for what the rules leave borderline is
  `extract.event_noise`, which the load runs; nothing here calls it.

Society websites' events pages are read by the LLM, so that stage
(`website_events`) lives in `sources.websites.events`, not here.

Events stages run after resolve, so they write keyed observations to their own
``<source_type>.events`` staging directory (`staging.store.events_directory`)
and never write to Convex (they read its crosswalk); `load` posts them. No
event text ever reaches an LLM here, and talks.cam content never may
(source-research §6).
"""
