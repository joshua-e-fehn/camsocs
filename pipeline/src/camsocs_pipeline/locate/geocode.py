"""The geocoding chain of the `locate` stage (docs/locations-and-map.md §2
step 4, source-research §23): from the building the model names to
coordinates, every one from an open source.

For a place in Cambridge (the model did not flag it as outside):

1. Nominatim free-text search inside the Cambridge box: the model's
   `osm_query`, then "<name>, Cambridge";
2. Nominatim inside the wider Cambridge region (the villages: Great
   Shelford, Hinxton, Madingley), for the `osm_query`;
3. Photon (OSM data, a forgiving index) inside the region, for the name;
4. Nominatim's structured search for the street and postcode;
5. postcodes.io for the postcode: when the structured search found
   nothing, and as a check of a road it found (a road's point further than
   `POSTCODE_AGREE_M` from the postcode's gives way to the postcode's).

(The committed gazetteer of Cambridge's OSM buildings, `gazetteer.py`, is
asked before all of these, by the resolver.)

For a place outside Cambridge (an away fixture, a tour venue, a
conference): the same services without a box, narrowed to the model's
country, and a result must share a word with what was asked and lie in that
country.

A named OSM feature (a building, a club, a hall) ends the search. A street
or postcode point is kept as a coarser answer (`building` precision), and a
settlement or district (`area`) as the coarsest; the best one found is
returned. Only answers count: an outage, a refusal or a spent budget raises
`GeocodeDeferred`, so the item waits for the next run and nothing is
remembered as "not found".
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Literal

from camsocs_pipeline.locate.matching import distinctive, normalise, tokens
from camsocs_pipeline.locate.model import CAMBRIDGE_BOUNDS, CAMBRIDGE_REGION, Bounds, Building
from camsocs_pipeline.locate.nominatim import (
    Nominatim,
    NominatimBlocked,
    NominatimUnavailable,
    OsmPlace,
)
from camsocs_pipeline.locate.photon import Photon, PhotonBlocked, PhotonUnavailable
from camsocs_pipeline.locate.postcodes import (
    Postcodes,
    PostcodesBlocked,
    PostcodesUnavailable,
    find_postcode,
)

#: A street found by the structured search further than this from the
#: postcode's point is not where the building is: the postcode's point is.
POSTCODE_AGREE_M = 250.0

#: How much a hit pins down (`nominatim.Level`, plus a postcode's centroid).
HitLevel = Literal["feature", "street", "postcode", "area"]
_RANK: dict[HitLevel, int] = {"feature": 0, "street": 1, "postcode": 2, "area": 3}

#: Country names the model may write, as ISO 3166-1 alpha-2 codes.
_COUNTRIES = {
    "uk": "gb",
    "united kingdom": "gb",
    "great britain": "gb",
    "britain": "gb",
    "england": "gb",
    "scotland": "gb",
    "wales": "gb",
    "northern ireland": "gb",
    "ireland": "ie",
    "france": "fr",
    "belgium": "be",
    "netherlands": "nl",
    "the netherlands": "nl",
    "germany": "de",
    "switzerland": "ch",
    "austria": "at",
    "italy": "it",
    "spain": "es",
    "portugal": "pt",
    "denmark": "dk",
    "sweden": "se",
    "norway": "no",
    "finland": "fi",
    "poland": "pl",
    "czechia": "cz",
    "czech republic": "cz",
    "greece": "gr",
    "united states": "us",
    "usa": "us",
    "us": "us",
    "canada": "ca",
    "china": "cn",
    "japan": "jp",
    "india": "in",
    "australia": "au",
    # Three-letter codes the listings use ("Bern (CHE)").
    "gbr": "gb",
    "fra": "fr",
    "bel": "be",
    "nld": "nl",
    "deu": "de",
    "che": "ch",
    "aut": "at",
    "ita": "it",
    "esp": "es",
    "irl": "ie",
}


#: The words of the country names above ("united", "kingdom", "belgium").
_COUNTRY_WORDS = frozenset(word for name in _COUNTRIES for word in name.split())


def country_code(text: str | None) -> str | None:
    """ "GB", "Belgium", "BEL" → "gb", "be", "be"; None when not known."""
    if not text:
        return None
    value = text.strip().lower().strip(".")
    if len(value) == 2 and value.isalpha():
        return "gb" if value == "uk" else value
    return _COUNTRIES.get(value)


@dataclass(frozen=True)
class GeoHit:
    """Where a building is, and which open source said so."""

    lat: float
    lng: float
    #: The source's own name of the object (OSM's `name`); None for a
    #: street, a postcode or a nameless building.
    name: str | None
    #: The source's own address, when it gives one.
    address: str | None
    level: HitLevel
    #: The claims' source type: `osm_nominatim` (Nominatim or Photon, both
    #: OSM objects) or `postcodes_io`.
    source_type: str
    #: The object's OSM page, or the postcodes.io lookup.
    source_url: str
    #: Which service answered (the claims' extractor): nominatim, photon, postcodes_io.
    service: str
    #: ISO 3166-1 alpha-2, lower case, when the source says.
    country_code: str | None = None


class GeocodeDeferred(Exception):
    """No answer in this run (an outage, a refusal, a spent budget): the
    item waits for the next run."""

    def __init__(self, service: str, reason: str, *, budget: bool = False) -> None:
        super().__init__(f"{service}: {reason}")
        self.service = service
        self.reason = reason
        self.budget = budget


@dataclass
class GeoBudget:
    nominatim: int = 500
    photon: int = 200
    postcodes: int = 300


def _osm_hit(place: OsmPlace, service: str) -> GeoHit:
    return GeoHit(
        lat=place.lat,
        lng=place.lng,
        name=place.name,
        address=place.address,
        level=place.level,
        source_type="osm_nominatim",
        source_url=place.url,
        service=service,
        country_code=place.country_code,
    )


@dataclass
class Geocoder:
    """The chain over whichever services the run has (None: skipped)."""

    nominatim: Nominatim | None
    photon: Photon | None = None
    postcodes: Postcodes | None = None
    budget: GeoBudget = field(default_factory=GeoBudget)
    #: Whether the run's wall-clock budget is spent.
    out_of_time: Callable[[], bool] = lambda: False
    #: Answers that are a postcode's point (the metric `postcodePoints`).
    postcode_points: int = 0

    @property
    def calls(self) -> dict[str, int]:
        return {
            "nominatim": self.nominatim.calls if self.nominatim else 0,
            "photon": self.photon.calls if self.photon else 0,
            "postcodes": self.postcodes.calls if self.postcodes else 0,
        }

    def locate(self, spec: Building, *, outside: bool = False, area: bool = False) -> GeoHit | None:
        """The best hit for `spec`: a named feature, else a street or postcode
        point, else an area; None when every source answered and found
        nothing. `area`: only an area is wanted (its anchor), so a town or
        district found ends the search too. Raises `GeocodeDeferred` when a
        source gave no answer."""
        name = " ".join((spec.name or "").split())
        query = " ".join((spec.osm_query or "").split())
        address = " ".join((spec.address or "").split())
        postcode = find_postcode(address) or find_postcode(query)
        best: GeoHit | None = None

        bare = outside and _bare_place(spec)

        def keep(hit: GeoHit | None, *, by_address: bool = False) -> bool:
            """Remember `hit` if it is better; True when it ends the search.
            `by_address`: found by the street or postcode (Nominatim's
            structured search), not by the building's name."""
            nonlocal best
            if hit is None:
                return False
            if hit.level == "feature" and not hit.name:
                # A nameless building found by its address: near the place,
                # not confirmed to be it.
                hit = replace(hit, level="street")
            if (
                hit.level == "area"
                and not area
                and not names_match(hit.name, spec, without_address=False)
            ):
                # A town or district the building is not named after (the
                # city itself for "Kiki's, Cambridge"): no answer.
                return False
            if hit.level == "feature" and not names_match(hit.name, spec):
                if not by_address:
                    # A loose match by name ("Seminar Room 1" → "Lee Room &
                    # Seminar Room"): another place, wherever it is.
                    return False
                # Another building at the address asked for: near it, under
                # no name of its own.
                hit = replace(hit, level="street", name=None)
            if outside and not self._plausible(hit, spec, country_code(spec.country)):
                return False
            if bare and hit.level != "area":
                # Only a town was asked for ("Barnes"): a hit of that name
                # is the town, anything else (its station, a pub) is not
                # the venue.
                if not hit.name or normalise(hit.name) != normalise(spec.name or ""):
                    return False
                hit = replace(hit, level="area")
            if best is None or _RANK[hit.level] < _RANK[best.level]:
                best = hit
            return hit.level == "feature" or (area and hit.level == "area")

        if outside:
            code = country_code(spec.country)
            if code is None and postcode:
                code = "gb"
            for text in _unique([query, f"{name}, {address}" if address else None, name]):
                if keep(self._nominatim(text, None, code)):
                    return best
            if name and keep(self._photon(name if not address else f"{name}, {address}", None)):
                return best
        else:
            for text in _unique([query, f"{name}, Cambridge" if name else None]):
                if keep(self._nominatim(text, CAMBRIDGE_BOUNDS, "gb")):
                    return best
            if (query or name) and keep(self._nominatim(query or name, CAMBRIDGE_REGION, "gb")):
                return best
            if name and keep(self._photon(name, CAMBRIDGE_REGION)):
                return best
            code = "gb"
        if best is not None and best.level != "area":
            return best
        street = _street(address, postcode)
        if (street or postcode) and code in (None, "gb"):
            found = self._structured(
                street, postcode, None if outside else CAMBRIDGE_REGION, code or "gb"
            )
            keep(found, by_address=True)
            if best is not None and best.level != "area":
                if postcode and best.level == "street" and best.name:
                    # Nominatim's structured search nearly always answers
                    # with the road, so the postcode was never asked
                    # (postcodesCalls 0 in the 2026-11-24 run). A road's
                    # point is its middle, and the search may match a road
                    # of that name elsewhere: the postcode's point (a dozen
                    # addresses) is the better guess when the two lie far
                    # apart. A building found at the house number stands.
                    # When postcodes.io gives no answer (refused, out of
                    # budget, down), the road stands: never a deferral.
                    try:
                        point = self._postcode(postcode, outside)
                    except GeocodeDeferred:
                        return best
                    if point is not None and metres(best, point) > POSTCODE_AGREE_M:
                        self.postcode_points += 1
                        return point
                return best
        if postcode and code in (None, "gb"):
            point = self._postcode(postcode, outside)
            keep(point)
            if point is not None and best is point:
                self.postcode_points += 1
        return best

    # -- the services -------------------------------------------------------------------

    def _nominatim(self, text: str, box: Bounds | None, code: str | None) -> GeoHit | None:
        if self.nominatim is None or not text:
            return None
        self._check("nominatim", self.nominatim.calls, self.budget.nominatim, self.nominatim)
        try:
            place = self.nominatim.search(text, bounds=box, countrycodes=code)
        except NominatimBlocked as error:
            raise GeocodeDeferred("OpenStreetMap", str(error)) from error
        except NominatimUnavailable as error:
            raise GeocodeDeferred("OpenStreetMap", str(error)) from error
        return _osm_hit(place, "nominatim") if place else None

    def _structured(
        self, street: str | None, postcode: str | None, box: Bounds | None, code: str
    ) -> GeoHit | None:
        if self.nominatim is None:
            return None
        self._check("nominatim", self.nominatim.calls, self.budget.nominatim, self.nominatim)
        try:
            place = self.nominatim.search_structured(
                street=street, postalcode=postcode, bounds=box, countrycodes=code
            )
        except (NominatimBlocked, NominatimUnavailable) as error:
            raise GeocodeDeferred("OpenStreetMap", str(error)) from error
        return _osm_hit(place, "nominatim") if place else None

    def _photon(self, text: str, box: Bounds | None) -> GeoHit | None:
        if self.photon is None or not text:
            return None
        self._check("Photon", self.photon.calls, self.budget.photon, self.photon)
        try:
            place = self.photon.search(text, bounds=box)
        except (PhotonBlocked, PhotonUnavailable) as error:
            raise GeocodeDeferred("Photon", str(error)) from error
        return _osm_hit(place, "photon") if place else None

    def _postcode(self, postcode: str, outside: bool) -> GeoHit | None:
        if self.postcodes is None:
            return None
        self._check("postcodes.io", self.postcodes.calls, self.budget.postcodes, self.postcodes)
        try:
            point = self.postcodes.lookup(postcode)
        except (PostcodesBlocked, PostcodesUnavailable) as error:
            raise GeocodeDeferred("postcodes.io", str(error)) from error
        if point is None:
            return None
        if not outside and not CAMBRIDGE_REGION.contains(point.lat, point.lng):
            return None
        return GeoHit(
            lat=point.lat,
            lng=point.lng,
            name=None,
            address=None,
            level="postcode",
            source_type="postcodes_io",
            source_url=point.url,
            service="postcodes_io",
        )

    def _check(self, service: str, calls: int, limit: int, client: object) -> None:
        if getattr(client, "blocked", False):
            raise GeocodeDeferred(service, "refused this run")
        if calls >= limit or self.out_of_time():
            raise GeocodeDeferred(service, "budget spent", budget=True)

    @staticmethod
    def _plausible(hit: GeoHit, spec: Building, code: str | None) -> bool:
        """A worldwide hit must lie in the country asked for (when both are
        known) and share a word with what was asked (a golf club's search
        may answer a different club's town otherwise)."""
        if hit.level == "postcode":
            return True
        if code and hit.country_code and hit.country_code != code:
            return False
        asked = tokens(" ".join(filter(None, [spec.name, spec.osm_query, spec.address])))
        said = tokens(" ".join(filter(None, [hit.name, hit.address])))
        return bool(asked & said)


