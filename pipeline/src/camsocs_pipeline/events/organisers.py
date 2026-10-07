"""Who organises an event, and which feeds an organisation publishes — read
from the keyed observations already in staging.

Events stages run after `resolve` (stages/__init__.py), so the latest file of
every staging directory holds organisations that already carry their key: the
resolver's ``_resolved`` output and the keyed observations of later stages
(website enrichment adds the feeds it discovers as ``internal`` identifiers,
the `orgInternal` fields). `OrganiserIndex` reads them once per stage and:

- **resolves organiser hints** to organisation keys, deterministically and only
  when the answer is unique: first by a strong identifier the source states
  (Camdram id or slug, SU id or slug, a talks.cam list id, the CUCBC club,
  the Instagram handle, the website domain), then by a college boat club's
  college, then by an exact slug of the name or an alias. Two organisations
  answering to the same identifier or name resolve to neither: a wrong
  organiser is worse than none, and the hint stays in
  ``unresolved_organisers`` for the resolver;
- **resolves venue names** to the venue keys staged so far (exact slug of a
  name or alias);
- **lists the feeds** organisations publish (`FeedRef`): talks.cam lists,
  ICS URLs, Luma calendars, Google calendars and Playwaze ids.

It never mints an organisation key (AGENTS.md: harvesters never do).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from camsocs_pipeline.keys import slugify
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.staging.store import StagingStore

#: `orgInternal` list fields (snake_case, as in `models.wire.OrgInternalPatch`)
#: that name a feed, and the `FeedRef.kind` each becomes.
FEED_FIELDS = {
    "talks_list_ids": "talks",
    "ics_urls": "ics",
    "luma_calendar_ids": "luma",
    "google_calendar_ids": "google",
}


@dataclass(frozen=True)
class FeedRef:
    """One feed an organisation publishes: ``kind`` is talks / ics / luma /
    google / playwaze_community / playwaze_league; ``value`` the id or URL."""

    org_key: str
    kind: str
    value: str


def _slug(text: str | None) -> str | None:
    if not text or not text.strip():
        return None
    try:
        return slugify(text)
    except ValueError:
        return None


def _domain(text: str | None) -> str | None:
    if not text:
        return None
    value = text.strip().lower()
    for prefix in ("https://", "http://"):
        value = value.removeprefix(prefix)
    value = value.split("/")[0].removeprefix("www.")
    return value or None


@dataclass
class OrganiserIndex:
    """See the module docstring. Build with `from_staging` or `add`."""

    _by: dict[str, dict[str, set[str]]] = field(default_factory=dict)
    _venues: dict[str, set[str]] = field(default_factory=dict)
    _org_types: dict[str, str] = field(default_factory=dict)
    _names: dict[str, str] = field(default_factory=dict)
    _feeds: dict[tuple[str, str, str], FeedRef] = field(default_factory=dict)

    # -- building --------------------------------------------------------------------

    @classmethod
    def from_staging(cls, staging: StagingStore) -> OrganiserIndex:
        index = cls()
        for name in staging.directories():
            index.add_all(staging.read_latest(name))
        return index

    def add_all(self, records: Iterable[object]) -> None:
        for record in records:
            if isinstance(record, Observation):
                self.add(record)

    def add(self, observation: Observation) -> None:
        key = observation.entity_key
        if key is None:
            return
        if observation.entity_type == "venue":
            names = [observation.identity.name, *observation.identity.aliases]
            names += _field_strings(observation, "name", "aliases")
            for name in names:
                slug = _slug(name)
                if slug:
                    self._venues.setdefault(slug, set()).add(key)
            return
        if observation.entity_type != "organisation":
            return
        identity = observation.identity
        internal = observation.internal
        self._names.setdefault(key, identity.name)
        if identity.org_type:
            self._org_types[key] = identity.org_type
        for org_type in _field_strings(observation, "orgType"):
            self._org_types[key] = org_type

        def put(kind: str, value: Any) -> None:
            if value is None or value == "":
                return
            self._by.setdefault(kind, {}).setdefault(str(value).strip().lower(), set()).add(key)

        put("camdram_id", identity.camdram_id)
        put("camdram_id", internal.get("camdram_id"))
        put("camdram_slug", identity.camdram_slug)
        put("camdram_slug", internal.get("camdram_slug"))
        put("su_id", identity.su_id)
        put("su_id", internal.get("su_org_id"))
        put("su_slug", identity.su_slug)
        put("su_slug", internal.get("su_slug"))
        put("cucbc_club", _slug(identity.cucbc_club))
        put("cucbc_club", _slug(internal.get("cucbc_club")))
        put("instagram", (identity.instagram_handle or "").lstrip("@") or None)
        put("instagram", (internal.get("instagram_handle") or "").lstrip("@") or None)
        put("domain", _domain(identity.website_domain))
        put("domain", _domain(internal.get("website_domain")))
        for list_id in [*identity.talks_list_ids, *(internal.get("talks_list_ids") or [])]:
            put("talks_list", list_id)
        if identity.org_type == "college_boat_club" and identity.college_hint:
            put("boat_club_college", _slug(identity.college_hint))
        for name in [
            identity.name,
            *identity.aliases,
            *_field_strings(observation, "name", "aliases"),
        ]:
            put("name", _slug(name))

        for internal_field, kind in FEED_FIELDS.items():
            for value in internal.get(internal_field) or []:
                self._add_feed(FeedRef(key, kind, str(value)))
        playwaze = internal.get("playwaze") or {}
        if playwaze.get("community_id"):
            self._add_feed(FeedRef(key, "playwaze_community", str(playwaze["community_id"])))
        for league in playwaze.get("league_ids") or []:
            self._add_feed(FeedRef(key, "playwaze_league", str(league)))

    def _add_feed(self, feed: FeedRef) -> None:
        self._feeds.setdefault((feed.org_key, feed.kind, feed.value), feed)

    # -- reading ---------------------------------------------------------------------

    def _unique(self, kind: str, value: Any) -> str | None:
        if value is None or value == "":
            return None
        keys = self._by.get(kind, {}).get(str(value).strip().lower())
        if keys and len(keys) == 1:
            return next(iter(keys))
        return None

    def resolve(self, hints: IdentityHints) -> str | None:
        """The one organisation `hints` describe, or None (module docstring)."""
        if hints.known_key:
            return hints.known_key
        strong = (
            ("camdram_id", hints.camdram_id),
            ("camdram_slug", hints.camdram_slug),
            ("su_id", hints.su_id),
            ("su_slug", hints.su_slug),
            ("cucbc_club", _slug(hints.cucbc_club)),
            ("instagram", (hints.instagram_handle or "").lstrip("@") or None),
            ("domain", _domain(hints.website_domain)),
            *(("talks_list", list_id) for list_id in hints.talks_list_ids),
        )
        for kind, value in strong:
            key = self._unique(kind, value)
            if key:
                return key
        if hints.org_type == "college_boat_club" and hints.college_hint:
            key = self._unique("boat_club_college", _slug(hints.college_hint))
            if key:
                return key
        for name in (hints.name, *hints.aliases):
            key = self._unique("name", _slug(name))
            if key:
                return key
        return None

    def resolve_venue(self, name: str) -> str | None:
        slug = _slug(name)
        keys = self._venues.get(slug) if slug else None
        return next(iter(keys)) if keys and len(keys) == 1 else None

    def owner_of_talks_list(self, list_id: str) -> str | None:
        return self._unique("talks_list", list_id)

    def org_type(self, key: str) -> str | None:
        return self._org_types.get(key)

    def name_of(self, key: str) -> str | None:
        return self._names.get(key)

    def organisations(self) -> dict[str, str]:
        """Every indexed organisation: key → name."""
        return dict(self._names)

    def feeds(self, *kinds: str) -> list[FeedRef]:
        return sorted(
            (feed for feed in self._feeds.values() if not kinds or feed.kind in kinds),
            key=lambda feed: (feed.kind, feed.value, feed.org_key),
        )

    def __len__(self) -> int:
        return len(self._names)


def _field_strings(observation: Observation, *names: str) -> list[str]:
    """String values of the observation's own field claims (`name`, `aliases`)."""
    values: list[str] = []
    for obs in observation.fields:
        if obs.field not in names or obs.value is None:
            continue
        if isinstance(obs.value, str):
            values.append(obs.value)
        elif isinstance(obs.value, list):
            values.extend(item for item in obs.value if isinstance(item, str))
    return values


__all__ = ["FEED_FIELDS", "FeedRef", "OrganiserIndex"]
