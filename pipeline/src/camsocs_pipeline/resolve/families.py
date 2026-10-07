"""Organisation-type families: which `ORG_TYPES` can ever be the same group.

Sources disagree about a group's type (the SU calls a sports club a
society; CUCBC calls a college boat club a club), so the resolver never
refuses a match over the *type*. It refuses one across *families*: a college,
a company and a student society are never one organisation, whatever their
names say ("Cambridge University Press" is not the "Press Society").
"""

from __future__ import annotations

_FAMILIES: dict[str, str] = {
    "society": "student_group",
    "sports_club": "student_group",
    "college_club": "student_group",
    "jcr": "student_group",
    "mcr": "student_group",
    "college_boat_club": "student_group",
    "theatre_company": "student_group",
    "media": "student_group",
    "other": "student_group",
    "college": "college",
    "department": "university_body",
    "uni_office": "university_body",
    "student_union": "student_union",
    "company": "external",
    "ngo": "external",
    "public_body": "external",
    "other_university_society": "other_university",
}

#: Types the pipeline may create from a mention alone (a sponsor named on a
#: page, a college a JCR belongs to): parties that exist in the database only
#: because a society is linked to them (`isCounterpart`, data-model §2).
COUNTERPART_TYPES = frozenset(
    {
        "college",
        "department",
        "uni_office",
        "student_union",
        "company",
        "ngo",
        "public_body",
        "other_university_society",
    }
)

_DEFAULT_LEVEL = {
    "college": "college",
    "department": "department",
    "uni_office": "university",
    "student_union": "university",
    "company": "external",
    "ngo": "external",
    "public_body": "external",
    "other_university_society": "external",
}


def family_of(org_type: str | None) -> str | None:
    """The family of an `ORG_TYPES` value; None when no source stated a type."""
    if org_type is None:
        return None
    return _FAMILIES.get(org_type, "student_group")


def default_level(org_type: str) -> str | None:
    """The level a counterpart of this type has when nobody said otherwise."""
    return _DEFAULT_LEVEL.get(org_type)


__all__ = ["COUNTERPART_TYPES", "default_level", "family_of"]
