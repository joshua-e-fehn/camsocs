"""Enriching resolved organisations from their own website and Linktree (T5).

Source-research §13 (Linktree), §14 (society websites), §11 (feeds found
there), §15 (ticketing links only). For each resolved organisation with a
website and/or a Linktree:

1. **Fetch politely** (`sources/base.py`: robots.txt, one request in flight
   per host, Crawl-delay, the raw cache; pages younger than `FRESH_FOR` are
   read from the cache). Hosts are processed concurrently; sites on one
   shared host (``*.srcf.net``, ``*.cam.ac.uk``) one after another. The
   fetches carry the society purpose (`sources/policy.py`, D3): a society's
   own site and its Linktree are read even where robots.txt disallows them,
   with ``robots_override:society`` on the page's `sources` row; pacing,
   Crawl-delay, login walls and 401/403 still hold.
2. Read the home page, then at most one page per kind — about, join,
   committee, contact, events, sponsors (`discover.py`) — inside the site.
   ``noindex`` pages yield no content; ``nofollow`` stops the discovery; a
   site that does not mention the organisation (a parked domain) yields only
   its health.
3. **Deterministically**: JSON-LD ``sameAs`` and links → socials; ``mailto:``
   and written addresses → role emails / the general email (never personal
   addresses, never decoded obfuscation); ICS / Google Calendar / Luma /
   talks.cam / ticketing links → ``orgInternal`` feeds; mailing-list
   sign-up links; join and termcard links; the final URL → ``website``; HTTP
   status and platform → ``orgInternal.websiteHealth``.
4. **LLM** (bulk model, prompt ``org_v1``) over the cleaned text of those
   pages (≤ 12k characters) → `extract.org.OrgExtraction`. Every value's
   quote is checked against the page text (`extract.evidence`) and the value
   is attributed to the page that holds it; without a verbatim quote it is
   ``inferred``. Sessions, people and partners — which create rows — are kept
   only with a verified quote. An AI opt-out (the host's robots.txt blocks
   AI crawlers or says ``Content-Signal: ai-input=no``, or the page says
   ``noai``) is overridden for a society's own pages (D3), and the page's
   `sources` row says ``ai_optout_override:society``. talks.cam and tbc.xyz
   never reach the model.
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
from dataclasses import replace
from datetime import timedelta
from html import unescape as html_unescape
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from camsocs_pipeline.claims import (
    missing_field,
    parser_field,
)
from camsocs_pipeline.extract.llm import LLMClient, NoLLMHost, assert_llm_source_allowed
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
from camsocs_pipeline.sources.links import account_of, classify_email, social_key, social_link
from camsocs_pipeline.sources.policy import (
    AI_OVERRIDE_NOTE,
    SOCIETY,
    SOCIETY_WEBSITE,
    FetchPurpose,
    ai_optout_override,
)
from camsocs_pipeline.sources.websites.discover import choose_pages, in_scope
from camsocs_pipeline.sources.websites.links import (
    NOT_SOCIETY_HANDLES,
    feed_of,
    is_join_link,
    is_termcard_link,
    mailing_list_of,
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
    "hellorubric.com",
    "discord.com",
    "discord.gg",
    "chat.whatsapp.com",
    "wa.me",
    "t.me",
    "groupme.com",
    "join.slack.com",
    "forms.office.com",
)
#: Query parameters that only track a click; dropped from a stated website.
_TRACKING = re.compile(r"^(utm_\w+|fbclid|gclid|igshid|mc_cid|mc_eid|si|ref)$", re.I)
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
            url = _clean_url(url if "://" in url else f"https://{url}")
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


def _fetch(
    client: PoliteClient, kind: str, url: str, purpose: FetchPurpose = SOCIETY_WEBSITE
) -> Fetched:
    """One page of a society's own site (or its Linktree), fetched with the
    society purpose: D3 lets robots.txt be overridden for it."""
    result = client.fetch(url, fresh_for=FRESH_FOR, purpose=purpose)
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
        if _skipped_host(home.url) and home.url != target.website:
            # A short link that leads to a chat invite or a social profile.
            result.notes.append(
                f"{target.key}: {target.website} leads to {host_of(home.url)}, not a website"
            )
            home_record.fetch = None
            result.website = []
            return
        if outcome == "disallowed_by_robots" and "unreachable" not in (home.result.detail or ""):
            result.stats.disallowed += 1
            result.notes.append(f"{target.key}: robots.txt disallows {target.website}")
            return
        home_record.internal["website_health"] = self._health(
            home, home.page.platform if home.page else None
        )
        if home.page is None:
            result.stats.unreachable += 1
            what = "unreachable" if outcome == "disallowed_by_robots" else outcome
            status = home.result.status or ""
            result.notes.append(f"{target.key}: {target.website} → {what} {status}".rstrip())
            dead = _dead_reason(home.result)
            if dead is not None:
                # The stated website itself answered dead: say so from that
                # URL (primary), so a register's stale link is not shown as a
                # working site (AGENTS.md: a 404 is recorded as not_found).
                at = self._stated_url_record(target, home, buckets)
                buckets.add(
                    at,
                    missing_field("website", dead, extractor=f"{PARSER}.health", evidence=EVIDENCE),
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
        unread: set[str] = set()  # kinds of page chosen but not read
        nofollow = "nofollow" in page.robots
        for kind, url in choose_pages(home.url, page.links, nofollow=nofollow).items():
            other = _fetch(self.client, kind, url)
            if other.page is not None and not ({"noindex", "none"} & other.page.robots):
                fetched.append(other)
                buckets.page(other)
            elif other.page is None:
                unread.add(kind)
        result.stats.pages += len(fetched)

        website = parser_field(
            "website", _canonical(home.url), extractor=f"{PARSER}.final_url", evidence=EVIDENCE
        )
        buckets.add(home.url, website)
        if _canonical(home.url) != _canonical(target.website):
            # The site's answer about the stated URL (it redirects here), from
            # that URL — it replaces any earlier dead-link reading of it.
            buckets.add(self._stated_url_record(target, home, buckets), website)
        found = self._deterministic(target, fetched, buckets, home_record, unread=unread)

        if self.llm is None:
            return
        # §14: a page reaches the model only if its host lets AI read it (no
        # AI crawler disallowed from that URL, no `ai-input=no`) and the page
        # itself does not say `noai` — or the D3 society override lifts that
        # opt-out, which its `sources` row then records. Checked per page.
        ai_pages = []
        for item in fetched:
            reading = self._ai_reading(item)
            if reading == "refused":
                continue
            if reading == "override":
                _note_access(buckets.by_url[item.url], AI_OVERRIDE_NOTE)
            ai_pages.append(item)
        if not ai_pages or ai_pages[0] is not home:
            result.stats.llm_skipped_robots += 1
            result.notes.append(
                f"{target.key}: robots.txt keeps AI agents out — read without the LLM"
            )
            return
        if len(ai_pages) < len(fetched):
            result.notes.append(
                f"{target.key}: {len(fetched) - len(ai_pages)} page(s) keep AI out — "
                "read without the LLM"
            )
        self._llm(target, ai_pages, buckets, found, result)

    def _ai_reading(self, page: Fetched) -> str:
        """Whether this page's text may reach the model (§14): ``allowed``
        (no AI opt-out), ``override`` (an opt-out the D3 society override
        lifts) or ``refused`` (talks.cam, tbc.xyz, or a page not read)."""
        if page.page is None:
            return "refused"
        try:
            assert_llm_source_allowed(page.url)
        except NoLLMHost:
            return "refused"
        opted_out = bool({"noai", "noimageai"} & page.page.robots) or not (
            self.client.ai_input_allowed(page.url)
        )
        if not opted_out:
            return "allowed"
        return "override" if ai_optout_override(page.url, SOCIETY_WEBSITE) else "refused"

    @staticmethod
    def _stated_url_record(target: Target, home: Fetched, buckets: SiteRecords) -> str:
        """The record for the website as the register states it (which may
        redirect elsewhere), for readings about that URL itself."""
        assert target.website is not None
        stated = Fetched(home.kind, replace(home.result, final_url=target.website))
        buckets.page(stated)
        return stated.url

    @staticmethod
    def _mentions(target: Target, page: Page) -> bool:
        """Whether the page is about this organisation at all: one of its
        distinctive words (or its acronym) in the title, text or URL. A
        parked or for-sale domain never is."""
        if _PARKED.search(page.text[:5_000]):
            return False
        words = target.words
        haystack = set(tokens(f"{page.title} {page.text[:20_000]} {page.url}"))
        if words & haystack:
            return True
        # "Builder" / "Build", "Robotics" / "Robots": a word less its last
        # three letters, never shorter than five.
        stems = {word[: max(5, len(word) - 3)] for word in words if len(word) >= 5}
        if any(token.startswith(stem) for token in haystack for stem in stems):
            return True
        url = page.url.lower()
        return any(word in url for word in words if len(word) >= 3)

    # -- deterministic ------------------------------------------------------------------------

    def _deterministic(
        self,
        target: Target,
        fetched: list[Fetched],
        buckets: SiteRecords,
        home_record: Observation,
        *,
        unread: set[str] | frozenset[str] = frozenset(),
    ) -> set[str]:
        """Socials, emails, feeds, mailing list, join / termcard links. Returns
        the fields found. `unread`: kinds of page chosen but not fetched."""
        found: set[str] = set()
        pages = [f for f in fetched if f.page is not None]
        # A "website" that is a page of a bigger site (a club's page on its
        # parent club's or the RAF's site): the header, navigation and footer
        # belong to that site, so only the page's own content counts.
        sub_page = urlsplit(fetched[0].url).path.strip("/") != ""

        # Socials: links and JSON-LD sameAs, one choice per platform.
        # Candidates are counted per account however a page wrote the link
        # (`social_key`); the first spelling seen is the one stored.
        candidates: dict[str, Counter] = defaultdict(Counter)
        first_seen: dict[str, str] = {}
        socials: dict[str, dict[str, str]] = {}
        for item in pages:
            assert item.page is not None
            urls = [link.url for link in item.page.links if not sub_page or link.region == "main"]
            urls += _same_as(item.page.structured)
            for url in urls:
                social = social_link(url)
                if social is None or account_of(social) in NOT_SOCIETY_HANDLES:
                    continue
                key = social_key(social)
                candidates[social["platform"]][key] += (
                    2 if url in _same_as(item.page.structured) else 1
                )
                socials.setdefault(key, social)
                first_seen.setdefault(key, item.url)
        chosen: list[dict[str, str]] = []
        for platform, counts in candidates.items():
            pick = _pick_social(platform, counts, socials, target)
            if pick is not None:
                chosen.append(pick)
        by_page: dict[str, list[dict[str, str]]] = defaultdict(list)
        for social in sorted(chosen, key=lambda s: (s["platform"], s["url"])):
            by_page[first_seen[social_key(social)]].append(social)
        for url, values in by_page.items():
            buckets.add(
                url,
                parser_field("socials", values, extractor=f"{PARSER}.socials", evidence=EVIDENCE),
            )
            found.add("socials")
        instagram = next((s for s in chosen if s["platform"] == "instagram"), None)
        if instagram and not target.instagram:
            home_record.internal["instagram_handle"] = instagram["handle"].lower()

        # Emails: role addresses per page, one general address per site.
        site_host = host_of(fetched[0].url)
        general: list[tuple[int, str, str]] = []
        roles_by_page: dict[str, list[dict[str, str]]] = defaultdict(list)
        seen_roles: set[tuple[str, str]] = set()
        for item in pages:
            assert item.page is not None
            emails = list(item.page.main_emails if sub_page else item.page.emails)
            emails += [e for e in _structured_emails(item.page.structured) if e not in emails]
            for email in emails:
                reading = classify_email(email, target.words, site_host=site_host)
                address = reading.address.lower()
                if reading.kind == "role" and reading.role:
                    if (reading.role, address) not in seen_roles:
                        seen_roles.add((reading.role, address))
                        roles_by_page[item.url].append({"role": reading.role, "email": address})
                elif reading.kind == "general":
                    domain = address.split("@", 1)[1]
                    rank = 0 if domain.endswith(site_host) or site_host.endswith(domain) else 1
                    general.append((rank, address, item.url))
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
            # A Camdram link on a site may be a co-production's company; the
            # Camdram harvester owns the society's own slug.
            if kind != "camdram_slug":
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

        # What the pages read do not give. Addresses the site hides (Cloudflare
        # email protection, never decoded) are `access_restricted`, not absent;
        # with its contact page unread the site was not fully read, so no
        # claim about its addresses is made at all.
        hidden = any(item.page.obfuscated_emails > 0 for item in pages if item.page)
        for name in ("email", "roleEmails", "socials"):
            if name in found:
                continue
            reason = "not_found"
            if name in ("email", "roleEmails"):
                if "contact" in unread:
                    continue
                if hidden:
                    reason = "access_restricted"
            buckets.add(
                fetched[0].url,
                missing_field(name, reason, extractor=f"{PARSER}.{name}", evidence=EVIDENCE),
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
            # Then nothing read off these pages is about the organisation
            # either: keep only the site's health.
            for record in buckets.records:
                record.fields = []
                record.broker = {}
                record.relationships = []
                record.internal = {
                    k: v for k, v in record.internal.items() if k == "website_health"
                }
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
        fetched = _fetch(self.client, "linktree", target.linktree, SOCIETY)
        record = buckets.page(fetched)
        result.linktree = buckets.records
        if fetched.result.outcome == "disallowed_by_robots":
            result.stats.disallowed += 1
            result.notes.append(f"{target.key}: robots.txt disallows {target.linktree}")
            return
        if fetched.page is None or not fetched.result.ok:
            result.stats.unreachable += 1
            status = fetched.result.status or ""
            result.notes.append(
                f"{target.key}: {target.linktree} → {fetched.result.outcome} {status}".rstrip()
            )
            return
        links = linktree_links(fetched.result.text)
        socials = {}
        for link in links:
            social = social_link(link.url)
            if social and social["platform"] != "linktree":
                socials.setdefault(social_key(social), social)
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
            if re.search(r"\b(website|homepage|our site)\b", link.text, re.I) and not social_link(
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


def _clean_url(url: str) -> str:
    """A stated website without click-tracking parameters (and with ``&amp;``
    decoded, as some directories leave it)."""
    parts = urlsplit(html_unescape(url.strip()))
    query = "&".join(
        pair
        for pair in parts.query.split("&")
        if pair and not _TRACKING.match(pair.split("=", 1)[0])
    )
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def _dead_reason(result: FetchResult) -> str | None:
    """The `missingReason` a stated website earns when its home page does not
    answer: 404/410 `not_found`, a login wall or 401/403 `access_restricted`,
    no connection (robots.txt included) or a server error `unreachable`. None
    for anything that is not a verdict on the site (a robots.txt rule, an odd
    4xx)."""
    if result.outcome in ("not_found", "access_restricted"):
        return result.outcome
    if result.outcome == "unreachable":
        return "unreachable"
    if result.outcome == "disallowed_by_robots" and "unreachable" in (result.detail or ""):
        # robots.txt itself could not be fetched: the host does not answer.
        return "unreachable"
    if result.outcome == "http_error" and (result.status or 0) >= 500:
        return "unreachable"
    return None


def _note_access(record: Observation, note: str) -> None:
    """Adds `note` to the access note of the page's `sources` row."""
    if record.fetch is None:
        return
    current = record.fetch.access_note
    if current and note in current.split("; "):
        return
    record.fetch.access_note = f"{current}; {note}" if current else note


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
    platform: str, counts: Counter, socials: dict[str, dict[str, str]], target: Target
) -> dict[str, str] | None:
    """One profile per platform: the only one, or the one named after the
    group, or the clearly most-linked one. Ambiguity means none. `counts` and
    `socials` are keyed by `social_key`."""
    if len(counts) == 1:
        return socials[next(iter(counts))]
    words = target.words
    if platform == "instagram" and target.instagram:
        for key in counts:
            if account_of(socials[key]) == target.instagram.lower().lstrip("@"):
                return socials[key]
    named = [key for key in counts if any(word in key for word in words if len(word) >= 4)]
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
            if link.url in seen or social_link(link.url):
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
