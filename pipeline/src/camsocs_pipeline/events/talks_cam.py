"""talks.cam lists → talk events (source-research §6; stage `talks_cam`).

**Parser only — this content never reaches an LLM.** talks.cam's robots.txt
disallows AI agents by name (ClaudeBot, GPTBot, CCBot, …) and asks everyone
else for ``Crawl-delay: 10`` (re-verified 2026-10-07; ``/show/`` is allowed for
``User-agent: *``). Nothing here imports the LLM client, and `claims.llm_field`
refuses a ``talks_list`` source anyway.

**Which lists.** The talks.cam list ids organisations publish (`orgInternal`
``talksListIds``, found by website enrichment and read from staging through
`resolve.lookup.OrgLookup.feeds`), plus `seeds.TALKS_SEEDS`. Each list is fetched once as
``/show/xml/<id>`` with ``seconds_before_today`` / ``seconds_after_today`` set
to the window, at least `CRAWL_DELAY` seconds apart.

**What a talk becomes.** Title, abstract (description), start and end (RFC 2822
with an offset), venue (text), speakers, and the talk's page as `sourceUrl`.
The XML ``organiser`` element is a person's name and is never used. The
organiser is the organisation that owns the list. A talk whose ``series`` is
another list (society lists often include department series) is left out: its
organiser is someone else. A talk titled "CANCELLED…" or whose special message
says it is cancelled is marked ``cancelled`` (a rule, so ``inferred``).

**Speakers** are kept as published (data-model §2 events): ``Name
(Affiliation)`` splits into name and affiliation; several speakers separated by
``;`` become several entries.
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from email.utils import parsedate_to_datetime

from camsocs_pipeline.events.common import (
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    default_window,
    describe_failure,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.events.seeds import TALKS_SEEDS
from camsocs_pipeline.keys import slugify
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup

logger = logging.getLogger(__name__)

BASE = "https://talks.cam.ac.uk"
CRAWL_DELAY = 10.0
MAX_TALKS = 500

SOURCE_TYPE = "talks_list"
EVENT_SOURCE = "talks_cam"
EVIDENCE = "primary"
COVERS = frozenset({"description", "endsAt", "venueText", "speakers"})

_CANCELLED = re.compile(r"\bcancell?ed\b", re.IGNORECASE)
_NO_SPEAKER = frozenset({"", "tbc", "tba", "various", "various speakers", "n/a", "none"})


def list_url(list_id: str) -> str:
    """The stable identity of a list's feed (the fetched URL adds the window)."""
    return f"{BASE}/show/xml/{list_id}"


def fetch_url(list_id: str, window: EventWindow, now: datetime) -> str:
    before = max(0, int((now - window.start).total_seconds()))
    after = max(0, int((window.end - now).total_seconds()))
    return (
        f"{list_url(list_id)}?seconds_before_today={before}"
        f"&seconds_after_today={after}&limit={MAX_TALKS}"
    )


@dataclass
class Talk:
    id: str
    title: str
    start: datetime
    end: datetime | None
    abstract: str | None = None
    speaker: str | None = None
    venue: str | None = None
    url: str | None = None
    series: str | None = None
    special_message: str | None = None


@dataclass
class TalksList:
    id: str | None
    name: str | None
    talks: list[Talk] = field(default_factory=list)
    skipped: int = 0


def _child(element: ET.Element, name: str) -> str | None:
    child = element.find(name)
    if child is None or child.text is None:
        return None
    text = child.text.strip()
    return text or None


