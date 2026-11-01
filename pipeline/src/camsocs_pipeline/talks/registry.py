"""The verified department registry (``departments.json``, spec §2)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

REGISTRY_PATH = Path(__file__).with_name("departments.json")

SCHOOLS: tuple[str, ...] = (
    "arts_humanities",
    "humanities_social_sciences",
    "biological_sciences",
    "clinical_medicine",
    "physical_sciences",
    "technology",
    "other",
)
SOURCE_KINDS: tuple[str, ...] = ("ics", "rss", "json_api", "json_ld", "drupal_uis")

_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_LIST_ID = re.compile(r"^\d+$")


@dataclass(frozen=True)
class DepartmentSource:
    kind: str
    url: str
    label: str
    checked: str


@dataclass(frozen=True)
class Department:
    key: str
    slug: str
    name: str
    short_name: str
    school: str
    website: str
    aliases: tuple[str, ...] = ()
    venue_hints: tuple[str, ...] = ()
    talks_cam_list_ids: tuple[str, ...] = ()
    sources: tuple[DepartmentSource, ...] = field(default_factory=tuple)

    def to_wire(self) -> dict[str, object]:
        return {
            "key": self.key,
            "slug": self.slug,
            "name": self.name,
            "shortName": self.short_name,
            "school": self.school,
            "website": self.website,
            "aliases": list(self.aliases),
        }


class RegistryError(ValueError):
    pass


def parse_registry(raw: object) -> list[Department]:
    if not isinstance(raw, list):
        raise RegistryError("departments.json must be a JSON array")
    seen_keys: set[str] = set()
    seen_slugs: set[str] = set()
    seen_lists: dict[str, str] = {}
    out: list[Department] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise RegistryError(f"entry {i} is not an object")
        try:
            slug = entry["slug"]
            dept = Department(
                key=entry["key"],
                slug=slug,
                name=entry["name"],
                short_name=entry.get("shortName") or entry["name"],
                school=entry["school"],
                website=entry.get("website", ""),
                aliases=tuple(entry.get("aliases", [])),
                venue_hints=tuple(entry.get("venueHints", [])),
                talks_cam_list_ids=tuple(str(x) for x in entry.get("talksCamListIds", [])),
                sources=tuple(
                    DepartmentSource(
                        kind=s["kind"],
                        url=s["url"],
                        label=s.get("label", ""),
                        checked=s.get("checked", ""),
                    )
                    for s in entry.get("sources", [])
                ),
            )
        except KeyError as e:
            raise RegistryError(f"entry {i} lacks {e.args[0]!r}") from e
        if not _SLUG.match(slug) or dept.key != f"dept-{slug}":
            raise RegistryError(
                f"entry {i}: key must be dept-<slug> with a kebab slug ({dept.key!r})"
            )
        if dept.school not in SCHOOLS:
            raise RegistryError(f"{dept.key}: unknown school {dept.school!r}")
        if dept.key in seen_keys or slug in seen_slugs:
            raise RegistryError(f"{dept.key}: duplicate key or slug")
        for list_id in dept.talks_cam_list_ids:
            if not _LIST_ID.match(list_id):
                raise RegistryError(f"{dept.key}: talks.cam list id {list_id!r} is not numeric")
            if list_id in seen_lists:
                raise RegistryError(
                    f"talks.cam list {list_id} is on {seen_lists[list_id]} and {dept.key}"
                )
            seen_lists[list_id] = dept.key
        for src in dept.sources:
            if src.kind not in SOURCE_KINDS:
                raise RegistryError(f"{dept.key}: unknown source kind {src.kind!r}")
            if not src.url.startswith("https://") and not src.url.startswith("http://"):
                raise RegistryError(f"{dept.key}: source url {src.url!r} is not http(s)")
        seen_keys.add(dept.key)
        seen_slugs.add(slug)
        out.append(dept)
    return out


def load_registry(path: Path = REGISTRY_PATH) -> list[Department]:
    return parse_registry(json.loads(path.read_text(encoding="utf-8")))
