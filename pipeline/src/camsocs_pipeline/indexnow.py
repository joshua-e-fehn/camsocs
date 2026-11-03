"""IndexNow: after a load, tell the search engines that share it (Bing,
Yandex, Seznam, Naver …) which public camsocs pages changed (SEO audit
2026-11-02, search-console-bing-indexnow; owner decision G15).

Bing's index feeds ChatGPT search, Copilot and DuckDuckGo, so a new domain is
discovered much sooner when it says what changed instead of waiting for a
crawl. One POST to ``api.indexnow.org`` per run carries every changed URL (at
most `MAX_URLS` a request).

**Which URLs.** Only pages a search engine may index and that hold no
talks.cam content (G1). The site's own sitemaps are the judge (review of the
SEO audit 2026-11-02, indexnow-pipeline): before a ping the run reads
``<site>/sitemaps/societies.xml`` and ``<site>/sitemaps/events.xml``
(`SITEMAP_FILES`, the files `webapp/lib/sitemap.ts` serves) and pings only
the candidates listed there. It reads them past the edge cache (`_fresh_url`):
the cached copy is up to an hour old, and with ``stale-while-revalidate`` a
day older still, so it would never list a page this run created. Convex
builds those files from the stored rows,
so they leave out what this run cannot see: a thin profile (noindex, G3), a
broker-hidden listing or a counterpart without a page, and an event whose
talks.cam provenance was posted by an earlier run (its ``/events/<key>``
answers 308 into ``/talks``). The candidates, a cheap first pass over the
claims posted:

- ``/societies/<slug>`` for every organisation the load posted claims for
  (the slug is its key without ``org-``, `keys.org_slug_from_key`);
- ``/events/<key>`` for an event whose every reading is ``public`` and none
  of whose readings comes from talks.cam (its source, the page it was read
  on, a link it carries, or a description that names talks.cam), and that
  the events sitemap would list by its times: it starts today (London) or
  later, or it is a multi-day event still running (`_listable_by_time`, as
  ``webapp/convex/sitemap.ts`` ``events``). An event that has ended is never
  listed, so it is no candidate: the load posts it every day, and it would
  otherwise count as changed, unlisted, on every run.

Never a ``/talks`` URL: the talks pillar posts its own tables (`stages/talks`)
and never passes through here, and both passes keep talks.cam-sourced society
events out as well.

**Which changed.** The server answers a claims batch with counts, not keys,
so the run keeps a digest of what it posted for each URL (the fields and
values, without retrieval times or quotes) in a small JSON file next to the
run state (`state_path_for`). A URL is pinged when its digest differs from
the last one pinged. The first run pings every URL once, which is what a new
domain wants. The file is written only after the engines accepted the ping,
so a failed ping is repeated by the next run. A changed URL the sitemaps do
not list (a thin or hidden profile, an event Convex sends to /talks) is not
sent and keeps its old digest, so it goes out on a run whose sitemaps list it,
if one ever does.

**Off unless configured.** ``INDEXNOW_SITE_URL`` names the public origin
(``https://camsocs.uk`` in ``pipeline/.env.prod``). Unset, nothing is sent:
the dev deployment's data is not the site's. A dry run reports what it would
send and sends nothing.

**Never in the way.** A failed ping, or a sitemap that cannot be read (then
nothing is sent and no digest moves), is a note on the load stage, not a
failure: the load already succeeded, and the next run tries again.

The key is public by design: the engines verify it by fetching
``<site>/<key>.txt`` (`webapp/public/`, asserted by the tests).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from camsocs_pipeline.claims import epoch_ms
from camsocs_pipeline.events.common import london_midnight, london_today
from camsocs_pipeline.keys import org_slug_from_key
from camsocs_pipeline.models.wire import ClaimInput

logger = logging.getLogger(__name__)

#: The site's IndexNow key; `webapp/public/<key>.txt` holds it verbatim.
INDEXNOW_KEY = "7f2f4b626860a11fe6a3872ac4091d93"

#: The shared endpoint: every participating engine receives what it is sent.
ENDPOINT = "https://api.indexnow.org/indexnow"

#: The protocol's limit per request.
MAX_URLS = 10_000

#: An event longer than this covers several days, and the events sitemap
#: lists it while it runs (``webapp/lib/calendar.ts`` ``MULTI_DAY_MS``).
MULTI_DAY_MS = 25 * 60 * 60 * 1000

#: Seconds before a ping is given up (the next run retries).
TIMEOUT = 20.0

#: Hosts whose content never reaches a URL outside /talks (G1).
TALKS_HOSTS = ("talks.cam.ac.uk",)

#: Claim source types that are talks.cam (`talks_list`: a talks.cam list
#: read for a society's events, `cleanup.py`).
TALKS_SOURCE_TYPES = frozenset({"talks_list"})

#: Event fields that hold a link; a talks.cam one marks the event as talks-derived.
_EVENT_LINK_FIELDS = ("sourceUrl", "externalUrl", "bookingUrl")

#: A talks.cam URL in free text, as `webapp/lib/talks-boundary.ts` reads a
#: description (``TALKS_CAM_IN_TEXT``).
_TALKS_IN_TEXT = re.compile(r"\btalks\.cam\.ac\.uk\b", re.IGNORECASE)

#: The sitemap files that list the pages a ping may name (`webapp/lib/sitemap.ts`
#: ``SITEMAP_FILES``; ``pages.xml`` holds no page a load changes).
SITEMAP_FILES = ("societies.xml", "events.xml")

_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

#: Claim parts that change on every run without the page changing.
_VOLATILE = ("retrieved_at", "evidence_quote", "quote_check", "content_sha256", "source_key")

Post = Callable[[str, dict[str, Any]], int]

#: GET a URL and return its body; raises when the answer is not a 200.
Fetch = Callable[[str], str]


def state_path_for(run_state_path: Path) -> Path:
    """The digest file beside the run's own state, so each environment
    (`.camsocs-state.prod.json`) keeps its own."""
    return run_state_path.with_name(f"{run_state_path.stem}.indexnow.json")


def _is_talks_host(url: object) -> bool:
    if not isinstance(url, str):
        return False
    host = (urlsplit(url).hostname or "").lower()
    return any(host == talks or host.endswith(f".{talks}") for talks in TALKS_HOSTS)


def _talks_derived(claims: Sequence[ClaimInput]) -> bool:
    for claim in claims:
        if claim.source_type in TALKS_SOURCE_TYPES or _is_talks_host(claim.source_url):
            return True
        if claim.field == "source" and claim.value == "talks_cam":
            return True
        if claim.field in _EVENT_LINK_FIELDS and _is_talks_host(claim.value):
            return True
        # A description that links a talk (review of the SEO audit,
        # indexnow-pipeline): Convex sends such an event to /talks.
        if (
            claim.field == "description"
            and isinstance(claim.value, str)
            and _TALKS_IN_TEXT.search(claim.value)
        ):
            return True
    return False


def _public(claims: Sequence[ClaimInput]) -> bool:
    """Every visibility reading says ``public`` (the server keeps the
    strictest), and there is at least one."""
    readings = [claim.value for claim in claims if claim.field == "visibility"]
    return bool(readings) and all(value == "public" for value in readings)


def _latest(claims: Sequence[ClaimInput], field: str) -> float | None:
    values = [c.value for c in claims if c.field == field and isinstance(c.value, int | float)]
    return max(values) if values else None


def _listable_by_time(claims: Sequence[ClaimInput], now_ms: int) -> bool:
    """Whether the events sitemap would list the event by its times
    (``webapp/convex/sitemap.ts`` ``events``): it starts from London midnight
    today on, or it covers several days and has not ended. The latest reading
    of each counts; an event with no start time read is left to the sitemap."""
    starts = _latest(claims, "startsAt")
    if starts is None:
        return True
    today = london_midnight(london_today(datetime.fromtimestamp(now_ms / 1000, UTC)))
    if starts >= epoch_ms(today):
        return True
    ends = _latest(claims, "endsAt")
    return ends is not None and ends - starts > MULTI_DAY_MS and ends > now_ms


def _path(entity_type: str, key: str, claims: Sequence[ClaimInput], now_ms: int) -> str | None:
    if entity_type == "organisation":
        try:
            return f"/societies/{org_slug_from_key(key)}"
        except ValueError:
            return None
    if entity_type == "event":
        if _talks_derived(claims) or not _public(claims) or not _listable_by_time(claims, now_ms):
            return None
        return f"/events/{key}"
    return None


def _digest(claims: Sequence[ClaimInput]) -> str:
    rows = sorted(
        json.dumps(claim.model_dump(mode="json", exclude=set(_VOLATILE)), sort_keys=True)
        for claim in claims
    )
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()


def page_digests(claims: Iterable[ClaimInput], *, now_ms: int) -> dict[str, str]:
    """Site-relative path → digest of what was posted for that page, for
    every public page the claims touch (see the module docstring)."""
    by_entity: dict[tuple[str, str], list[ClaimInput]] = defaultdict(list)
    for claim in claims:
        by_entity[(claim.entity_type, claim.entity_key)].append(claim)
    digests: dict[str, str] = {}
    for (entity_type, key), entity_claims in by_entity.items():
        path = _path(entity_type, key, entity_claims, now_ms)
        if path is not None:
            digests[path] = _digest(entity_claims)
    return digests


def changed_paths(digests: dict[str, str], previous: dict[str, str]) -> list[str]:
    """Paths whose digest is new or differs from the last one pinged, sorted."""
    return sorted(path for path, digest in digests.items() if previous.get(path) != digest)


def _load(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        logger.warning("Could not read %s (%s): every page counts as changed", path, error)
        return {}
    pages = data.get("pages") if isinstance(data, dict) else None
    return {str(k): str(v) for k, v in pages.items()} if isinstance(pages, dict) else {}


def _save(path: Path, pages: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps({"pages": pages}, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def site_origin(value: str) -> str | None:
    """``https://host`` from INDEXNOW_SITE_URL, or None when it is not a bare
    https origin (a path or query would not be the key's location)."""
    parts = urlsplit(value.strip().rstrip("/"))
    if parts.scheme != "https" or not parts.hostname or parts.path or parts.query:
        return None
    return f"https://{parts.netloc}"


def sitemap_paths(xml_text: str) -> set[str]:
    """The site-relative paths a sitemap's ``<loc>`` entries name. Raises
    ``ET.ParseError`` on a body that is not XML."""
    root = ET.fromstring(xml_text)
    paths: set[str] = set()
    for loc in root.iter(f"{_SITEMAP_NS}loc"):
        text = (loc.text or "").strip()
        if text:
            paths.add(urlsplit(text).path or "/")
    return paths


def _fresh_url(origin: str, name: str, now_ms: int) -> str:
    """A sitemap's URL that misses the edge cache (review of the SEO audit
    2026-11-02, indexnow-edge-cached-sitemap): Vercel keys its cache on the
    query string, and the route ignores it, so each run reads what Convex
    holds now, at one page walk per file per run."""
    return f"{origin}/sitemaps/{name}?fresh={now_ms}"


def _listed_paths(origin: str, fetch: Fetch, now_ms: int) -> set[str]:
    listed: set[str] = set()
    for name in SITEMAP_FILES:
        listed |= sitemap_paths(fetch(_fresh_url(origin, name, now_ms)))
    return listed


def _http_fetch(user_agent: str) -> Fetch:
    def fetch(url: str) -> str:
        with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": user_agent}) as client:
            response = client.get(url)
            # A 503 is the route's backend failure, never a partial file.
            if response.status_code != 200:
                raise httpx.HTTPStatusError(
                    f"HTTP {response.status_code}", request=response.request, response=response
                )
            return response.text

    return fetch


def _http_post(user_agent: str) -> Post:
    def post(url: str, body: dict[str, Any]) -> int:
        with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": user_agent}) as client:
            return client.post(url, json=body).status_code

    return post


@dataclass
class PingResult:
    """What one `ping_changed` call did, as the load stage's note."""

    note: str
    sent: int = 0


def ping_changed(
    claims: Iterable[ClaimInput],
    *,
    site_url: str,
    state_path: Path,
    user_agent: str,
    dry_run: bool = False,
    post: Post | None = None,
    fetch: Fetch | None = None,
    now_ms: int | None = None,
) -> PingResult:
    """Pings IndexNow with the public pages whose posted claims changed since
    the last accepted ping and that the site's sitemaps list, and remembers
    them. Never raises."""
    try:
        origin = site_origin(site_url) if site_url else None
        if not site_url:
            return PingResult("IndexNow: not configured (INDEXNOW_SITE_URL), nothing sent")
        if origin is None:
            return PingResult("IndexNow: INDEXNOW_SITE_URL is not an https origin, nothing sent")
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        digests = page_digests(claims, now_ms=now)
        previous = _load(state_path)
        changed = changed_paths(digests, previous)
        if not changed:
            return PingResult("IndexNow: no public page changed")
        if dry_run:
            # No request at all, the sitemaps included: they may list fewer.
            return PingResult(
                f"IndexNow: would ping up to {len(changed)} changed pages, those the "
                "sitemaps list (dry run)"
            )
        try:
            listed = _listed_paths(origin, fetch or _http_fetch(user_agent), now)
        except Exception as error:
            logger.debug("IndexNow sitemap read failed", exc_info=True)
            return PingResult(
                f"IndexNow: sitemaps unavailable ({type(error).__name__}), nothing sent; "
                "the next run retries"
            )
        paths = [path for path in changed if path in listed]
        if not paths:
            return PingResult(
                f"IndexNow: {len(changed)} changed pages, none in the sitemaps yet; nothing sent"
            )
        send = post or _http_post(user_agent)
        host = urlsplit(origin).netloc
        for start in range(0, len(paths), MAX_URLS):
            chunk = paths[start : start + MAX_URLS]
            status = send(
                ENDPOINT,
                {
                    "host": host,
                    "key": INDEXNOW_KEY,
                    "keyLocation": f"{origin}/{INDEXNOW_KEY}.txt",
                    "urlList": [f"{origin}{path}" for path in chunk],
                },
            )
            # 200 OK and 202 Accepted (key validation pending) both mean received.
            if status not in (200, 202):
                return PingResult(
                    f"IndexNow: ping refused (HTTP {status}); the next run retries "
                    f"{len(paths)} pages",
                    sent=start,
                )
        # Only what was sent moves on: an unlisted page keeps its old digest.
        _save(state_path, {**previous, **{path: digests[path] for path in paths}})
        unlisted = len(changed) - len(paths)
        held = f" ({unlisted} not in the sitemaps, not sent)" if unlisted else ""
        return PingResult(f"IndexNow: pinged {len(paths)} changed pages{held}", sent=len(paths))
    except Exception as error:
        logger.debug("IndexNow ping failed", exc_info=True)
        return PingResult(f"IndexNow: ping failed ({type(error).__name__}); the next run retries")


__all__ = [
    "ENDPOINT",
    "INDEXNOW_KEY",
    "MAX_URLS",
    "SITEMAP_FILES",
    "Fetch",
    "PingResult",
    "changed_paths",
    "page_digests",
    "ping_changed",
    "site_origin",
    "sitemap_paths",
    "state_path_for",
]
