"""The talk record every talk source produces, and its wire form
(docs/talks-redesign-spec.md §3).

The wire form is the one way out to Convex (and the staging file), so the
privacy rule for free text holds here for every source: a personal CRSid
address in an abstract or special message ("email ab123@cam.ac.uk to
register") is withheld (`events.common.redact_personal_emails`, the events
path's rule); role and list addresses stay."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

TalkSourceType = Literal[
    "talks_cam", "dept_ics", "dept_rss", "dept_json", "dept_jsonld", "dept_drupal"
]
TalkKind = Literal["seminar", "lecture", "workshop", "conference", "other"]

SOURCE_TYPES: tuple[str, ...] = (
    "talks_cam",
    "dept_ics",
    "dept_rss",
    "dept_json",
    "dept_jsonld",
    "dept_drupal",
)
KINDS: tuple[str, ...] = ("seminar", "lecture", "workshop", "conference", "other")

# Field caps, mirrored by the server (webapp/convex/talks ingest).
LIMITS = {
    "title": 500,
    "series": 300,
    "venue": 300,
    "abstract": 4000,
    "specialMessage": 1000,
    "speakerName": 200,
    "speakerAffiliation": 300,
}
MAX_SPEAKERS = 10


def talk_key(source_type: str, external_id: str) -> str:
    """``talk-`` + the first 20 hex digits of sha1(``source_type:external_id``)."""
    digest = hashlib.sha1(f"{source_type}:{external_id}".encode()).hexdigest()
    return f"talk-{digest[:20]}"


def clip(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    text = text.strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def ms(dt: datetime) -> int:
    if dt.tzinfo is None:
        raise ValueError("talk times must be timezone-aware")
    return round(dt.timestamp() * 1000)


@dataclass(frozen=True)
class Speaker:
    name: str
    affiliation: str | None = None


@dataclass
class TalkRecord:
    """One talk as one source states it."""

    source_type: str
    #: The sweep scope: ``"talks_cam"`` or ``f"{department_key}#{source_index}"``.
    source: str
    external_id: str
    url: str
    source_url: str
    title: str
    starts_at: datetime
    retrieved_at: datetime
    ends_at: datetime | None = None
    all_day: bool = False
    speakers: list[Speaker] = field(default_factory=list)
    series: str | None = None
    department_keys: list[str] = field(default_factory=list)
    venue: str | None = None
    online: bool = False
    kind: str = "seminar"
    cancelled: bool = False
    abstract: str | None = None
    special_message: str | None = None
    #: talks.cam talk id when known (from talks.cam itself, or a link on a department page);
    #: used for cross-source dedupe.
    talks_cam_id: int | None = None

    @property
    def key(self) -> str:
        return talk_key(self.source_type, self.external_id)

    def to_wire(self) -> dict[str, object]:
        # Here, not at the top: events.common → claims → this module.
        from camsocs_pipeline.events.common import redact_personal_emails

        if self.source_type not in SOURCE_TYPES:
            raise ValueError(f"unknown talk source type {self.source_type!r}")
        if self.kind not in KINDS:
            raise ValueError(f"unknown talk kind {self.kind!r}")
        wire: dict[str, object] = {
            "key": self.key,
            "sourceType": self.source_type,
            "source": self.source,
            "externalId": self.external_id,
            "url": self.url,
            "sourceUrl": self.source_url,
            "title": clip(self.title, LIMITS["title"]) or "Untitled talk",
            "speakers": [
                {
                    k: v
                    for k, v in (
                        ("name", clip(s.name, LIMITS["speakerName"])),
                        ("affiliation", clip(s.affiliation, LIMITS["speakerAffiliation"])),
                    )
                    if v
                }
                for s in self.speakers[:MAX_SPEAKERS]
                if s.name and s.name.strip()
            ],
            "departmentKeys": list(dict.fromkeys(self.department_keys)),
            "startsAt": ms(self.starts_at),
            "allDay": self.all_day,
            "online": self.online,
            "kind": self.kind,
            "cancelled": self.cancelled,
            "retrievedAt": ms(self.retrieved_at),
        }
        optional = {
            "endsAt": ms(self.ends_at) if self.ends_at else None,
            "series": clip(self.series, LIMITS["series"]),
            "venue": clip(self.venue, LIMITS["venue"]),
            "abstract": clip(redact_personal_emails(self.abstract), LIMITS["abstract"]),
            "specialMessage": clip(
                redact_personal_emails(self.special_message), LIMITS["specialMessage"]
            ),
        }
        wire.update({k: v for k, v in optional.items() if v is not None})
        return wire
