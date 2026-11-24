"""Location resolution for events and talks (stage `locate`,
docs/locations-and-map.md §2, source-research §23, decision D13).

- `model`: the wire shapes of the `locations/*` and `venues/all` routes, the
  model's reply, and the Cambridge bounds;
- `matching`: normalised venue names, the deterministic rules, the venue
  shortlist the model sees and the input hash;
- `gazetteer`: the committed Cambridge gazetteer (OSM buildings via Overpass,
  `data/cambridge_places.json`, built by `gazetteer_build`, plus curated
  aliases in `data/cambridge_aliases.json`), asked before Nominatim;
- `nominatim`: OpenStreetMap Nominatim search (coordinates, ODbL);
- `places`: Google Places Text Search for place ids only;
- `resolver`: the run itself, from pending items to venue claims and
  `itemLocations` rows.
"""
