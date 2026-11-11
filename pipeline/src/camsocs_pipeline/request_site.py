"""The request agent's site check (ENG-158): what the scraper would find on
the site a listing request points to, before the broker confirms.

A draft that names the society's events page (`request_agent.py`,
`events_url`) gets a check: Convex hands out the home page it derived from
that link (`POST /api/pipeline/requests/pending`, `checks`), and this module
reads the site exactly as the scraper will once the plan is confirmed:

1. the home page, with the general purpose: robots.txt holds without the
   society override, and so do the never-fetch and skip hosts of
   `sources/policy.py` and `websites/enrich.py`;
2. whether the site is shown to be this listing's own (only then is it read
   further: a site nothing ties to the listing is a stranger's until the
   broker confirms it, and its text never reaches the model): it links one of the
   listing's social accounts (the strongest tie: a register states those),
   or `enrich.own_site` says so (it names Cambridge or a college, or its host
   carries the society's name);
3. the upcoming events the daily `website_events` stage would read from it
   (`websites.events.read_site`: structured data first, then the model with
   its dated-quote checks, a few card images at most).

The outcome goes to `POST /api/pipeline/requests/check`: titles, dates and
venues of a public page, never a log line. Nothing is staged and nothing
reaches the listing: the check reads into a temporary cache that is thrown
away, because the agent's unit may not write the harvest's.
"""

from __future__ import annotations

import logging
import re
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from camsocs_pipeline.config import Settings
from camsocs_pipeline.extract.events import CallBudget
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.extract.when import TermCalendar
from camsocs_pipeline.models.observation import EventObservation
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.links import host_of
from camsocs_pipeline.sources.policy import GENERAL
from camsocs_pipeline.sources.websites import enrich
from camsocs_pipeline.sources.websites import events as website_events
from camsocs_pipeline.sources.websites.page import Page
from camsocs_pipeline.sources.websites.site import Target

logger = logging.getLogger(__name__)

#: Events shown to the broker at most (Convex cuts again).
MAX_EVENTS = 12
#: Model calls for card images in one check.
CARD_CALLS = 3


class Poster(Protocol):
    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]: ...


def _bare(url: str) -> str:
    """A link compared without scheme, ``www.``, query or trailing slash."""
    text = re.sub(r"^https?://(www\.)?", "", url.strip().lower())
    return re.split(r"[?#]", text, maxsplit=1)[0].rstrip("/")


def tied_by(page: Page, socials: list[str]) -> str | None:
    """How `page` is tied to the listing: the listing's social account it
    links, by host ("links the listing's instagram.com account"), or None."""
    linked = {_bare(link.url) for link in page.links}
    for social in socials:
        bare = _bare(social)
        # An account, not a network's front page: host and a path.
        if "/" in bare and bare in linked:
            return f"links the listing's {host_of(social).removeprefix('www.')} account"
    return None


def event_facts(record: EventObservation) -> dict[str, Any] | None:
    """Title, start (epoch ms) and venue of one read event, or None."""
    values = {obs.field: obs.value for obs in record.fields}
    title, starts = values.get("title"), values.get("startsAt")
    if not isinstance(title, str) or not isinstance(starts, (int, float)):
        return None
    venue = values.get("venueText")
    return {
        "title": title,
        "startsAt": int(starts),
        **({"venue": venue} if isinstance(venue, str) and venue else {}),
    }


def upcoming(records: list[EventObservation]) -> list[dict[str, Any]]:
    facts = [fact for fact in map(event_facts, records) if fact is not None]
    return sorted(facts, key=lambda fact: fact["startsAt"])


