# Locations and the map (ENG-276, ENG-277)

The build contract for two features: every event and talk gets an exact, clickable
location, and `/map` shows one day of them on a map of Cambridge.
Owner decisions were made in a grilling session on 2026-11-24 (PLAN.md D13).

## 0. Owner decisions (2026-11-24)

1. **Every event and every talk** has a location on its own page, linked to the
   visitor's maps app: Apple Maps on Apple platforms, Google Maps elsewhere.
   - At most 1–2% of upcoming items may stay unresolved.
   - "Exact place sent to accepted applicants" items still get the rough area
     they state (`precision: "area"`).
2. **talks.cam text may be given to the LLM**, for location resolution (D13,
   Joshua's decision: talk text may be given to the model to resolve the
   venue). The robots.txt rules for *fetching* talks.cam are unchanged:
   Crawl-delay, and no AI agents fetch its pages. The G1 talks boundary for *rendering* is unchanged too (§4).
3. **Geocoding.** Joshua chose Google Places.
   - Google's Maps Platform terms forbid showing Places coordinates on a
     non-Google map, and limit caching them to 30 days. A `place_id` may be
     stored indefinitely.
   - So: **coordinates come from OpenStreetMap (Nominatim, ODbL, attribution on
     the map)**, with Photon (OSM data) and postcodes.io (ONS Postcode
     Directory, OGL v3.0) as fallbacks since 2026-11-24 (§2 step 4).
     **Google Places Text Search (IDs only, free SKU) supplies a
     `googlePlaceId`** for an exact "Open in Google Maps" link.
   - Places key: Convex env and pipeline env `GOOGLE_PLACES_API_KEY` (GCP project
     camsocs-515220, restricted to places.googleapis.com, £20 budget alert).
     Vault item "CAMsocs Google Places API key (camsocs-515220)". Set on Convex
     dev and production and in `/opt/camsocs/pipeline/.env.prod` on the host
     (2026-11-24); only the pipeline uses it (docs/deploy.md §3–§4; rotation:
     docs/key-rotation.md).
4. **`/map`**:
   - one page, events and talks together, with Events/Talks toggles and a
     different pin style for each;
   - linked from the site (footer Browse, the ⌘K pages, a Map link on
     /events and /talks);
   - shows one London day, `?d=YYYY-MM-DD`, opening on today;
   - day switching: ‹ › arrows, a 7-day strip with counts, a date picker,
     ←/→ keys, and swipe on mobile.
5. **Past and now.** A pin greys once the item has ended (`endsAt`, else
   `startsAt` + 1 h).
   - Ongoing items get a "Now" ring (apricot `--today`, also labelled in text).
   - The page updates live, with no reload.
   - Multi-day and all-day events show on every day they cover.
   - Every pin on a past day is grey; no pin on a future day is.
6. **Layout.**
   - Desktop: the map on the left, a time-ordered list on the right. Hovering
     a row highlights its pin; clicking a pin scrolls to and opens its row.
   - Mobile: a full-screen map with a draggable bottom sheet holding the same
     list.
   - Items at one venue share one numbered pin.
   - Pins drawn within 36 px of each other at the current zoom merge into one
     cluster bubble with the items' total (`lib/map-cluster.ts`, greedy over a
     grid, regrouped when a move or zoom ends; 2026-11-24). It keeps the pin
     rules: ink when all talks, else teal; the Now ring if any item is on now;
     grey when all are over. Activating it zooms to its members (a jump with
     `prefers-reduced-motion`); at the closest zoom, or when they share one
     spot, it opens all their rows in the list. Its name says "7 items at 4
     places, zoom in". A hovered row raises its pin or the cluster holding it.
   - The first view fits the day's pins inside the city box
     (`CAMBRIDGE_BOUNDS`) with padding, no closer than zoom 15, so a day all in
     the centre opens on the centre; only when no pin is in the city are the
     others fitted.
   - Venue names are printed without OpenStreetMap's "(University of
     Cambridge)", ", University of Cambridge", " - University of Cambridge",
     ", Cambridge" suffixes (`lib/venue-name.ts`; a name that is only the
     suffix stays whole). Keys are unchanged. `locate` posts new venues'
     names through the same rule (`locate/venue_name.py`); both are held to
     `webapp/lib/venue-name.fixtures.json`.
   - Each row links to its page and has a Directions link.
   - Online items go in an "Online" section and get no pin. Films with no
     screening venue (precision `film`) go in a "Films" section with the film
     icon, no pin, and the counts line says how many. Unresolved items
     go under "Location TBC".
   - Each event type and talk kind has an icon (`lib/item-icons.ts`): beside
     the type's word on every row, and in white inside a lone item's pin (a
     pin of several items and a cluster keep their number).
   - Items at a placed venue far from Cambridge (beyond `MAP_PIN_BOUNDS`,
     S 52.05 N 52.35 W −0.10 E 0.35: an away fixture, a tour abroad) get no
     pin, so the camera never fits to them; they are listed under "Away from
     Cambridge" with their place, address and a Directions link (2026-11-24).