def _time(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        moment = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    return moment if moment.tzinfo is not None else None


def parse_list(data: bytes) -> TalksList:
    """Parses ``/show/xml/<id>``. Raises `ValueError` on malformed XML."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        raise ValueError(f"not talks.cam XML: {error}") from error
    parsed = TalksList(id=_child(root, "id"), name=_child(root, "name"))
    for element in root.findall("talk"):
        talk_id, title = _child(element, "id"), _child(element, "title")
        start = _time(_child(element, "start_time"))
        if not talk_id or not title or start is None:
            parsed.skipped += 1
            continue
        url = _child(element, "url")
        parsed.talks.append(
            Talk(
                id=talk_id,
                title=title,
                start=start,
                end=_time(_child(element, "end_time")),
                abstract=_child(element, "abstract"),
                speaker=_child(element, "speaker"),
                venue=_child(element, "venue"),
                url=url if url and url.startswith(("http://", "https://")) else None,
                series=_child(element, "series"),
                special_message=_child(element, "special_message"),
            )
        )
    return parsed


def parse_speakers(text: str | None) -> list[dict[str, str]]:
    speakers: list[dict[str, str]] = []
    for part in (text or "").split(";"):
        part = " ".join(part.split())
        if part.lower() in _NO_SPEAKER:
            continue
        match = re.fullmatch(r"(?P<name>[^()]+?)\s*\((?P<affiliation>[^()]+)\)", part)
        if match:
            speakers.append(
                {"name": match["name"].strip(), "affiliation": match["affiliation"].strip()}
            )
        else:
            speakers.append({"name": part})
    return speakers


def _same_series(series: str | None, list_name: str | None) -> bool:
    if not series or not list_name:
        return True
    try:
        return slugify(series) == slugify(list_name)
    except ValueError:
        return series.strip().lower() == list_name.strip().lower()


def talk_drafts(
    parsed: TalksList, owner: IdentityHints | None, tally: Tally | None = None
) -> list[EventDraft]:
    drafts: list[EventDraft] = []
    for talk in parsed.talks:
        if not _same_series(talk.series, parsed.name):
            if tally is not None:
                tally.drop("talks from another list's series")
            continue
        cancelled = bool(
            talk.title.upper().startswith(("CANCELLED", "CANCELED"))
            or (talk.special_message and _CANCELLED.search(talk.special_message))
        )
        drafts.append(
            EventDraft(
                event_source=EVENT_SOURCE,
                external_id=talk.id,
                title=talk.title,
                starts_at=talk.start,
                ends_at=talk.end,
                description=talk.abstract,
                page_url=talk.url,
                venue=IdentityHints(name=talk.venue) if talk.venue else None,
                speakers=parse_speakers(talk.speaker),
                event_type="talk",
                cancelled=True if cancelled else None,
                inferred={"cancelled"} if cancelled else set(),
                organisers=[OrganiserObs(identity=owner, role="organiser")] if owner else [],
                covers=COVERS,
            )
        )
    return drafts


def _lists(index: OrgLookup) -> dict[str, IdentityHints]:
    """List id → its owner, from staging first, then the seeds."""
    lists: dict[str, IdentityHints] = {}
    for feed in index.feeds("talks"):
        owner = index.owner_of_talks_list(feed.value)
        if owner:
            lists[feed.value] = IdentityHints(
                name=index.name_of(owner) or owner, known_key=owner, talks_list_ids=[feed.value]
            )
    for seed in TALKS_SEEDS:
        lists.setdefault(
            seed.list_id, seed.owner.model_copy(update={"talks_list_ids": [seed.list_id]})
        )
    return lists


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    now = now or datetime.now(window.start.tzinfo)
    index = OrgLookup.for_stage(ctx)
    lists = _lists(index)
    if ctx.limit is not None:
        lists = dict(list(lists.items())[: ctx.limit])
    tally = Tally()
    pending: list[Sourced] = []
    read = 0
    with polite_client(ctx.settings, min_interval=CRAWL_DELAY) as client:
        for list_id, owner in lists.items():
            result = client.fetch(
                fetch_url(list_id, window, now), accept="application/xml,text/xml"
            )
            if not result.ok or result.content is None:
                ctx.report.notes.append(f"list {list_id}: {describe_failure(result)}")
                continue
            try:
                parsed = parse_list(result.content)
            except ValueError as error:
                ctx.report.notes.append(f"list {list_id}: {error}")
                continue
            read += 1
            if parsed.skipped:
                tally.drop("unreadable talks", parsed.skipped)
            pending.extend(
                Sourced(draft, list_url(list_id), result)
                for draft in talk_drafts(parsed, owner, tally)
            )
    records = observations_from(
        pending,
        window,
        tally,
        source_type=SOURCE_TYPE,
        evidence=EVIDENCE,
        index=index,
        crawl_delay=True,
        now=now,
    )
    ctx.report.notes.append(f"{read} of {len(lists)} talks.cam lists read")
    write_staging(ctx, records, tally)


__all__ = [
    "Talk",
    "TalksList",
    "fetch_url",
    "list_url",
    "parse_list",
    "parse_speakers",
    "run",
    "talk_drafts",
]
