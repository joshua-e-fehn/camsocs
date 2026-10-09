"""The fetch policy: which robots.txt and AI opt-out signals a request
honours. This is Joshua's decision D3 (PLAN.md decisions log, 2026-10-08):
society pages and feeds may be read even where robots.txt disallows, but no
other page may.

Every fetch carries a `FetchPurpose`. Its scope is ``general`` (the default)
or ``society``; a society fetch may also declare the class of URL it is
reading. `PoliteClient` (`sources/base.py`) asks this module, and the rules
apply in this order:

1. **Never fetched**, whatever the purpose and whatever robots.txt says:
   `NEVER_FETCH_HOSTS`. That covers the University Events API on
   webservices.admin.cam.ac.uk (§10), and Instagram, Facebook and LinkedIn
   (links only; Meta data comes only through its official API, §17).
2. **Scope ``general``** honours robots.txt and every AI opt-out exactly as
   before (source-research "Global rules").
3. **Scope ``society``** may override a robots.txt *disallow*. It may also
   override an AI opt-out: an AI crawler disallowed by name,
   ``Content-Signal: ai-input=no``, or a page that says ``noai``. Both apply
   only to the URL classes D3 lists (`SOCIETY_URL_CLASSES`), and never on
   `NEVER_OVERRIDE_HOSTS` (talks.cam and tbc.xyz) or on a host that is never
   a society's page (`GENERAL_HOSTS`: the University's central and admin
   sites, search engines, social networks, link shorteners).
   - Three classes are recognised from the URL itself: an SU ``/asset/``
     file (``su_asset``: a profile's logo or termcard), a Linktree page
     (``linktree``) and a Google Calendar public ICS feed
     (``google_calendar_feed``).
   - Two are declared by the caller, which knows what it is reading: a
     society's, club's, JCR's or MCR's own website (``society_website``),
     and a college / JCR / MCR society-list page (``college_society_list``).
     A declared class belongs to one site: `PoliteClient.fetch` binds it to
     the registrable domain of the URL it was asked for
     (`FetchPurpose.bound_to`), so a redirect to another domain, or a file a
     page links on another host (a shop's CDN), is read under that host's
     own robots.txt — the class never carries over.
   - Never a society's own website, whatever the caller declares: the
     University's and the colleges' and departments' own sites on cam.ac.uk
     (``www.clare.cam.ac.uk``, ``www.educ.cam.ac.uk``,
     ``neuroscience.cam.ac.uk``; `is_cam_main_site`) — a JCR's, an MCR's or
     a society's site there is a sub-site of one (``mcr.clare.cam.ac.uk``,
     ``www.jcr.corpus.cam.ac.uk``), and a college's society-list page stays
     a ``college_society_list`` — and national or parent organisations a
     Cambridge branch links (`NATIONAL_DOMAINS`, general hosts: the national
     Christian Medical Fellowship's cmf.org.uk, seen in the 2026-10-09
     harvest, and the like).
4. **An override never changes** the honest User-Agent, the Crawl-delay and
   minimum interval, or the rule of one request in flight per host. Cookies
   and credentials are still never sent. Login walls, 401/403 and
   members-only pages are still never fetched (they are recorded
   ``access_restricted``), and obfuscated addresses are still never decoded.
   A robots.txt that cannot be reached at all (a network error or a 5xx)
   means the host is down, not closed, so no override is tried and the page
   is recorded ``unreachable``.

When a fetch went ahead only because of an override, it says so:
`ROBOTS_OVERRIDE_NOTE` is set on the `FetchResult` and on the `sources`
row's ``accessNote``, while ``robotsVerdict`` stays the honest
``disallowed``. Text that reached the LLM only because of an override is
marked with `AI_OVERRIDE_NOTE`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, get_args
from urllib.parse import urlsplit

Scope = Literal["general", "society"]

SocietyUrlClass = Literal[
    "society_website",
    "linktree",
    "google_calendar_feed",
    "su_asset",
    "college_society_list",
]
SOCIETY_URL_CLASSES: tuple[str, ...] = get_args(SocietyUrlClass)

#: Classes only the caller can know (`FetchPurpose.url_class`); the others
#: are recognised from the URL itself (`url_class_of`).
DECLARED_CLASSES = frozenset({"society_website", "college_society_list"})

ROBOTS_OVERRIDE_NOTE = "robots_override:society"
AI_OVERRIDE_NOTE = "ai_optout_override:society"

#: Never fetched, whatever the purpose or robots.txt.
NEVER_FETCH_HOSTS: tuple[tuple[str, str], ...] = (
    ("webservices.admin.cam.ac.uk", "University Events API: never fetched (source-research §10)"),
    ("instagram.com", "a social network: links only"),
    ("instagr.am", "a social network: links only"),
    ("facebook.com", "a social network: links only"),
    ("fb.com", "a social network: links only"),
    ("fb.me", "a social network: links only"),
    ("linkedin.com", "a social network: links only"),
    ("lnkd.in", "a social network: links only"),
)

#: Whose robots.txt and AI opt-outs are always honoured, and whose content
#: never reaches the LLM (source-research §6).
NEVER_OVERRIDE_HOSTS = ("talks.cam.ac.uk", "tbc.xyz")

#: Hosts that are never a society's own page, so no society purpose can
#: override their robots.txt. Matched exactly, or as a parent domain when
#: listed in `GENERAL_DOMAINS`. Society sites on cam.ac.uk subdomains (a
#: JCR's site, a college's society list) are not general.
GENERAL_HOSTS = frozenset(
    {
        # The University's central site, its sport and Proctors' sites, and
        # the Sport site's hosting platform.
        "cam.ac.uk",
        "www.cam.ac.uk",
        "www.sport.cam.ac.uk",
        "sport.cam.ac.uk",
        "www.proctors.cam.ac.uk",
        "live-cambridge-sports-cwp.pantheonsite.io",
        # Search engines.
        "google.com",
        "www.google.com",
        "google.co.uk",
        "www.google.co.uk",
        "bing.com",
        "www.bing.com",
        "duckduckgo.com",
        "html.duckduckgo.com",
        "search.yahoo.com",
        "www.ecosia.org",
        "yandex.com",
    }
)
GENERAL_DOMAINS = (
    "admin.cam.ac.uk",
    # Government and public-service sites: a unit's or a service's page there
    # (the University Officers' Training Corps on army.mod.uk, seen in the
    # 2026-10-09 harvest) is published by the government, not by a society.
    "gov.uk",
    "mod.uk",
    "nhs.uk",
    "police.uk",
    "parliament.uk",
    "x.com",
    "twitter.com",
    "tiktok.com",
    "threads.net",
    "youtube.com",
    "youtu.be",
    "bit.ly",
    "tinyurl.com",
    "t.co",
    "goo.gl",
    "ow.ly",
)

#: National or parent organisations whose sites a Cambridge branch states as
#: its website (checked 2026-10-10 against the 2026-10-09 harvest): their
#: pages are the national body's, not the society's (§14 "Which site").
NATIONAL_DOMAINS = (
    "cmf.org.uk",
    "uccf.org.uk",
    "msf.org.uk",
    "ewb-uk.org",
    "communist.red",
    "180dc.org",
    "star-network.org.uk",
    "93percent.club",
    "amnesty.org.uk",
    "unicef.org.uk",
)

_SU_HOSTS = frozenset({"www.cambridgesu.co.uk", "cambridgesu.co.uk"})
_LINKTREE_HOSTS = frozenset({"linktr.ee", "www.linktr.ee"})
_GOOGLE_CALENDAR_HOST = "calendar.google.com"
_GOOGLE_ICS_PATH = re.compile(r"^/calendar/ical/[^/]+/public/[^/]+\.ics$", re.I)
#: Hosts whose URL classes are fixed by pattern: a declared class never
#: stretches to their other paths (the SU's login page, Google's other apps).
_PATTERN_HOSTS = _SU_HOSTS | _LINKTREE_HOSTS | {_GOOGLE_CALENDAR_HOST}


@dataclass(frozen=True)
class FetchPurpose:
    """Why a URL is being fetched. ``general`` honours every robots.txt rule.
    ``society`` may override a robots disallow or an AI opt-out for the D3 URL
    classes; `url_class` declares a class the URL alone cannot show (a
    society's own website, a college's society list), and `site` the
    registrable domain it was declared for (`bound_to`; None: not yet bound)."""

    scope: Scope = "general"
    url_class: SocietyUrlClass | None = None
    site: str | None = None

    def __post_init__(self) -> None:
        if self.scope not in ("general", "society"):
            raise ValueError(f"unknown fetch scope {self.scope!r}")
        if self.url_class is not None:
            if self.scope != "society":
                raise ValueError("only a society fetch declares a URL class")
            if self.url_class not in SOCIETY_URL_CLASSES:
                raise ValueError(f"unknown society URL class {self.url_class!r}")
        if self.site is not None and self.url_class not in DECLARED_CLASSES:
            raise ValueError("only a declared URL class is bound to a site")

    def bound_to(self, url: str) -> FetchPurpose:
        """This purpose with a declared class bound to `url`'s site (its
        registrable domain), unless it is bound already."""
        if self.url_class not in DECLARED_CLASSES or self.site is not None:
            return self
        return FetchPurpose(self.scope, self.url_class, registrable_domain(url))


GENERAL = FetchPurpose()
#: A society fetch whose class is read from the URL (SU assets, Linktree,
#: Google Calendar feeds) and no other.
SOCIETY = FetchPurpose("society")
SOCIETY_WEBSITE = FetchPurpose("society", "society_website")
COLLEGE_SOCIETY_LIST = FetchPurpose("society", "college_society_list")


def host_of(url: str) -> str:
    """The URL's host, lower-case, without a port or a trailing dot."""
    return (urlsplit(url).hostname or "").lower().rstrip(".")