7. **MapLibre GL + OpenFreeMap vector tiles** (`https://tiles.openfreemap.org`),
   restyled in River & ink (light only, DESIGN.md tokens), with a visible
   OSM/OpenFreeMap attribution.

## 1. Data model (Convex)

### 1a. Venues
The `venues` table (claims entity) is unchanged in shape. It gains one claimable field:

- `googlePlaceId?: string`: a Google place id. The id is public and only used to
  build links.
  - Add it to `VENUE_FIELDS` in `webapp/lib/vocab.ts` and
    `pipeline/.../models/vocab.py`, to `VENUE_SPECS`, and to `venueFields` as
    `v.optional`.
  - Expose it in `venuePublic`.

New `SOURCE_TYPES` entries, on both sides:

- `osm_nominatim`: venue `name`, `address`, `lat`, `lng`.
  - `sourceUrl` is `https://www.openstreetmap.org/<type>/<id>`.
  - Method `parser`, evidence `secondary`.
- `google_places`: venue `googlePlaceId`.
  - `sourceUrl` is `https://www.google.com/maps/place/?q=place_id:<id>`.
  - Method `parser`, evidence `secondary`.
- `postcodes_io` (2026-11-24): venue `lat`, `lng` from a UK postcode's centroid.
  - `sourceUrl` is `https://api.postcodes.io/postcodes/<postcode>`.
  - Method `parser`, evidence `secondary`. The item is `building` precision.
- Photon results are OSM objects: `osm_nominatim` claims with extractor
  `locate.photon.<field>`.
- When the source names no object (a street, a nameless building, a postcode),
  the venue's `name` (and `address`) is the model's building name, posted
  `llm` / `inferred` and cited to that source, only when it reads as a
  building's name (§2 step 4).