def metres(a: GeoHit, b: GeoHit) -> float:
    """The distance between two hits, in metres (equirectangular: fine at a
    city's scale)."""
    lat = math.radians((a.lat + b.lat) / 2)
    dy = (a.lat - b.lat) * 111_320.0
    dx = (a.lng - b.lng) * 111_320.0 * math.cos(lat)
    return math.hypot(dx, dy)


def names_match(found: str | None, spec: Building, *, without_address: bool = True) -> bool:
    """Whether a source's name for a hit shares a distinctive word
    (`matching.distinctive`) with the name or query asked for, not counting
    the town or street of its address ("Wilberforce Road Sports Ground" is
    not the Centre for Mathematical Sciences on Wilberforce Road). A name
    with no distinctive word ("Seminar Room 1") confirms nothing."""
    if not found:
        return False
    asked = distinctive(" ".join(filter(None, [spec.name, spec.osm_query])))
    of_address = tokens(spec.address or "") if without_address else set()
    narrowed = asked - of_address - {"cambridgeshire"}
    asked = narrowed or distinctive(spec.name or "")
    return bool(asked & distinctive(found))


def _bare_place(spec: Building) -> bool:
    """Whether `spec` names only a place, one word and no address ("Barnes",
    "Marlborough"): what a model writes when it knows the town and not the
    ground."""
    if spec.address and spec.address.strip():
        return False
    words = normalise(spec.name or "").split()
    extra = (
        distinctive(spec.osm_query or "")
        - tokens(spec.name or "")
        - tokens(spec.country or "")
        - _COUNTRY_WORDS
    )
    return len(words) == 1 and not extra


def _unique(texts: list[str | None]) -> list[str]:
    out: list[str] = []
    for text in texts:
        if text and text.strip() and text not in out:
            out.append(text)
    return out


def _street(address: str, postcode: str | None) -> str | None:
    """The first segment of an address that starts with a house number or
    names a road ("15 JJ Thomson Avenue")."""
    for part in address.split(","):
        part = part.strip()
        if postcode:
            part = part.replace(postcode, "").strip()
        if part and (part[0].isdigit() or _roadish(part)):
            return part
    return None


def _roadish(text: str) -> bool:
    words = text.lower().split()
    return bool(words) and words[-1] in {
        "road",
        "street",
        "lane",
        "avenue",
        "way",
        "close",
        "drive",
        "place",
        "hill",
        "parade",
        "terrace",
        "row",
        "walk",
        "gardens",
        "green",
        "court",
    }


__all__ = [
    "POSTCODE_AGREE_M",
    "GeoBudget",
    "GeoHit",
    "GeocodeDeferred",
    "Geocoder",
    "HitLevel",
    "country_code",
    "metres",
    "names_match",
]