def check_site(
    check: dict[str, Any],
    client: PoliteClient,
    *,
    llm: LLMClient | None,
    memo: LLMMemo | None,
    now: datetime,
) -> dict[str, Any]:
    """One site check, as `requests/check` takes it."""
    key, website = check["key"], check["website"]
    base = {"key": key, "website": website}
    host = urlsplit(website).hostname or ""
    if enrich._skipped_host(website) or host.endswith(".") or urlsplit(website).port is not None:
        return {**base, "ok": False, "error": "a host that is never read as a society's site"}
    # Before the broker has confirmed anything the site is a stranger's: the
    # home page is fetched with the general purpose, so its robots.txt holds
    # (the society override of decision D3 is for a society's own site).
    home = enrich._fetch(client, "home", website, GENERAL)
    if home.page is None:
        return {**base, "ok": False, "error": home.result.outcome}
    if enrich._skipped_host(home.url):
        return {**base, "ok": False, "error": f"leads to {host_of(home.url)}"}
    target = Target(
        key=check["orgKey"],
        name=check["name"],
        aliases=list(check.get("aliases") or []),
        website=website,
    )
    tie = tied_by(home.page, list(check.get("socials") or []))
    own = tie is not None or enrich.own_site(target, home.page)
    if not own:
        # Nothing ties the site to the listing: it is not read further, and
        # its text never reaches the model, until the broker confirms it.
        return {
            **base,
            "ok": True,
            "ownSite": False,
            "pages": 0,
            "eventCount": 0,
            "events": [],
            "notes": ["not shown to be the society's own site, so its events were not read"],
        }
    read = website_events.read_site(
        client,
        website_events.Site(
            target.key,
            target.name,
            home.url,
            # The page the request names is read even if the home page does
            # not link it (on the site itself only).
            extra_pages=tuple(
                page
                for page in [check.get("eventsUrl")]
                if isinstance(page, str)
                and (urlsplit(page).hostname or "").removeprefix("www.")
                == (urlsplit(home.url).hostname or "").removeprefix("www.")
            ),
        ),
        llm=llm,
        memo=memo,
        calendar=TermCalendar.default(),
        now=now,
        budget=CallBudget(CARD_CALLS),
    )
    events = upcoming(read.events)
    return {
        **base,
        "ok": True,
        "ownSite": True,
        "tiedBy": tie or "names Cambridge, a college or the society",
        "pages": read.pages,
        "eventCount": len(events),
        "events": events[:MAX_EVENTS],
        # The reader's notes name the listing's key and a page, never a person.
        "notes": [note.split(": ", 1)[-1] for note in read.notes][:6],
    }


@dataclass
class CheckCounts:
    offered: int = 0
    checked: int = 0
    failed: int = 0

    def line(self) -> str:
        return f"{self.offered} sites offered, {self.checked} read, {self.failed} failed"


def run_site_checks(
    loader: Poster,
    checks: list[dict[str, Any]],
    settings: Settings,
    llm: LLMClient | None,
    *,
    now: datetime | None = None,
) -> CheckCounts:
    """Reads each site Convex offered and posts what it found. A check that
    raises is posted as failed (Convex offers it again later, three tries)."""
    counts = CheckCounts(offered=len(checks))
    if not checks:
        return counts
    now = now or datetime.now(UTC)
    with tempfile.TemporaryDirectory(prefix="camsocs-request-") as scratch:
        cache = Path(scratch)
        with PoliteClient(
            user_agent=settings.require_user_agent(),
            cache_dir=cache / "http",
            min_interval=settings.min_host_interval,
            max_retries=1,
        ) as client:
            for check in checks:
                try:
                    payload = check_site(
                        check, client, llm=llm, memo=LLMMemo(cache / "llm"), now=now
                    )
                except Exception as error:  # reported by class, tried again later
                    logger.warning("site check failed (%s)", type(error).__name__)
                    payload = {
                        "key": check["key"],
                        "website": check["website"],
                        "ok": False,
                        "error": type(error).__name__,
                    }
                loader.post("requests/check", payload)
                if payload["ok"]:
                    counts.checked += 1
                else:
                    counts.failed += 1
    return counts
