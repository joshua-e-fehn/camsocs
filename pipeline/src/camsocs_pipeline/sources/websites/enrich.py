"""Enriching resolved organisations from their own website and Linktree (T5).

Source-research §13 (Linktree), §14 (society websites), §11 (feeds found
there), §15 (ticketing links only). For each resolved organisation with a
website and/or a Linktree:

1. **Fetch politely** (`sources/base.py`: robots.txt, one request in flight
   per host, Crawl-delay, the raw cache; pages younger than `FRESH_FOR` are
   read from the cache). Hosts are processed concurrently; sites on one
   shared host (``*.srcf.net``, ``*.cam.ac.uk``) one after another.
2. Read the home page, then at most one page per kind — about, join,
   committee, contact, events, sponsors (`discover.py`) — inside the site.
   ``noindex`` pages yield no content; ``nofollow`` stops the discovery; a
   site that does not mention the organisation (a parked domain) yields only
   its health.
3. **Deterministically**: JSON-LD ``sameAs`` and links → socials; ``mailto:``
   and written addresses → role emails / the general email (never personal
   addresses, never decoded obfuscation); ICS / Google Calendar / Luma /
   talks.cam / Camdram / ticketing links → ``orgInternal`` feeds; mailing-list
   sign-up links; join and termcard links; the final URL → ``website``; HTTP
   status and platform → ``orgInternal.websiteHealth``.
4. **LLM** (bulk model, prompt ``org_v1``) over the cleaned text of those
   pages (≤ 12k characters) → `extract.org.OrgExtraction`. Every value's
   quote is checked against the page text (`extract.evidence`) and the value
   is attributed to the page that holds it; without a verbatim quote it is
   ``inferred``. Sessions, people and partners — which create rows — are kept
   only with a verified quote. Skipped when the host's robots.txt blocks AI
   crawlers or says ``Content-Signal: ai-input=no``, or the page says
   ``noai``: such sites are read deterministically only.
5. Committee members (name + role, from committee / contact / about pages, or
   a home page that lists the committee) → private broker ``people``; named
   sponsors / partners → ``sponsors`` / ``partner_of`` relationships to
   counterpart organisations; needs / offers → broker inferences.

The output is ordinary keyed observations — one per page read (plus
sessions and counterparts), source type ``society_website`` or ``linktree``
— staged like any harvester's, so `load` posts them with everything else.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

from camsocs_pipeline.claims import (
    missing_field,
    parser_field,
)
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.org import (
    PromptPage,
    extract_org,
    render_prompt,
)
from camsocs_pipeline.models.observation import (
    Observation,
)
from camsocs_pipeline.resolve.families import COUNTERPART_TYPES
from camsocs_pipeline.resolve.names import site_identity, tokens
from camsocs_pipeline.resolve.resolver import priority_of
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.websites.discover import choose_pages, in_scope
from camsocs_pipeline.sources.websites.links import (
    NOT_SOCIETY_HANDLES,
    Social,
    classify_email,
    feed_of,
    is_join_link,
    is_termcard_link,
    mailing_list_of,
    social_of,
)
from camsocs_pipeline.sources.websites.linktree import linktree_links
from camsocs_pipeline.sources.websites.mapping import ExtractionMapper
from camsocs_pipeline.sources.websites.page import Link, Page, parse_page
from camsocs_pipeline.sources.websites.site import (
    EVIDENCE,
    Fetched,
    PartnerMention,
    SiteRecords,
    Stats,
    Target,
    TargetResult,
    count_field,
    host_of,
    when,
)

logger = logging.getLogger(__name__)

#: A cached page younger than this is not fetched again.
FRESH_FOR = timedelta(days=3)
PARSER = "website"
#: Hosts never fetched as a society's website: networks (links only, AGENTS.md),
#: directories with their own harvesters, and talks.cam (§6).
SKIP_HOSTS = (
    "facebook.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
    "tiktok.com",
    "youtube.com",
    "cambridgesu.co.uk",
    "sport.cam.ac.uk",
    "camdram.net",
    "talks.cam.ac.uk",
    "lists.cam.ac.uk",
    "docs.google.com",
    "forms.gle",
    "eventbrite.co.uk",
    "fixr.co",
    "lu.ma",
)
_PARKED = re.compile(
    r"(domain (is )?for sale|buy this domain|parked free|this domain may be for sale)", re.I
)


# --- targets ---------------------------------------------------------------------------------


def _skipped_host(url: str) -> bool:
    host = host_of(url)
    return any(host == skip or host.endswith("." + skip) for skip in SKIP_HOSTS)


def targets_from(records: Iterable[Any]) -> tuple[list[Target], list[str]]:
    """Organisations worth enriching from resolved observations: those with
    a website or Linktree a register states, skipping counterparts and sites
    claimed by several organisations (whose site would it be?)."""
    by_key: dict[str, list[Observation]] = defaultdict(list)
    for record in records:
        if (
            isinstance(record, Observation)
            and record.entity_type == "organisation"
            and record.entity_key
        ):
            by_key[record.entity_key].append(record)
    targets: list[Target] = []
    for key, observations in sorted(by_key.items()):
        observations.sort(key=priority_of)
        values: dict[str, list[Any]] = defaultdict(list)
        for observation in observations:
            for obs in observation.fields:
                if obs.value is not None:
                    values[obs.field].append(obs.value)
        if True in values.get("isCounterpart", []):
            continue
        first = observations[0].identity
        if first.org_type in COUNTERPART_TYPES:
            continue
        target = Target(
            key=key,
            name=next((v for v in values.get("name", []) if isinstance(v, str)), first.name),
            aliases=sorted({a for o in observations for a in o.identity.aliases}),
            org_type=next(iter(values.get("orgType", [])), first.org_type),
            level=next(iter(values.get("level", [])), first.level),
            college=next(
                (o.identity.college_hint for o in observations if o.identity.college_hint), None
            ),
            su_category=next(iter(values.get("suCategory", [])), None),
            sport_registered=any(
                isinstance(v, dict) and v.get("registered") is True
                for v in values.get("registrations.sportsService", [])
            ),
            instagram=next(
                (o.identity.instagram_handle for o in observations if o.identity.instagram_handle),
                None,
            ),
        )
        sites = [v for v in values.get("website", []) if isinstance(v, str)]
        sites += [
            o.identity.website_domain
            for o in observations
            if o.identity.website_domain and "." in o.identity.website_domain
        ]
        socials = [
            item.get("url")
            for v in values.get("socials", [])
            if isinstance(v, list)
            for item in v
            if isinstance(item, dict) and item.get("platform") == "linktree"
        ]
        for url in sites:
            url = url if "://" in url else f"https://{url}"
            if host_of(url) == "linktr.ee":
                target.linktree = target.linktree or url
            elif target.website is None and not _skipped_host(url):
                target.website = url
        for url in socials:
            if isinstance(url, str) and target.linktree is None:
                target.linktree = url
        if target.website or target.linktree:
            targets.append(target)

    notes: list[str] = []
    owners: dict[str, list[Target]] = defaultdict(list)
    for target in targets:
        if target.website and (identity := site_identity(target.website)):
            owners[identity].append(target)
    for identity, sharing in sorted(owners.items()):
        if len(sharing) > 1:
            notes.append(
                f"{identity} is the website of {len(sharing)} organisations — not read as any one's"
            )
            for target in sharing:
                target.website = None
    return [t for t in targets if t.website or t.linktree], notes


# --- fetching ----------------------------------------------------------------------------------


def _is_html(result: FetchResult) -> bool:
    kind = (result.content_type or "").lower()
    return result.ok and (
        "html" in kind or (not kind and b"<html" in (result.content or b"")[:2048].lower())
    )


def _fetch(client: PoliteClient, kind: str, url: str) -> Fetched:
    result = client.fetch(url, fresh_for=FRESH_FOR)
    fetched = Fetched(kind, result)
    if _is_html(result):
        fetched.page = parse_page(fetched.url, result.text)
    return fetched


# --- per-organisation result -----------------------------------------------------------------


# --- the enricher --------------------------------------------------------------------------------


class Enricher:
    """Enriches targets. Thread-safe per target; share one per run."""

    def __init__(
        self,
        client: PoliteClient,
        llm: LLMClient | None,
        *,
        cache_dir: Any = None,
    ) -> None:
        self.client = client
        self.llm = llm
        self.cache_dir = cache_dir

    # -- one organisation ------------------------------------------------------------------

    def enrich(self, target: Target) -> TargetResult:
        result = TargetResult(target)
        if target.website:
            try:
                self._website(target, result)
            except Exception as error:  # one broken site must not end the stage
                logger.exception("enriching %s failed", target.key)
                result.notes.append(f"{target.key}: website failed ({type(error).__name__})")
        if target.linktree:
            try:
                self._linktree(target, result)
            except Exception as error:
                logger.exception("Linktree of %s failed", target.key)
                result.notes.append(f"{target.key}: Linktree failed ({type(error).__name__})")
        for record in [*result.website, *result.linktree]:
            for obs in record.fields:
                count_field(result.stats, obs)
        return result

    def _health(self, home: Fetched, platform: str | None) -> dict[str, Any]:
        status = home.result.status
        health: dict[str, Any] = {
            "last_status": status if status is not None else 0,
            "checked_at": int(when(home.result).timestamp() * 1000),
        }
        if platform:
            health["platform"] = platform
        return health

    def _website(self, target: Target, result: TargetResult) -> None:
        assert target.website is not None
        buckets = SiteRecords(target, "society_website")
        home = _fetch(self.client, "home", target.website)
        home_record = buckets.page(home)
        result.website = buckets.records
        outcome = home.result.outcome
        if outcome == "disallowed_by_robots" and "unreachable" not in (home.result.detail or ""):
            result.stats.disallowed += 1
            result.notes.append(f"{target.key}: robots.txt disallows {target.website}")
            return
        home_record.internal["website_health"] = self._health(
            home, home.page.platform if home.page else None
        )
        if home.page is None:
            result.stats.unreachable += 1
            result.notes.append(
                f"{target.key}: {target.website} → {outcome} {home.result.status or ''}"
            )
            return
        home_record.internal["website_domain"] = host_of(home.url)
        page = home.page
        if "noindex" in page.robots or "none" in page.robots:
            result.notes.append(f"{target.key}: home page says noindex — not read")
            return
        if not self._mentions(target, page):
            result.stats.not_about += 1
            result.notes.append(f"{target.key}: {home.url} does not mention the organisation")
            return

        fetched = [home]
        nofollow = "nofollow" in page.robots
        for kind, url in choose_pages(home.url, page.links, nofollow=nofollow).items():
            other = _fetch(self.client, kind, url)
            if other.page is not None and not ({"noindex", "none"} & other.page.robots):
                fetched.append(other)
                buckets.page(other)
        result.stats.pages += len(fetched)

        buckets.add(
            home.url,
            parser_field(
                "website", _canonical(home.url), extractor=f"{PARSER}.final_url", evidence=EVIDENCE
            ),
        )
        found = self._deterministic(target, fetched, buckets, home_record)

        ai_allowed = self.client.ai_input_allowed(home.url) and "noai" not in page.robots
        if self.llm is None:
            return
        if not ai_allowed:
            result.stats.llm_skipped_robots += 1
            result.notes.append(
                f"{target.key}: robots.txt keeps AI agents out — read without the LLM"
            )
            return
        self._llm(target, fetched, buckets, found, result)

    @staticmethod
    def _mentions(target: Target, page: Page) -> bool:
        if _PARKED.search(page.text[:5_000]):
            return False
        words = target.words
        haystack = set(tokens(f"{page.title} {page.text[:20_000]} {host_of(page.url)}"))
        host_text = host_of(page.url).replace(".", " ").replace("-", " ")
        return bool(words & haystack) or any(word in host_text for word in words if len(word) >= 4)

    # -- deterministic ------------------------------------------------------------------------

    def _deterministic(
        self,
        target: Target,
        fetched: list[Fetched],
        buckets: SiteRecords,
        home_record: Observation,
    ) -> set[str]:
        """Socials, emails, feeds, mailing list, join / termcard links. Returns
        the fields found."""
        found: set[str] = set()
        pages = [f for f in fetched if f.page is not None]

        # Socials: links and JSON-LD sameAs, one choice per platform.
        candidates: dict[str, Counter] = defaultdict(Counter)
        first_seen: dict[str, str] = {}
        socials: dict[str, Social] = {}
        for item in pages:
            assert item.page is not None
            urls = [link.url for link in item.page.links]
            urls += _same_as(item.page.structured)
            for url in urls:
                social = social_of(url)
                if social is None or (social.handle or "").lower() in NOT_SOCIETY_HANDLES:
                    continue
                candidates[social.platform][social.url] += (
                    2 if url in _same_as(item.page.structured) else 1
                )
                socials.setdefault(social.url, social)
                first_seen.setdefault(social.url, item.url)
        chosen: list[Social] = []
        for platform, counts in candidates.items():
            pick = _pick_social(platform, counts, socials, target)
            if pick is not None:
                chosen.append(pick)
        by_page: dict[str, list[dict[str, str]]] = defaultdict(list)
        for social in sorted(chosen, key=lambda s: (s.platform, s.url)):
            by_page[first_seen[social.url]].append(social.value())
        for url, values in by_page.items():
            buckets.add(
                url,
                parser_field("socials", values, extractor=f"{PARSER}.socials", evidence=EVIDENCE),
            )
            found.add("socials")
        instagram = next((s for s in chosen if s.platform == "instagram"), None)
        if instagram and not target.instagram:
            home_record.internal["instagram_handle"] = instagram.handle

        # Emails: role addresses per page, one general address per site.
        site_host = host_of(fetched[0].url)
        general: list[tuple[int, str, str]] = []
        roles_by_page: dict[str, list[dict[str, str]]] = defaultdict(list)
        seen_roles: set[tuple[str, str]] = set()
        for item in pages:
            assert item.page is not None
            emails = list(item.page.emails)
            emails += [e for e in _structured_emails(item.page.structured) if e not in emails]
            for email in emails:
                reading = classify_email(email, org_words=target.words, site_host=site_host)
                if reading.kind == "role" and reading.role:
                    if (reading.role, reading.email) not in seen_roles:
                        seen_roles.add((reading.role, reading.email))
                        roles_by_page[item.url].append(
                            {"role": reading.role, "email": reading.email}
                        )
                elif reading.kind == "general":
                    domain = reading.email.split("@", 1)[1]
                    rank = 0 if domain.endswith(site_host) or site_host.endswith(domain) else 1
                    general.append((rank, reading.email, item.url))
        for url, values in roles_by_page.items():
            buckets.add(
                url,
                parser_field("roleEmails", values, extractor=f"{PARSER}.mailto", evidence=EVIDENCE),
            )
            found.add("roleEmails")
        if general:
            _rank, email, url = min(general, key=lambda g: (g[0], g[2] != fetched[0].url))
            buckets.add(
                url, parser_field("email", email, extractor=f"{PARSER}.mailto", evidence=EVIDENCE)
            )
            found.add("email")

        # Feeds, mailing lists, join and termcard links.
        feeds: dict[str, list[str]] = defaultdict(list)
        for item in pages:
            assert item.page is not None
            for link in item.page.links:
                feed = feed_of(link.url)
                if feed and feed.value not in feeds[feed.kind]:
                    feeds[feed.kind].append(feed.value)
                listing = mailing_list_of(link.url)
                if listing and "mailingList" not in found:
                    value, sympa = listing
                    buckets.add(
                        item.url,
                        parser_field(
                            "mailingList",
                            value,
                            extractor=f"{PARSER}.mailing_list",
                            evidence=EVIDENCE,
                        ),
                    )
                    found.add("mailingList")
                    if sympa:
                        home_record.internal["sympa_list"] = sympa
                if "joinUrl" not in found and is_join_link(link.url, link.text):
                    buckets.add(
                        item.url,
                        parser_field(
                            "joinUrl", link.url, extractor=f"{PARSER}.join_link", evidence=EVIDENCE
                        ),
                    )
                    found.add("joinUrl")
                if "termcardUrl" not in found and is_termcard_link(link.url, link.text):
                    buckets.add(
                        item.url,
                        parser_field(
                            "termcardUrl",
                            link.url,
                            extractor=f"{PARSER}.termcard_link",
                            evidence=EVIDENCE,
                        ),
                    )
                    found.add("termcardUrl")
        for kind, values in feeds.items():
            if kind == "camdram_slug":
                if len(values) == 1:
                    home_record.internal["camdram_slug"] = values[0]
            else:
                home_record.internal[kind] = values

        # A sponsors page means the group looks for sponsorship (broker, private).
        sponsor_page = next((f for f in fetched if f.kind == "sponsors"), None)
        if sponsor_page is not None:
            title = sponsor_page.page.title if sponsor_page.page else ""
            buckets.by_url[sponsor_page.url].broker.setdefault("needs", []).append(
                {
                    "item": "sponsorship",
                    "evidence_quote": f"sponsors page: {title or sponsor_page.url}"[:200],
                    "method": "parser",
                }
            )

        for name in ("email", "roleEmails", "socials"):
            if name not in found:
                buckets.add(
                    fetched[0].url,
                    missing_field(
                        name, "not_found", extractor=f"{PARSER}.{name}", evidence=EVIDENCE
                    ),
                )
        return found

    # -- the LLM ---------------------------------------------------------------------------------

    def _llm(
        self,
        target: Target,
        fetched: list[Fetched],
        buckets: SiteRecords,
        found: set[str],
        result: TargetResult,
    ) -> None:
        assert self.llm is not None
        pages = [f for f in fetched if f.page is not None]
        prompt_pages = [PromptPage(f.kind, f.url, f.page.text) for f in pages if f.page]
        links = _prompt_links(pages)
        context = _context(target)
        prompt = render_prompt(
            name=target.name,
            context=context,
            pages=prompt_pages,
            links=[(link.text, link.url) for link in links],
            su_category=target.su_category,
        )
        try:
            call = extract_org(self.llm, prompt, cache_dir=self.cache_dir)
        except Exception as error:  # validation failure or transport exhaustion
            result.stats.llm_failed += 1
            result.notes.append(f"{target.key}: LLM extraction failed ({type(error).__name__})")
            return
        if call.cached:
            result.stats.llm_cached += 1
        else:
            result.stats.llm_calls += 1
            result.stats.llm_seconds += call.seconds
        extraction = call.extraction
        if not extraction.is_about_organisation:
            result.stats.not_about += 1
            result.notes.append(
                f"{target.key}: the LLM says {fetched[0].url} is not this organisation's site"
            )
            return
        ExtractionMapper(target, pages, buckets, call, found, links, result).map(extraction)

    # -- Linktree ------------------------------------------------------------------------------

    def _linktree(self, target: Target, result: TargetResult) -> None:
        assert target.linktree is not None
        buckets = SiteRecords(target, "linktree")
        fetched = _fetch(self.client, "linktree", target.linktree)
        record = buckets.page(fetched)
        result.linktree = buckets.records
        if fetched.result.outcome == "disallowed_by_robots":
            result.stats.disallowed += 1
            result.notes.append(f"{target.key}: robots.txt disallows {target.linktree}")
            return
        if fetched.page is None or not fetched.result.ok:
            result.stats.unreachable += 1
            return
        links = linktree_links(fetched.result.text)
        socials = {}
        for link in links:
            social = social_of(link.url)
            if social and social.platform != "linktree":
                socials.setdefault(social.url, social.value())
        if socials:
            buckets.add(
                fetched.url,
                parser_field(
                    "socials", list(socials.values()), extractor="linktree.links", evidence=EVIDENCE
                ),
            )
        feeds: dict[str, list[str]] = defaultdict(list)
        for link in links:
            feed = feed_of(link.url)
            if feed and feed.kind != "camdram_slug" and feed.value not in feeds[feed.kind]:
                feeds[feed.kind].append(feed.value)
            listing = mailing_list_of(link.url)
            if listing:
                buckets.add(
                    fetched.url,
                    parser_field(
                        "mailingList", listing[0], extractor="linktree.links", evidence=EVIDENCE
                    ),
                )
            if is_join_link(link.url, link.text):
                buckets.add(
                    fetched.url,
                    parser_field(
                        "joinUrl", link.url, extractor="linktree.links", evidence=EVIDENCE
                    ),
                )
            if re.search(r"\b(website|homepage|our site)\b", link.text, re.I) and not social_of(
                link.url
            ):
                buckets.add(
                    fetched.url,
                    parser_field(
                        "website", link.url, extractor="linktree.website_link", evidence=EVIDENCE
                    ),
                )
        record.internal.update(feeds)
        result.stats.pages += 1


# --- mapping the LLM's answer onto pages -------------------------------------------------------


# --- helpers -----------------------------------------------------------------------------------


def _canonical(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path or '/'}"


def _same_as(structured: dict[str, list[dict[str, Any]]]) -> list[str]:
    urls: list[str] = []
    for item in structured.get("json-ld", []) + structured.get("microdata", []):
        if not isinstance(item, dict):
            continue
        same = item.get("sameAs")
        for value in same if isinstance(same, list) else [same]:
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                urls.append(value)
    return urls


def _structured_emails(structured: dict[str, list[dict[str, Any]]]) -> list[str]:
    emails: list[str] = []
    for item in structured.get("json-ld", []) + structured.get("microdata", []):
        if isinstance(item, dict) and isinstance(item.get("email"), str):
            emails.append(item["email"].removeprefix("mailto:").strip().lower())
    return emails


def _pick_social(
    platform: str, counts: Counter, socials: dict[str, Social], target: Target
) -> Social | None:
    """One profile per platform: the only one, or the one named after the
    group, or the clearly most-linked one. Ambiguity means none."""
    if len(counts) == 1:
        return socials[next(iter(counts))]
    words = target.words
    if platform == "instagram" and target.instagram:
        for url in counts:
            if socials[url].handle == target.instagram.lower().lstrip("@"):
                return socials[url]
    named = [url for url in counts if any(word in url.lower() for word in words if len(word) >= 4)]
    if len(named) == 1:
        return socials[named[0]]
    ranked = counts.most_common(2)
    if ranked[0][1] > ranked[1][1]:
        return socials[ranked[0][0]]
    return None


def _prompt_links(pages: list[Fetched]) -> list[Link]:
    """The links the model may choose join / termcard URLs from: forms, the
    SU shop, anything whose text says join / membership / termcard."""
    out: list[Link] = []
    seen: set[str] = set()
    pattern = re.compile(r"join|member|sign ?up|register|term ?card|form|subscribe|shop", re.I)
    for item in pages:
        assert item.page is not None
        for link in item.page.links:
            if link.url in seen or social_of(link.url):
                continue
            if pattern.search(f"{link.text} {link.url}") and (
                not in_scope(link.url, item.url) or pattern.search(link.text)
            ):
                seen.add(link.url)
                out.append(link)
    return out[:40]


def _context(target: Target) -> list[str]:
    lines: list[str] = []
    if target.aliases:
        lines.append(f"Also known as: {', '.join(target.aliases[:5])}")
    if target.org_type:
        lines.append(f"Type: {target.org_type.replace('_', ' ')}")
    if target.level:
        lines.append(f"Level: {target.level}")
    if target.college:
        lines.append(f"College: {target.college}")
    if target.sport_registered:
        lines.append("Registered with the University Sports Service.")
    return lines


def host_group(url: str) -> str:
    """Sites sharing a server are fetched one after another: the registrable
    domain (``srcf.net`` for every ``*.soc.srcf.net``, ``cam.ac.uk``)."""
    labels = host_of(url).split(".")
    if len(labels) >= 3 and labels[-2] in ("co", "org", "ac", "gov", "ltd", "me", "net", "sch"):
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def enrich_all(
    enricher: Enricher,
    targets: list[Target],
    *,
    workers: int = 12,
    on_done: Callable[[TargetResult], None] | None = None,
) -> list[TargetResult]:
    """Enrich every target: host groups in parallel, each group in order."""
    groups: dict[str, list[Target]] = defaultdict(list)
    for target in targets:
        groups[host_group(target.website or target.linktree or "")].append(target)

    def run_group(members: list[Target]) -> list[TargetResult]:
        out = []
        for target in members:
            done = enricher.enrich(target)
            if on_done:
                on_done(done)
            out.append(done)
        return out

    results: list[TargetResult] = []
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(groups)))) as pool:
        for group_results in pool.map(run_group, [groups[name] for name in sorted(groups)]):
            results.extend(group_results)
    order = {target.key: index for index, target in enumerate(targets)}
    return sorted(results, key=lambda r: order[r.target.key])


__all__ = [
    "FRESH_FOR",
    "Enricher",
    "PartnerMention",
    "Stats",
    "Target",
    "TargetResult",
    "enrich_all",
    "host_group",
    "targets_from",
]