- Coordinates are only range-checked: a venue anywhere in the world (an away
  fixture's course, a tour venue abroad) is accepted.

Venues are created through the existing `claims` route. `name` is required in the
same request as a new venue key.

### 1b. `itemLocations` (new table, not claims)
One row per event or talk: the resolved place for that item.

```ts
itemLocations: {
  kind: "event" | "talk",
  itemKey: string,             // evt-… / the talk key
  startsAt: number,            // copied from the item (coverage windows, pruning)
  precision: "exact" | "building" | "area" | "online" | "unknown" | "film",
  venueKey?: string,           // ven-…; required unless precision is online/unknown/film
  room?: string,               // ≤ 120, e.g. "Seminar Room 1"; never a person's name
  areaLabel?: string,          // ≤ 120, for "area": e.g. "Central Cambridge (exact place sent to attendees)"
  note?: string,               // ≤ 200, internal: why unknown (shown on the dashboard only)
  method: "source" | "alias" | "llm",
  model?: string, promptVersion?: string,
  inputHash: string,           // pipeline's hash of what it read; re-resolve when it changes
  resolvedAt: number,
}
indexes: by_kind_item [kind, itemKey], by_startsAt [startsAt], by_venue [venueKey]
```

Precision means:
- `exact`: the building is known, and the room if one is given.
- `building`: the building is a best inference, e.g. a college society event with
  no venue → its college.
- `area`: only an area is known; `venueKey` points at the area's anchor venue
  (e.g. a college, Parker's Piece, "Central Cambridge" = Market Square).
- `online`: online only.
- `unknown`: no location at all, with a note.
- `film` (2026-11-24, Joshua): a film production with no screening venue (a
  student short film, a shoot; Camdram lists them as shows with no venue,
  "Short Film" or "On Location"). No venue, counted as resolved like
  `online`, never pinned at a made-up place; a film *with* a screening venue
  is placed like any other event.

`itemLocations` is written only through the new route. A row whose item is gone
is pruned by a daily cron (startsAt older than 60 days, or an item key that no
longer exists).

### 1c. Pipeline routes (`convex/http.ts`, Bearer)
- `readRoute("locations/pending")`: paginated `{cursor?, from, to}` → `{page, continueCursor, isDone}`.
  - Covers upcoming events in [from, to) (all visibilities except members_only;
    not cancelled), the multi-day events that started before `from` and still
    run (`spanEndsAt > from`, bounded like the calendar's spanning read), and
    listed talks.
  - Each item: `{kind, itemKey, startsAt, endsAt?, allDay?, title, description?
    (≤1500), venueText? (events) | venue? (talks), venueKey? (events), online?
    (talks), organisers: string[] (org names, or talk department names +
    series), organiserPlaces?: string[] (≤ 6, 2026-11-24, optional: the
    organisers' college, their regular sessions' venue names or texts, the
    venues their latest own events name, most used first and ties by name, a
    talk's departments; worked out for at most 40 distinct organisers per
    call, from 5 sessions and 8 events each, to stay inside a query's read
    limit), sourceType, sourceUrl?, stored?: {inputHash, precision, venueKey?, startsAt}}`.
  - Events carry their (redacted) `venueText`. Talks carry `venue`.
- `readRoute("venues/all")`: every venue `{key, name, aliases, address?, lat?, lng?, collegeKey?, googlePlaceId?, osmUrl?}`, paginated.
  `osmUrl` (2026-11-24, optional) is the `sourceUrl` of the venue's `lat`
  (else `name`) when it is an OpenStreetMap object's page: the stage
  classifies the venue by that object (§2 step 4, "Coarse venues").
  Deploy this Convex change (prod) before or with the pipeline that reads
  it: until `osmUrl` is served no venue is classified, so rows at coarse
  venues stay as they are (a clean no-op, tested), while the r3 bump
  re-runs the `unknown` rows from cache.
- `ingestionRoute("locations/batch")`: `{locations: ItemLocationInput[]}` (max 500).
  - Upsert by (kind, itemKey).
  - Validates the `ven-` key format, that the venue exists (unless precision is
    online/unknown/film, which never carry one), and the text limits.
  - Returns `{inserted, updated, unchanged, rejected: [{itemKey, reason}]}`.
- `readRoute("locations/summary")`: for the monitor.
  `{upcoming, resolved, unknown, byPrecision: {...}, unresolvedShare}`, over items
  starting in the next 14 days.

All new routes go in `READ_ROUTES` (`pipeline/.../graph.py`) as needed.

### 1d. Public queries
- `locations.forItem({kind, itemKey})` → `null | {precision, room?, areaLabel?, venue: VenuePublic | null}`.
  - The talk variant is called only from `/talks/...` pages (G1).
- `map.day({date, talks?: "include" | "exclude", talksCam?: "exclude" | "only"})`;
  both default to `exclude` (G1: talk text only when a caller asks for it)
  returns:

  ```ts
  { date, from, to,
    venues: VenuePublic[],                               // only those referenced, with lat/lng
    items: MapItem[],                                    // events + (talks), sorted by start
    counts: { events, talks, online, unknown, films } }
  MapItem = { kind: "event"|"talk", key, title, startsAt, endsAt: number|null, allDay,
              href, cancelled, precision, venueKey: string|null, room?: string, areaLabel?: string,
              placeLabel: string,   // what to print: "Seminar Room 1, Isaac Newton Institute"
              orgLabel?: string, eventType?/kind?, visibility?: "public"|"cam_only" }
  ```

  - It respects `visibleEventTiers`, suppressions, withdrawn events, and
    `listing: "listed"` for talks.
  - Multi-day events show on every day they cover (the events.list two-range
    read).
  - It never reads `venues.list`: it reads only the referenced venues, by key.
  - `venues` holds every referenced venue with coordinates, wherever it is;
    the page pins only those inside `MAP_PIN_BOUNDS` (lib/map-day.ts
    `pinnable`) and lists the rest under "Away from Cambridge".
- `map.weekCounts({from: date, days: 7})` → `[{date, events, talks}]`.
  - It contains no talks.cam text: numbers only, so it is G1-safe.
- `broker.overview.locationCoverage` (`requireBrokerUser`): byPrecision counts and
  `unresolvedShare` for the next 14 days, plus up to 20 unknown items (title,
  kind, key, note).
- A shared helper `webapp/lib/maps-link.ts`:
  - `mapsLinks({name, address?, lat, lng, googlePlaceId?})` → `{apple, google}`.
    Apple is `https://maps.apple.com/?q=<name>&ll=<lat>,<lng>`.
    Google is `https://www.google.com/maps/search/?api=1&query=<name or lat,lng>`
    plus `&query_place_id=<id>`.
  - `preferredMapsHref(links, userAgent)`: Apple on iPhone/iPad/Mac, else Google.
    Client-side only; the server renders Google and swaps after hydration.
  - A `directionsHref` variant: Apple `daddr=`, Google `/maps/dir/?api=1&destination=`.

## 2. The `locate` pipeline stage

- It sits in a new phase `locate`, between `talks` and `report`, and joins
  `GROUPS["events"]` (daily) and `full`.
- It has `llm=True` and `network=True`, its sinks are the routes above plus
  `claims`, and `docs=("source-research§23",)`. Add §23 "Location resolution:
  OSM Nominatim + Google Places" to `docs/source-research.md`.
- Window: now − 1 day to now + 120 days.

1. Read the pending items and `venues/all`. Compute each item's `inputHash`
   (prompt version + kind + title + description[:1500] + venue text + venueKey +
   online + organisers, + the sorted organiserPlaces only when the item names
   no venue and no venueKey, the one case the hint decides). Skip an item whose stored hash is equal, unless its
   stored `startsAt` differs (a rescheduled item is posted again, from the
   reply cache, so coverage and pruning use its new start). An `unknown`
   or `film` row (`resolver.VERSIONED`: a film row is a rule's verdict, so a
   fixed rule reaches it), and a row at a coarse venue (a town, a district or a street, step
   4), is posted with the resolver version after its hash
   (`<hash>:r3`, `resolver.RESOLVER_VERSION`), and one without the current
   version is due again: a new resolver (the gazetteer, r2; coarse venues,
   r3; films, r6, 2026-11-24) looks those items up again from the cached reply,
   asking no model. An item due only because its row is at a coarse venue
   (same input) never asks the model: without a cached reply (it matched
   the venue by name before r3) it is re-resolved at its stored venue,
   which step 4 sets aside for a building the venue text names, else
   gives `area` or `building` (metric `revisitedRows`). Rows at a place to
   go keep their plain hash and are left alone.
2. **Deterministic first:**
   - an online-only talk, or an event with an online venue (Zoom/Teams/link),
     and no physical place → `online`;
   - a Camdram event (only Camdram lists film productions as shows) with no
     `venueKey` of its own, no real venue text (none, or a placeholder such
     as "Short Film" / "On Location" / "TBC") and that is a film production
     (title or description: "short film", "(Short Film)", "student film",
     "film shoot"; venue text "Short Film" or "On Location"), with no
     screening or showing words in its title, venue text or description
     ("screening", "cinema", "Picturehouse", "premiere", "showcase",
     "festival", "night", "watch") → `source`/`film`, no venue
     (`matching.is_film_without_venue`; r6, 2026-11-24, so the unknown rows
     of earlier versions are re-run by this rule without asking the model).
     Anything else film-ish (a film society AGM, a talk about film, a
     filming workshop) goes to the model. Only this rule makes a `film`
     row: a model reply saying `film` is read as `unknown`;
   - an event `venueKey` whose venue has lat/lng → `source`/`exact`, with the
     room = what venueText adds;
   - an exact normalised match of the venue text against a venue name or
     alias → `alias`/`exact`.
3. **LLM** (`gpt-6-luna` bulk, fallback `gpt-6.1-sol` via LLMClient, and
   once more on the strong tier when a reply still fails validation;
   `LLMMemo`-cached by inputHash, prompt `extract/prompts/locate_v2.md`
   since 2026-11-24, which re-resolved every item).
   - Input: the item, the organisers' usual places, and a shortlist of up to
     60 known venues by token overlap (always including the colleges and the
     main University sites).
   - Output (pydantic, lenient: blank fields, camelCase keys, a bare string
     for a building and unknown precision words are read, not refused):
     `{precision: exact|building|area|online|unknown, building?: {name,
     address (with postcode), osmQuery, country}, venueKey?, parent?, room?,
     areaLabel?, outsideCambridge?, note?}`. `building` is always given
     unless online or unknown, also when `venueKey` names a known venue.
   - Resolution: the key's venue when the key is known and fits the item
     (shares a word with the place text or the named building), else the
     known venue of the building's name or alias, else the geocoded
     building. An invalid key never drops the item (the first prod run lost
     ~25 talks that way: "no venue named").
   - The prompt rules:
     - use your knowledge of Cambridge, e.g. "Keynes Room" and "Meade Room"
       are in the Faculty of Economics (Austin Robinson Building);
     - give the building's map name ("William Gates Building" for Computer
       Science), an address with a postcode, an OSM query and the country;
     - use the organisers: a department's or series' talk with no venue is
       in its building, a clinical series on the Cambridge Biomedical
       Campus, a college society's event at its college, a society's event
       at its usual place (`building`, or `area` "<College> (exact room not
       given)");
     - an away fixture is at the opponent's ground or course (the title
       often names it), `outsideCambridge`; a tour venue abroad likewise;
     - a room is never a person's name;
     - "location sent on acceptance" → `area` with the stated area;
     - say `unknown` only when nothing at all is inferable.
   - talks.cam text is allowed (D13).
4. **New venues** (`locate/gazetteer.py`, `locate/geocode.py`):
   - **The gazetteer first** (2026-11-24, ENG-276): a Cambridge place (not
     `outsideCambridge`) is looked up in the committed gazetteer
     `pipeline/src/camsocs_pipeline/locate/data/cambridge_places.json`
     (about 2,400 OSM features: the University's, colleges' and
     departments' buildings, nameless University buildings by their
     `occupier` department, institutes, halls, theatres, churches,
     libraries, sports grounds, named pubs, bars, cafés and restaurants;
     rebuilt by hand with `pixi run locate-gazetteer`, one Overpass query)
     plus curated aliases (`locate/data/cambridge_aliases.json`: "Faculty
     of Music" → "11 West Road", "Hodgkin-Huxley Seminar Room" → Physiology
     Building, "RDC" → Ray Dolby Centre, "CMS", "Keynes Room" → Austin
     Robinson Building, each pointing at one OSM id, checked by a test).
     The building's name, then its OSM query, are matched: the whole text
     or a segment that is an alias or a name, else the longest alias or
     name the text contains as whole words once its address parts are
     gone (two distinctive words, unless an alias or a college's name),
     else a name with exactly the text's distinctive words (two, or one
     college's short name). A room's name ("Chapel", "The Bar") counts
     only with its college; OSM placeholders ("TBA"), the University
     itself and names under four letters never count; a pub's or café's
     name only as the whole text or a segment of two words or more; a
     name that reads as an address only as the whole text. A hit is an
     OSM object: the venue is a known one of its name (placed by it when it
     has no point), else a new one posted from OSM's own name (without a
     trailing "(University of Cambridge)"), address and point, source type
     `osm_nominatim`, extractor `locate.gazetteer.<field>`, `sourceUrl` the
     object's OSM page, `retrievedAt` the gazetteer's read date. It is no
     model wording, so a talk may use it (G1). A known venue without a
     point is placed from the gazetteer too, before any request. When both
     buildings the model named are missed everywhere, a gazetteer building
     the venue text names is the item's (`building`).
   - Cambridge places, then, in order: Nominatim inside the Cambridge box
     (`osmQuery`, then "name, Cambridge"); Nominatim inside the Cambridge
     region (S 52.05 N 52.35 W −0.10 E 0.35: the villages); Photon
     (`https://photon.komoot.io/api`, OSM data, bbox the region); Nominatim's
     structured search (street + postcode); postcodes.io (the postcode,
     inside the region). The structured search nearly always answers with
     the road, so until 2026-11-24 postcodes.io was never asked
     (`postcodesCalls` 0 in the second production run); now a road it finds
     is checked against the postcode's point, and further than 250 m apart
     the postcode's point is used (`postcodePoints`). Nominatim and Photon at 1 request per second each,
     postcodes.io paced, all with our `CAMSOCS_USER_AGENT`, direct
     `httpx.Client`s.
   - `outsideCambridge` places: Nominatim without a box, narrowed to the
     model's country; Photon without a box; the structured search and
     postcodes.io for a UK address. A worldwide hit must share a word with
     what was asked and lie in that country. A one-word place with no
     address ("Barnes", "Marlborough") is only ever the town (`area`).
   - Every named feature found by name must share a distinctive word with
     the name or query asked for (`geocode.names_match`: generic words such
     as college, hall, room, seminar, centre and the address's own street
     and town words left out); otherwise it is another place ("Seminar Room
     1" → "Lee Room & Seminar Room") and is refused. One found by the
     structured address search keeps its point under no name (`building`).
     A town or district is refused unless the building is named after it
     (the city itself for "Kiki's, Cambridge") or an area was asked for.
     Stations and stops are a point near a place, never a venue.
   - A named OSM feature ends the search. A street, a nameless building or
     a postcode point makes the item `building`; a town or district makes it
     `area` with "<town> (exact place not known)".
   - The key is `venue_key(name)`. If that key or an equivalent name already
     exists, reuse it. A town or district found becomes an **area venue**
     `ven-area--<town>` (a `--` no `venue_key` makes): reached only by that
     key, never by name, never in the model's shortlist, and always `area`.
     Venues created (or placed) from a street or postcode point are kept in
     stage state (`coarseVenues`), so an item reaching one later by key or
     name is `building`, never `exact`.
   - **Coarse venues** (2026-11-24, `locate/venue_class.py`): earlier runs
     made venues of a city's centroid ("Cambridge"), streets ("Wilberforce
     Road", "Downing Street") and regions ("Greater London", "Leuven"), and
     items reaching them by key were posted `exact`. Every known venue with
     an `osmUrl` is classified by its OSM object: from the gazetteer when
     it holds the object, else Nominatim `/lookup` (`osm_ids=W1,N2,R3`, ≤ 50
     a request, one a second, our User-Agent, ≤ 20 requests a run), kept in
     stage state `venueClass` (`{key: {osm, class, type, name, checkedAt}}`)
     and asked again after 90 days; an unanswered (or capped) lookup
     leaves a never-classified venue trusted for that run, and one whose
     answer is past 90 days judged by that old answer until a new one
     comes (metric `venueClassStale`). `place=*` (not a square, a house, a
     farm or an island) and an administrative, political, postal or
     ceremonial `boundary` are an **area**; `highway=*` (not a stop) is a
     **street** (`venue_class.coarse_level`, not the geocoding hits'
     `nominatim.level_of`); a station, an airport, a protected area or
     any other object is a place to go; a venue with no OSM object
     (Camdram's, a society's) is trusted. A venue whose name is the object's *is* the
     town or street: it is reached by key only, never by name, alias or
     overlap and never in the model's shortlist (a building mention such as
     "Trinity Hall" wins over "Cambridge"). Before an item falls back on a
     coarse venue the reply's building (gazetteer, then geocoded when its
     name or OSM query says more than the coarse venue's name), its parent
     and the venue text's gazetteer building are tried. Fallen back on, an
     area gives `area` with "<name> (exact place not known)", a street at
     most `building`. A building the model named that was only placed at
     a street's point keeps its name for matching (`building` at most).
     Places is never asked for an area.
   - Rooms (`matching.clean_room`) hold what the text adds to the venue:
     segments naming the venue itself (its name, its initials such as
     "CMS"), an address (a street, "4-5 Peas Hill", a postcode even cut
     short as "CB2 3P", the town) are dropped: "Bridgetower Room, Trinity
     Hall Cambridge, Trinity Ln" at Trinity Hall is "Bridgetower Room". A
     segment that is the venue's name plus any other word, generic or not,
     is a room and kept ("Trinity College Chapel" at Trinity College).
   - Post the claims (name, address, lat, lng): OpenStreetMap's own values,
     or postcodes.io's coordinates. A source name that reads as a person's
     makes no venue. Where the source names no object, the model's building
     name (and its address, when it carries the placing postcode) is posted
     `llm` / `inferred`, only when it reads as a building's name (≤ 8 words,
     ≤ 80 characters, no honorific, link, postcode or long number, not the
     item's title), every distinctive word of it is in the item's own venue
     text, title, description, organisers or their places (no invented
     names), and the item is no talk and no talks.cam-derived event (G1:
     venues are public site-wide). No `aliases` are posted. Then post `googlePlaceId` from
     Google Places Text Search: `places:searchText`, `X-Goog-FieldMask:
     places.id`, with `locationRestriction` set to the Cambridge rectangle.
     Do this only when the key is configured.
   - Also backfill `googlePlaceId` for existing venues that lack one; at most
     100 Places calls per run. Never for a venue placed outside the Cambridge
     region nor an area venue: the Cambridge-restricted search would give a
     Cambridge place's id.
   - When nothing is found: retry with the LLM-suggested parent building
     (college or department), giving `building` precision. Otherwise the item is
     `unknown` with a note. Only a real answer counts: an outage, error status
     or unreadable body from any service of the chain (or Places) defers the
     item (no row; the next run retries) and is never cached or stamped as
     "not found".
5. Post `locations/batch`.
6. Report metrics: `resolved`, `unknown`, `llmCalls`, `nominatimCalls`,
   `photonCalls`, `postcodesCalls`, `postcodePoints`, `gazetteerHits`,
   `placesCalls`, `newVenues`, `coarseVenues`, `venueClassLookups`,
   `venueClassStale`, `revisitedRows`,
   `modelNamedVenues`, `outsideCambridge` and `unresolvedShare`. Add a note
   when the share is above 2%.
   - Budgets: 1,200 LLM items, 500 Nominatim, 200 Photon, 300 postcodes.io
     calls, 30 minutes.
   - With no `GOOGLE_PLACES_API_KEY`, skip Places with a note. On a dry run,
     read the memo only and make no network calls.

**Coverage, honestly** (`convex/lib/locations.ts` `locationCoverage`): an item
counts as resolved when its row is `exact`, `building`, `area` (which always
carries its `areaLabel`, the server refuses one without) or `online`; an
`unknown` row or no row at all counts as unresolved. The first production run
of `locate_v1` (2026-11-24, 970 upcoming items) left 135 unknown (12.3 %):
away fixtures and tours marked "outside Cambridge", talks whose reply named
a key not in the index, long official names Nominatim missed and society
events with no venue text. `locate_v2`, the geocoding chain and the
organisers' usual places address each of those; what may stay unknown is
an item with nothing to go on (a film shoot with no location, "tba" and no
organiser place).

Plus a `monitor.py` check, `location_unresolved_share` (threshold 0.02, read
from `locations/summary`). It pages on Slack like the other checks: Joshua
promoted it on 2026-11-24 without the D9 shadow baseline (fail fast).

## 3. Item pages
- **Event page** (`/events/[key]` and the side sheet):
  - The "Where" row shows `room, venue name`, then the address in small text.
  - It links "Open in Maps" via `mapsLinks`. If that is missing, the Google
    search link stays as now.
  - It adds a "See on the map" link to `/map?d=<day>`.
  - For `area`: show `areaLabel`. For `unknown`: "Location to be confirmed".
  - JSON-LD Place gets geo from the resolved venue.
- **Talk page** (`/talks/[key]`): the same "Where" treatment, using
  `locations.forItem({kind:"talk"})`. It stays inside /talks.
- **Dashboard**: a "Locations" card with precision bars, the unresolved share
  against the 2% target, and the list of unknown items.

## 4. `/map` page and the G1 boundary
- The server render (`app/(site)/map/page.tsx`) preloads
  `map.day({date, talks: "exclude", talksCam: "exclude"})` only. No talk text
  appears in the HTML or RSC payload.
- After hydration the client re-queries `map.day({date, talks: "include",
  talksCam: "only"})` and merges it, as `useTalksSideEvents` does on /events.
  The talks boundary test must stay green.
- SEO:
  - `/map` (no params) is indexable: put it in `ROUTE_INDEXING` with sitemap
    pages.xml and a link from the footer.
  - `?d=` views are `noindex,follow`, and `"/map?"` goes in the crawl traps.
  - Add `map` to the firewall `UNCACHED_PATHS` if the page reads searchParams.
- CSP: add `https://tiles.openfreemap.org` to `connect-src` and `img-src`.
  Leave `Permissions-Policy: geolocation=()` as it is (no locate-me button).
- DESIGN.md: record MapLibre as the second third-party UI exception (like React
  Flow D10):
  - pin it with `bun add --exact` to a release at least 2 weeks old;
  - load it with `next/dynamic` and `ssr:false` from one molecule
    (`components/molecules/day-map-canvas.tsx`);
  - import only `maplibre-gl/dist/maplibre-gl.css`.
- Map style: OpenFreeMap "positron"-like, recoloured in code.
  - Water is `#d2e4eb` (`--sky-line`), parks `#e8f2f6` tint, roads white on
    `#f4f8fa` land, labels `#545b5e`.
  - Event pins are teal `#1d7a7a` circles; talk pins are ink `#111111` rounded
    squares, numbered when several share a venue.
  - Past pins are `#d5d9db` with `#6e7477` text; the Now ring is `#f29e4c`.
  - Initial bounds: the city centre, zoomed to the day's pins.
- a11y: the canvas has `role="region"` and an `aria-label`. The list is the text
  equivalent. Past and Now are also stated in words, and touch targets are at
  least 44 px. Respect `prefers-reduced-motion` (no flyTo animation).
- E2E: add `/map` to the smoke and a11y PAGES. Stub the tile requests in
  Playwright (`page.route`).
- Analytics: `map_day_changed` (`{direction: prev|next|strip|picker|key|swipe}`)
  and `map_item_opened` (`{kind}`), in the ANALYTICS_EVENTS taxonomy.
