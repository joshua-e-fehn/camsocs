"""Normalising the things identities are matched on: names, Instagram
handles and websites.

**Names.** Sources name one group many ways — "Cambridge University Hockey
Club", "CU Hockey", "Hockey Club (CU)", "Hockey". A *signature* keeps what
identifies the group and drops what every Cambridge group says about itself:

1. fold to ASCII lower case (`fold`): NFKD, the key transliteration, ``&`` →
   ``and``, apostrophes and hyphens deleted ("Queens'" → ``queens``,
   "Inter-Collegiate" → ``intercollegiate``);
2. drop the University qualifiers ("Cambridge University", "University of
   Cambridge", "Cambridge", a ``CU`` token anywhere, "(CU)" included), the
   group words ("Society", "Soc", "Club") and small stopwords;
3. keep gender and team qualifiers ("men", "women", "mixed"): the three
   Lacrosse clubs stay three;
4. replace a college named in the name by one ``c:<id>`` token
   (`colleges.py`), and drop the word "College" after it — "Jesus College
   Boat Club" → ``boat c:jesus``;
5. sort the remaining tokens, so "Lacrosse (Women's)" and "Women's Lacrosse
   Club" agree.

A signature with nothing left ("The Society") matches nothing.

**Instagram handles** are lower case without ``@`` or URL (`instagram_handle`).

**Websites** become a *site identity* (`site_identity`): the host without
``www.``, plus the first path segment(s) on hosts that many groups share
(``sites.google.com/view/x``, ``linktr.ee/x``, a page under a college's
``*.cam.ac.uk`` site). Hosts that identify no group (social networks, the SU
and Sport directories, Camdram, form builders) have no identity.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlsplit

from camsocs_pipeline.resolve.colleges import alias_table

_TRANSLITERATION = {
    "ß": "ss",
    "æ": "ae",
    "ø": "o",
    "œ": "oe",
    "ł": "l",
    "đ": "d",
    "ð": "d",
    "þ": "th",
    chr(0x0131): "i",
}
_APOSTROPHES = re.compile("['`" + chr(0x2019) + chr(0x2018) + chr(0x02BC) + "]")
_HYPHENS = re.compile("[-" + chr(0x2010) + chr(0x2011) + chr(0x2013) + chr(0x2014) + "]")
_TOKEN = re.compile(r"[a-z0-9]+")

#: Token sequences meaning "of the University of Cambridge", removed anywhere.
_UNIVERSITY_SEQUENCES: tuple[tuple[str, ...], ...] = (
    ("university", "of", "cambridge"),
    ("uoc",),
    ("cambridge", "university"),
    ("cambridge", "uni"),
    ("cambridge",),
    ("cu",),
)
#: Words every group uses about itself.
_GROUP_WORDS = frozenset({"society", "societies", "soc", "club", "the"})
_STOPWORDS = frozenset({"of", "for", "and", "in", "at", "a", "an", "on", "to"})
_GENDER = {
    "mens": "men",
    "men": "men",
    "womens": "women",
    "women": "women",
    "ladies": "women",
    "mixed": "mixed",
}

#: A college token in a signature.
COLLEGE_PREFIX = "c:"


def fold(text: str) -> str:
    """ASCII lower case with apostrophes and hyphens deleted; other punctuation
    becomes a space."""
    out = unicodedata.normalize("NFKD", text)
    out = "".join(_TRANSLITERATION.get(char.lower(), char) for char in out)
    out = "".join(char for char in out if not unicodedata.category(char).startswith("M"))
    out = out.replace("&", " and ")
    out = _APOSTROPHES.sub("", out)
    out = _HYPHENS.sub("", out)
    out = out.lower()
    return " ".join(_TOKEN.findall(out))


def tokens(text: str) -> list[str]:
    return fold(text).split()


@dataclass(frozen=True)
class NameParts:
    """A name reduced to what identifies the group."""

    #: Core tokens in order (no qualifiers, colleges or stopwords).
    core: tuple[str, ...]
    #: Colleges named in the name (college ids).
    colleges: frozenset[str]

    def signature(self, colleges: frozenset[str] | None = None) -> str | None:
        """Sorted core tokens plus ``c:<id>`` for `colleges` (default: those
        named in the name). None when nothing identifying is left."""
        if not self.core:
            return None
        named = self.colleges if colleges is None else colleges
        return " ".join(sorted({*self.core, *(COLLEGE_PREFIX + c for c in named)}))

    @property
    def core_signature(self) -> str | None:
        """The signature without colleges — for spotting a club shared between colleges."""
        return " ".join(sorted(set(self.core))) if self.core else None


def _remove_sequences(words: list[str], sequences: tuple[tuple[str, ...], ...]) -> list[str]:
    out: list[str] = []
    index = 0
    while index < len(words):
        for sequence in sequences:
            if tuple(words[index : index + len(sequence)]) == sequence:
                index += len(sequence)
                break
        else:
            out.append(words[index])
            index += 1
    return out


def _extract_colleges(words: list[str]) -> tuple[list[str], set[str]]:
    """Replace college aliases (longest first) and drop a following "college"/"hall"."""
    out: list[str] = []
    found: set[str] = set()
    table = alias_table()
    index = 0
    while index < len(words):
        for alias, college_id in table:
            if tuple(words[index : index + len(alias)]) == alias:
                found.add(college_id)
                index += len(alias)
                if index < len(words) and words[index] in ("college", "colleges"):
                    index += 1
                break
        else:
            out.append(words[index])
            index += 1
    return out, found


def name_parts(name: str, *, find_colleges: bool = True) -> NameParts:
    """`NameParts` of a group's name. `find_colleges=False` for groups known
    not to be college-level, where "Darwin" or "Trinity" in a name is not a
    college."""
    words = tokens(name)
    words = _remove_sequences(words, _UNIVERSITY_SEQUENCES)
    colleges: set[str] = set()
    if find_colleges:
        words, colleges = _extract_colleges(words)
    core = [
        _GENDER.get(word, word)
        for word in words
        if word not in _GROUP_WORDS and word not in _STOPWORDS
    ]
    return NameParts(tuple(core), frozenset(colleges))


_PARENTHETICAL = re.compile(r"\s*[(\[]([^()\[\]]{1,60})[)\]]\s*")


#: Words that qualify a name in brackets rather than rename the group:
#: "Lacrosse (Men's)" is another club than "Lacrosse (Women's)".
_QUALIFIERS = frozenset(
    {
        "men",
        "mens",
        "women",
        "womens",
        "ladies",
        "mixed",
        "open",
        "lightweight",
        "heavyweight",
        "novice",
        "novices",
        "senior",
        "seniors",
        "junior",
        "juniors",
        "a",
        "b",
        "c",
        "firsts",
        "seconds",
        "1st",
        "2nd",
        "jcr",
        "mcr",
        "undergraduate",
        "postgraduate",
        "graduate",
    }
)


def split_parenthetical(name: str) -> tuple[str, list[str]]:
    """``"Cambridge University Entrepreneurs (CUE)"`` → ``("Cambridge
    University Entrepreneurs", ["CUE"])``: what a name says in brackets is
    another name for the group (an acronym, "(Addies Boat Club)", "(CU)",
    "(UoC)") — unless it only qualifies the name ("Lacrosse (Men's)"), which
    stays in it."""
    aliases: list[str] = []

    def keep_or_take(match: re.Match[str]) -> str:
        inner = match.group(1).strip()
        words = fold(inner).split()
        if words and all(word in _QUALIFIERS for word in words):
            return f" {inner} "
        aliases.append(inner)
        return " "

    main = " ".join(_PARENTHETICAL.sub(keep_or_take, name).split())
    return (main or name), aliases


def acronym(name: str) -> str | None:
    """Initials of a name's words, keeping "C U" for "Cambridge University" —
    "Cambridge University Entrepreneurs" → ``cue``. For review hints only."""
    words = [word for word in tokens(name) if word not in _STOPWORDS and word != "the"]
    if len(words) < 2:
        return None
    return "".join(word[0] for word in words)


# --- Instagram ----------------------------------------------------------------------------

_INSTAGRAM_RESERVED = frozenset(
    {"p", "reel", "reels", "explore", "stories", "accounts", "tv", "about", "developer", "legal"}
)
_HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")


def instagram_handle(value: str | None) -> str | None:
    """``@CUGermanSoc`` / ``instagram.com/cugermansoc/`` → ``cugermansoc``."""
    if not value:
        return None
    text = value.strip()
    if "instagram.com" in text.lower() or text.lower().startswith(("http://", "https://")):
        parts = urlsplit(text if "://" in text else f"https://{text}")
        if not parts.netloc.lower().endswith("instagram.com"):
            return None
        segments = [segment for segment in parts.path.split("/") if segment]
        if not segments:
            return None
        text = segments[0]
    handle = text.lstrip("@").strip().lower()
    if handle in _INSTAGRAM_RESERVED or not _HANDLE.match(handle):
        return None
    return handle


# --- websites -----------------------------------------------------------------------------

#: Hosts that identify no group: networks, directories, form builders, platforms.
NO_IDENTITY_HOSTS = frozenset(
    {
        "facebook.com",
        "m.facebook.com",
        "fb.com",
        "instagram.com",
        "x.com",
        "twitter.com",
        "linkedin.com",
        "uk.linkedin.com",
        "tiktok.com",
        "youtube.com",
        "youtu.be",
        "threads.net",
        "bsky.app",
        "cambridgesu.co.uk",
        "sport.cam.ac.uk",
        "live-cambridge-sports-cwp.pantheonsite.io",
        "camdram.net",
        # CUCBC's site is a directory of its clubs (/node/N): a club page
        # there is not the club's own site, so it identifies no one.
        "cucbc.org",
        "talks.cam.ac.uk",
        "lists.cam.ac.uk",
        "proctors.cam.ac.uk",
        "cam.ac.uk",
        "docs.google.com",
        "forms.gle",
        "forms.office.com",
        "eventbrite.co.uk",
        "eventbrite.com",
        "fixr.co",
        "lu.ma",
        "luma.com",
        "discord.gg",
        "discord.com",
        "chat.whatsapp.com",
        "wa.me",
        "t.me",
        "mailchi.mp",
        "eepurl.com",
        "bit.ly",
        "tinyurl.com",
        "wikipedia.org",
        "en.wikipedia.org",
        "srcf.net",
        "github.com",
    }
)
#: Hosts shared by many groups: the identity includes the first path segment(s).
SHARED_HOSTS: dict[str, int] = {
    "sites.google.com": 2,
    "linktr.ee": 1,
    "beacons.ai": 1,
    "linkin.bio": 1,
    "carrd.co": 1,
    "notion.site": 1,
    "wordpress.com": 1,
    "srcf.ucam.org": 1,
    "users.srcf.net": 1,
}


def _host(url: str) -> tuple[str, str]:
    text = url.strip()
    if "://" not in text:
        text = f"https://{text}"
    parts = urlsplit(text)
    host = parts.netloc.lower().split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    return host, parts.path


def site_identity(url: str | None) -> str | None:
    """A website's identity for matching, or None if the host identifies no group."""
    if not url or not url.strip():
        return None
    host, path = _host(url)
    if not host or "." not in host or host in NO_IDENTITY_HOSTS:
        return None
    segments = [segment.lower() for segment in path.split("/") if segment]
    depth = SHARED_HOSTS.get(host)
    if depth is None and (host.endswith(".cam.ac.uk") or host.endswith(".ox.ac.uk")):
        # A group's page under a college or department site: the page is the identity.
        depth = len(segments)
    if depth:
        if len(segments) < depth:
            return None
        return "/".join([host, *segments[:depth]])
    return host


#: Email domains that say nothing about which group an address belongs to.
SHARED_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "hotmail.com",
        "hotmail.co.uk",
        "outlook.com",
        "live.com",
        "yahoo.com",
        "yahoo.co.uk",
        "icloud.com",
        "protonmail.com",
        "proton.me",
        "cam.ac.uk",
        "cantab.net",
        "cambridgesu.co.uk",
        "cusu.cam.ac.uk",
        "srcf.net",
        "sport.cam.ac.uk",
        "lists.cam.ac.uk",
    }
)


def email_site(domain: str | None) -> str | None:
    """An email domain as a site identity, when it is the group's own domain."""
    if not domain:
        return None
    host = domain.strip().lower().lstrip("@")
    if host.startswith("www."):
        host = host[4:]
    if not host or host in SHARED_EMAIL_DOMAINS or host.endswith(".cam.ac.uk"):
        return None
    return site_identity(host)


__all__ = [
    "COLLEGE_PREFIX",
    "NO_IDENTITY_HOSTS",
    "SHARED_EMAIL_DOMAINS",
    "SHARED_HOSTS",
    "NameParts",
    "acronym",
    "email_site",
    "fold",
    "instagram_handle",
    "name_parts",
    "site_identity",
    "split_parenthetical",
    "tokens",
]
