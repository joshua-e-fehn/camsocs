"""What an identity is matched on — computed once per `IdentityHints`.

`identity_of` turns a harvester's hints (plus the websites and Instagram
links its observation states) into an `Identity`: identifier strings
(`crosswalk.ident`), name signatures (`names.py`), and the constraints a
match must respect (level, type family, colleges). The resolver, the
crosswalk and later stages (enrichment's counterparts) all use it, so a group
is recognised the same way everywhere.

`conflict` is the one place that says whether two identities *may* be the
same group: never across levels, type families or colleges, never when a
source lists them as two entries (two SU ids, two Sport slugs).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from camsocs_pipeline.models.observation import IdentityHints
from camsocs_pipeline.resolve.colleges import BY_ID as COLLEGES_BY_ID
from camsocs_pipeline.resolve.colleges import alias_table
from camsocs_pipeline.resolve.families import family_of
from camsocs_pipeline.resolve.names import (
    acronym,
    email_site,
    fold,
    instagram_handle,
    name_parts,
    site_identity,
    split_parenthetical,
)

#: Kinds whose values a source assigns to exactly one of its entries: two
#: identities with different values of one kind are two groups.
DISTINCT_KINDS = ("su", "su_slug", "proctors", "sport", "camdram", "camdram_slug", "cucbc")

#: Well-known short names whose signature is not their expansion's (LB §1.4:
#: "CUE is listed as 'Entrepreneurs Society'"; CICCU on the Proctors' list).
KNOWN_ALIASES: dict[str, str] = {
    "cue": "entrepreneurs",
    "ciccu": "christian intercollegiate union",
    "cuadc": "amateur dramatic",
    "cubc": "boat",
}

#: Levels at which a college named inside a group's name is not a college.
#: University-level groups keep theirs: the SU lists ~20 college groups
#: ("Pembroke Players"), and the name is all that ties them to the college
#: list's entry.
_NO_COLLEGE_LEVELS = frozenset({"department", "external"})
_NO_COLLEGE_FAMILIES = frozenset({"external", "university_body", "other_university"})
_COLLEGE_WORDS = frozenset({"college", "hall", "the", "of"})


def ident(kind: str, value: str | int) -> str:
    """An identifier string: ``su:8391``, ``ig:cugermansoc``, ``ref:su_directory:8391``."""
    text = str(value).strip()
    if kind in ("proctors", "cucbc"):
        text = fold(text)
    elif kind != "ref":
        text = text.lower()
    return f"{kind}:{text}"


def college_from_hint(text: str | None) -> str | None:
    """A college id from free text naming one ("Jesus", "Catz", "Gonville &
    Caius College"), or None when it names none or several."""
    if not text:
        return None
    parts = name_parts(text)
    if len(parts.colleges) != 1:
        return None
    return next(iter(parts.colleges))


def _is_college_name(name: str) -> str | None:
    """The college a name *is* ("Jesus College", "Peterhouse", "Clare Hall"),
    not one it merely mentions ("Jesus College Boat Club")."""
    words = fold(name).split()
    words = [w for w in words if w not in ("cambridge", "university")]
    table = alias_table()
    found: set[str] = set()
    rest: list[str] = []
    index = 0
    while index < len(words):
        for alias, college_id in table:
            if tuple(words[index : index + len(alias)]) == alias:
                found.add(college_id)
                index += len(alias)
                break
        else:
            rest.append(words[index])
            index += 1
    if len(found) == 1 and set(rest) <= _COLLEGE_WORDS:
        return next(iter(found))
    return None


@dataclass(frozen=True)
class Identity:
    """Everything a match looks at."""

    name: str
    level: str | None = None
    family: str | None = None
    #: Colleges this group belongs to (hint, or named in the name), as college ids.
    colleges: frozenset[str] = frozenset()
    #: The college a harvester said the group belongs to (drives `collegeKeys`).
    hint_college: str | None = None
    #: The college this identity *is*, for a college itself.
    college: str | None = None
    #: Identifier strings of `DISTINCT_KINDS`.
    explicit: frozenset[str] = frozenset()
    #: ``ig:`` and ``site:`` identifier strings.
    strong: frozenset[str] = frozenset()
    signatures: frozenset[str] = frozenset()
    core_signature: str | None = None
    known_key: str | None = None
    acronyms: frozenset[str] = field(default_factory=frozenset)

    @property
    def ids(self) -> frozenset[str]:
        return self.explicit | self.strong

    def explicit_of(self, kind: str) -> set[str]:
        prefix = f"{kind}:"
        return {value for value in self.explicit if value.startswith(prefix)}


def identity_of(
    hints: IdentityHints,
    *,
    websites: Iterable[str] = (),
    instagram: Iterable[str] = (),
) -> Identity:
    """The `Identity` of `hints`; `websites` / `instagram` are what the same
    observation states as the group's site and Instagram (its fields)."""
    family = family_of(hints.org_type)
    level = hints.level
    hint_college = college_from_hint(hints.college_hint)
    find_colleges = level not in _NO_COLLEGE_LEVELS and family not in _NO_COLLEGE_FAMILIES

    college = None
    if family in (None, "college") and level in (None, "college"):
        college = _is_college_name(hints.name)
    if family == "college" and college is None:
        college = hint_college

    parts = name_parts(split_parenthetical(hints.name)[0], find_colleges=find_colleges)
    colleges = set(parts.colleges) if find_colleges else set()
    if hint_college:
        colleges.add(hint_college)
    if college:
        colleges = {college}

    signatures: set[str] = set()
    acronyms: set[str] = set()
    if college is None:
        main, bracketed = split_parenthetical(hints.name)
        texts = [main, *bracketed, *hints.aliases]
        for text in texts:
            if len(fold(text).replace(" ", "")) <= 2:
                continue
            signature = name_parts(text, find_colleges=find_colleges).signature(frozenset(colleges))
            if signature:
                signatures.add(signature)
                alias = KNOWN_ALIASES.get(signature)
                if alias:
                    signatures.add(alias)
        initials = acronym(main)
        if initials and len(initials) >= 3:
            acronyms.add(initials)

    explicit: set[str] = set()
    for kind, value in (
        ("su", hints.su_id),
        ("su_slug", hints.su_slug),
        ("proctors", hints.proctors_name),
        ("sport", hints.sport_slug),
        ("camdram", hints.camdram_id),
        ("camdram_slug", hints.camdram_slug),
        ("cucbc", hints.cucbc_club),
    ):
        if value not in (None, ""):
            explicit.add(ident(kind, value))

    strong: set[str] = set()
    for value in [hints.instagram_handle, *instagram]:
        handle = instagram_handle(value)
        if handle:
            strong.add(ident("ig", handle))
    for value in [hints.website_domain, *websites]:
        site = site_identity(value)
        if site:
            strong.add(ident("site", site))
    site = email_site(hints.email_domain)
    if site:
        strong.add(ident("site", site))

    return Identity(
        name=hints.name,
        level=level,
        family=family,
        colleges=frozenset(colleges),
        hint_college=hint_college,
        college=college,
        explicit=frozenset(explicit),
        strong=frozenset(strong),
        signatures=frozenset(signatures),
        core_signature=parts.core_signature,
        known_key=hints.known_key,
        acronyms=frozenset(acronyms),
    )


@dataclass(frozen=True)
class Profile:
    """The match constraints of one identity or of a group of them."""

    levels: frozenset[str] = frozenset()
    families: frozenset[str] = frozenset()
    #: Distinct non-empty college sets among the members.
    college_sets: frozenset[frozenset[str]] = frozenset()
    explicit: frozenset[str] = frozenset()

    @classmethod
    def of(cls, identity: Identity) -> Profile:
        return cls(
            levels=frozenset({identity.level} if identity.level else ()),
            families=frozenset({identity.family} if identity.family else ()),
            college_sets=frozenset({identity.colleges} if identity.colleges else ()),
            explicit=identity.explicit,
        )

    def merged(self, other: Profile) -> Profile:
        return Profile(
            self.levels | other.levels,
            self.families | other.families,
            self.college_sets | other.college_sets,
            self.explicit | other.explicit,
        )


def conflict(a: Profile, b: Profile) -> tuple[str, str] | None:
    """Why two groups must not be merged automatically, as ``(category,
    reason)``, or None. Categories: ``family`` (different kinds of thing),
    ``level``, ``college``, ``distinct`` (a source lists them separately)."""
    if a.families and b.families and not a.families & b.families:
        return "family", f"types differ ({'/'.join(sorted(a.families | b.families))})"
    if a.levels and b.levels and not a.levels & b.levels:
        return "level", f"levels differ ({' vs '.join(sorted(a.levels | b.levels))})"
    sets = a.college_sets | b.college_sets
    if a.college_sets and b.college_sets and len(sets) > 1:
        names = sorted({COLLEGES_BY_ID[c].name for s in sets for c in s if c in COLLEGES_BY_ID})
        return "college", f"different colleges ({', '.join(names)})"
    for kind in DISTINCT_KINDS:
        prefix = f"{kind}:"
        mine = {value for value in a.explicit if value.startswith(prefix)}
        theirs = {value for value in b.explicit if value.startswith(prefix)}
        if mine and theirs and not mine & theirs:
            listed = ", ".join(sorted(mine | theirs))
            return "distinct", f"separate entries in one source ({listed})"
    return None


__all__ = [
    "DISTINCT_KINDS",
    "KNOWN_ALIASES",
    "Identity",
    "Profile",
    "college_from_hint",
    "conflict",
    "ident",
    "identity_of",
]
