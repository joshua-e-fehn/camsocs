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
- `events.organisers` — `OrganiserIndex`: the keyed organisations already in
  staging (resolver output and later stages), which the events stages resolve
  organiser hints against, and the feeds (`orgInternal`) they list;
- `events.ics` — generic iCalendar parsing: timezone normalisation to
  Europe/London (with the documented bogus-zone heuristic), recurrence
  expansion inside the window, de-duplication by UID;
- `events.seeds` — the few verified feeds that no harvested record lists yet.

Events stages run after resolve, so they write keyed observations to their own
``<source_type>.events`` staging directory (`staging.store.events_directory`)
and never call Convex; `load` posts them. No event text ever reaches an LLM
here, and talks.cam content never may (source-research §6).
"""