def _on(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def never_fetched(url: str) -> str | None:
    """Why `url` is never fetched under any purpose, or None."""
    host = host_of(url)
    for domain, reason in NEVER_FETCH_HOSTS:
        if _on(host, domain):
            return reason
    return None


def never_overridden(url: str) -> bool:
    """talks.cam and tbc.xyz: robots.txt and AI opt-outs always hold."""
    host = host_of(url)
    return any(_on(host, domain) for domain in NEVER_OVERRIDE_HOSTS)


def registrable_domain(url: str) -> str:
    """The part of a URL's host an organisation registers: ``cmf.org.uk``
    for www.cmf.org.uk, ``clare.cam.ac.uk`` for mcr.clare.cam.ac.uk,
    ``srcf.net`` for cuchess.soc.srcf.net."""
    labels = host_of(url).removeprefix("www.").split(".")
    if len(labels) >= 4 and labels[-3:] == ["cam", "ac", "uk"]:
        return ".".join(labels[-4:])
    if len(labels) >= 3 and labels[-2] in ("ac", "co", "org", "gov", "net", "ltd", "me", "sch"):
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def is_cam_main_site(url: str) -> bool:
    """The University's, a college's or a department's own site on cam.ac.uk
    (``www.clare.cam.ac.uk``, ``neuroscience.cam.ac.uk``) — not a sub-site
    of one (``mcr.clare.cam.ac.uk``, ``www.jcr.corpus.cam.ac.uk``,
    ``www-mcr.sel.cam.ac.uk``), where JCRs, MCRs and societies live."""
    host = host_of(url)
    if not _on(host, "cam.ac.uk"):
        return False
    labels = host.removeprefix("www.").split(".")[:-3]
    return len(labels) <= 1


def is_general_host(url: str) -> bool:
    """A host that is never a society's own page (`GENERAL_HOSTS`,
    `GENERAL_DOMAINS`, a national organisation's site)."""
    host = host_of(url)
    return host in GENERAL_HOSTS or any(
        _on(host, domain) for domain in (*GENERAL_DOMAINS, *NATIONAL_DOMAINS)
    )


def url_class_of(url: str) -> SocietyUrlClass | None:
    """The D3 class `url` belongs to by its shape alone, or None."""
    parts = urlsplit(url)
    host = host_of(url)
    path = parts.path or "/"
    if host in _SU_HOSTS and path.lower().startswith("/asset/"):
        return "su_asset"
    if host in _LINKTREE_HOSTS and path.strip("/"):
        return "linktree"
    if host == _GOOGLE_CALENDAR_HOST and _GOOGLE_ICS_PATH.match(path):
        return "google_calendar_feed"
    return None


def society_class(url: str, purpose: FetchPurpose) -> SocietyUrlClass | None:
    """The D3 URL class under which `purpose` may override robots.txt and AI
    opt-outs for `url`, or None when it may not (module docstring, rule 3)."""
    if purpose.scope != "society":
        return None
    if never_fetched(url) or never_overridden(url) or is_general_host(url):
        return None
    pattern = url_class_of(url)
    if pattern is not None:
        return pattern
    if (
        purpose.url_class in DECLARED_CLASSES
        and host_of(url) not in _PATTERN_HOSTS
        and (purpose.site is None or registrable_domain(url) == purpose.site)
        # A college's or department's own site is no society's website (its
        # society-list page is a college society list, D3).
        and not (purpose.url_class == "society_website" and is_cam_main_site(url))
    ):
        return purpose.url_class
    return None


def robots_override(url: str, purpose: FetchPurpose) -> bool:
    """Whether a robots.txt disallow of `url` may be overridden."""
    return society_class(url, purpose) is not None


def ai_optout_override(url: str, purpose: FetchPurpose) -> bool:
    """Whether an AI opt-out on `url` (robots.txt or the page) may be
    overridden, so that its text may reach the LLM. Never for talks.cam or
    tbc.xyz."""
    return society_class(url, purpose) is not None


__all__ = [
    "AI_OVERRIDE_NOTE",
    "COLLEGE_SOCIETY_LIST",
    "DECLARED_CLASSES",
    "GENERAL",
    "GENERAL_DOMAINS",
    "GENERAL_HOSTS",
    "NATIONAL_DOMAINS",
    "NEVER_FETCH_HOSTS",
    "NEVER_OVERRIDE_HOSTS",
    "ROBOTS_OVERRIDE_NOTE",
    "SOCIETY",
    "SOCIETY_URL_CLASSES",
    "SOCIETY_WEBSITE",
    "FetchPurpose",
    "Scope",
    "SocietyUrlClass",
    "ai_optout_override",
    "host_of",
    "is_cam_main_site",
    "is_general_host",
    "never_fetched",
    "never_overridden",
    "registrable_domain",
    "robots_override",
    "society_class",
    "url_class_of",
]
