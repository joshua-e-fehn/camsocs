"""One fetched society web page, parsed: readable text, links, emails,
embedded structured data, robots meta, platform (source-research §14).

Everything here is deterministic. The text is what the LLM later reads *and*
what its evidence quotes are checked against (`extract/evidence.py`), so it is
built once, here.

- **Text**: scripts, styles, navigation, header, footer, forms and asides are
  dropped; the ``<main>`` (or ``[role=main]`` / ``<article>``) element is used
  when it holds enough text, the body otherwise; blank runs collapse.
- **Links**: every ``<a href>`` resolved against the page, with its anchor
  text and the region it sits in (``nav`` / ``header`` / ``footer`` / ``main``).
- **Emails**: ``mailto:`` targets and addresses written in the visible text.
  Obfuscated addresses are **never decoded** (AGENTS.md): Cloudflare email
  protection (``/cdn-cgi/l/email-protection``, ``data-cfemail``) and anything
  written as "name [at] domain" are skipped.
- **Structured data** through extruct (JSON-LD, microdata, OpenGraph).
- **Robots meta**: ``noindex`` / ``nofollow`` / ``noai`` / ``noimageai``
  directives for any user agent (``robots``) are honoured by the caller.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from html import unescape as html_unescape
from typing import Any
from urllib.parse import unquote, urljoin, urlsplit

import extruct
from selectolax.lexbor import LexborHTMLParser, LexborNode

logger = logging.getLogger(__name__)

#: Text below this many characters in <main> means the theme put the content elsewhere.
MIN_MAIN_TEXT = 200
#: Upper bound on a page's kept text; the LLM sees a budgeted part of it.
MAX_PAGE_TEXT = 60_000

_DROP_ALWAYS = "script, style, noscript, svg, template, iframe, canvas, object"
_DROP_FOR_TEXT = "nav, header, footer, aside, form, [role=navigation], [role=contentinfo]"
_EMAIL = re.compile(r"(?<![\w.+-])([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)+)", re.I)
_BLANKS = re.compile(r"\n\s*\n+")
#: Before these tags a line ends: block boundaries become newlines in the
#: text, inline elements (links, emphasis) stay inside their sentence.
_BLOCK_BREAK = re.compile(
    r"<(br|hr|/p|/div|/li|/h[1-6]|/tr|/td|/th|/section|/article|/blockquote|/dt|/dd|"
    r"/figcaption|/ul|/ol|/table|/button|/label)\b",
    re.I,
)
_SPACES = re.compile("[ \t" + chr(0xA0) + "]+")


@dataclass(frozen=True)
class Link:
    url: str
    text: str
    region: str


@dataclass
class Page:
    """A parsed HTML page."""

    url: str
    title: str = ""
    text: str = ""
    links: list[Link] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    #: The addresses in the page's own content (not its navigation, header or
    #: footer) — for a site that is a sub-page of somebody else's.
    main_emails: list[str] = field(default_factory=list)
    #: Robots meta directives, lower case (``noindex``, ``nofollow``, ``noai``, …).
    robots: frozenset[str] = frozenset()
    platform: str | None = None
    structured: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: How many obfuscated addresses were seen and deliberately left alone.
    obfuscated_emails: int = 0


def _region(node: LexborNode) -> str:
    current: LexborNode | None = node.parent
    while current is not None and current.tag not in ("body", "html"):
        tag = current.tag
        role = (current.attributes.get("role") or "").lower()
        if tag == "nav" or role == "navigation":
            return "nav"
        if tag == "header" or role == "banner":
            return "header"
        if tag == "footer" or role == "contentinfo":
            return "footer"
        current = current.parent
    return "main"


def _clean_text(text: str) -> str:
    lines = [_SPACES.sub(" ", line).strip() for line in text.splitlines()]
    joined = "\n".join(line for line in lines)
    return _BLANKS.sub("\n\n", joined).strip()


def robots_directives(html: str) -> frozenset[str]:
    """The ``<meta name="robots">`` directives of a page (``noindex``,
    ``noai``, …), lowercased."""
    return _robots_meta(LexborHTMLParser(html))


def _robots_meta(tree: LexborHTMLParser) -> frozenset[str]:
    directives: set[str] = set()
    for meta in tree.css("meta[name]"):
        name = (meta.attributes.get("name") or "").lower()
        if name in ("robots", "googlebot", "camsocs-bot"):
            content = (meta.attributes.get("content") or "").lower()
            directives |= {part.strip() for part in content.split(",") if part.strip()}
    return frozenset(directives)


def _mailto(href: str) -> list[str]:
    """The addresses of a ``mailto:`` link, as sites write them: plain,
    several comma-separated, "Name <address>", or with a stray trailing slash."""
    target = html_unescape(unquote(href[len("mailto:") :])).split("?", 1)[0]
    found = (_EMAIL.search(part) for part in target.split(","))
    return [match.group(1) for match in found if match]


def parse_page(url: str, html: str) -> Page:
    """Parse `html` fetched from `url` (the final URL after redirects)."""
    page = Page(url=url)
    tree = LexborHTMLParser(_BLOCK_BREAK.sub(lambda m: "\n<" + m.group(1), html))
    title = tree.css_first("title")
    page.title = _clean_text(title.text()) if title else ""
    page.robots = _robots_meta(tree)
    page.platform = detect_platform(url, html)
    try:
        page.structured = extruct.extract(
            html,
            base_url=url,
            syntaxes=["json-ld", "microdata", "opengraph"],
            uniform=True,
            errors="ignore",
        )
    except Exception as error:  # extruct raises a variety of parser errors
        logger.debug("structured data unreadable on %s: %s", url, error)
        page.structured = {}

    emails: list[str] = []
    main_emails: list[str] = []
    seen_links: set[tuple[str, str]] = set()
    for anchor in tree.css("a[href]"):
        href = (anchor.attributes.get("href") or "").strip()
        if not href:
            continue
        if "email-protection" in href or anchor.attributes.get("data-cfemail") is not None:
            page.obfuscated_emails += 1
            continue
        if href.lower().startswith("mailto:"):
            found = _mailto(href)
            emails += found
            if _region(anchor) == "main":
                main_emails += found
            continue
        absolute = urljoin(url, href)
        if urlsplit(absolute).scheme not in ("http", "https"):
            continue
        text = _SPACES.sub(" ", anchor.text(separator=" ", strip=True)).strip()
        if not text:
            text = anchor.attributes.get("aria-label") or anchor.attributes.get("title") or ""
        region = _region(anchor)
        if (absolute, region) in seen_links:
            continue
        seen_links.add((absolute, region))
        page.links.append(Link(absolute, text[:200], region))
    page.obfuscated_emails += len(tree.css("span[data-cfemail]"))

    for node in tree.css(_DROP_ALWAYS):
        node.decompose()
    full_text = tree.body.text(separator="", strip=False) if tree.body else ""
    emails += [match.group(1) for match in _EMAIL.finditer(full_text)]

    for node in tree.css(_DROP_FOR_TEXT):
        node.decompose()
    text = ""
    for selector in ("main", "[role=main]", "article"):
        main = tree.css_first(selector)
        if main is not None:
            candidate = _clean_text(main.text(separator="", strip=False))
            if len(candidate) >= MIN_MAIN_TEXT:
                text = candidate
                break
    if not text and tree.body is not None:
        text = _clean_text(tree.body.text(separator="", strip=False))
    page.text = text[:MAX_PAGE_TEXT]
    main_emails += [match.group(1) for match in _EMAIL.finditer(page.text)]
    page.emails = list(dict.fromkeys(email.lower().rstrip(".") for email in emails))
    page.main_emails = list(dict.fromkeys(email.lower().rstrip(".") for email in main_emails))
    return page


# --- platform ------------------------------------------------------------------------------

_GENERATOR = re.compile(r'<meta[^>]+name=["\']generator["\'][^>]+content=["\']([^"\']+)', re.I)

#: (needle in the HTML, lower case) → platform, in order.
_MARKERS: tuple[tuple[str, str], ...] = (
    ("static.wixstatic.com", "wix"),
    ("wix.com website builder", "wix"),
    ("static1.squarespace.com", "squarespace"),
    ("this is squarespace", "squarespace"),
    ("wp-content/", "wordpress"),
    ("wp-includes/", "wordpress"),
    ("data-wf-site", "webflow"),
    ("cdn.prod.website-files.com", "webflow"),
    ("framerusercontent.com", "framer"),
    ("weebly.com", "weebly"),
    ("cdn.shopify.com", "shopify"),
    ("drupal.settings", "drupal"),
    ("data-drupal", "drupal"),
    ("__next_data__", "nextjs"),
    ("/_next/static", "nextjs"),
    ("__sveltekit", "sveltekit"),
    ("data-sveltekit", "sveltekit"),
    ("astro-island", "astro"),
    ("/_astro/", "astro"),
    ("ghost-", "ghost"),
    ("joomla", "joomla"),
)
_HOSTS: tuple[tuple[str, str], ...] = (
    ("sites.google.com", "google_sites"),
    ("github.io", "github_pages"),
    ("notion.site", "notion"),
    ("carrd.co", "carrd"),
    ("linktr.ee", "linktree"),
    ("wordpress.com", "wordpress_com"),
)


def detect_platform(url: str, html: str) -> str | None:
    """The site builder or framework a page was made with, from its host,
    ``<meta name="generator">`` and tell-tale asset paths. None if unknown."""
    host = urlsplit(url).netloc.lower()
    for needle, platform in _HOSTS:
        if host.endswith(needle):
            return platform
    generator = _GENERATOR.search(html[:50_000])
    if generator:
        value = generator.group(1).lower()
        for needle, platform in (
            ("wordpress.com", "wordpress_com"),
            ("wordpress", "wordpress"),
            ("wix", "wix"),
            ("squarespace", "squarespace"),
            ("drupal", "drupal"),
            ("jekyll", "jekyll"),
            ("hugo", "hugo"),
            ("astro", "astro"),
            ("ghost", "ghost"),
            ("joomla", "joomla"),
            ("webflow", "webflow"),
            ("hexo", "hexo"),
            ("mkdocs", "mkdocs"),
        ):
            if needle in value:
                return platform
    lowered = html.lower()
    for needle, platform in _MARKERS:
        if needle in lowered:
            return platform
    if '<div id="root"></div>' in lowered or '<div id="app"></div>' in lowered:
        return "spa"
    return None


__all__ = ["Link", "Page", "detect_platform", "parse_page"]
