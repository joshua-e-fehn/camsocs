"""Deterministic classification: what a rule can say about an organisation
before any model is asked (the classify stage's first pass).

Every rule fills only what no source has claimed, and says ``inferred``
(a parser claim with `inferred=True`): it reads a register's listing or a
name, not a statement of the field itself. A found claim from any source
outranks it without a conflict (data-model §1.2), so a later source that
knows better simply wins.

**Type and level** of a society the SU or the Proctors register, when no
source states them (`type_and_level`), on the register's own record:

- a college named in the name ("Pembroke Art Society", "St John's College
  Music Society", "… of Queens' College") → ``college_club`` at ``college``
  level, with the college's key; "Fitzwilliam Museum" is the museum;
- a department, faculty or school named in the name ("Faculty of Education
  …", "Clinical School …", "… Business School …") → ``department`` level;
- otherwise ``society`` at ``university`` level — what registering with the
  SU or the Proctors makes a group;
- a name that says it is a publication or a station ("Journal", "Review",
  "Magazine", "Radio") → ``media``.

Names that may be something other than a society (a trust, a corps, a
chaplaincy, "Media") are `ambiguous_type`: the model is asked for their
type, with a quote; the rule's ``society`` stands when it has none.

**Categories** (`category_rules`, at most three, for an organisation no
source categorises): sport (a sport in the name), faith (a religion or
chaplaincy), cultural_international (a country, nationality, region or
language community), music (an ensemble), theatre_film_dance (drama,
film, dance), media_publishing (a publication or station); a JCR or MCR is
identity_wellbeing (a college's community and welfare body). The Sports
Service's clubs, CUCBC's and Camdram's already carry theirs.

**Audiences** (`audience_rules`): graduate / postgraduate societies,
women's and men's groups (not "Women in Law": such societies welcome
everyone), LGBTQ+ groups, international students — only as the name says.

**Activity types** (`activity_rules`): a sports club trains and competes; a
theatre company or a musical ensemble performs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from camsocs_pipeline.classify.profile import OrgProfile
from camsocs_pipeline.models.observation import Observation
from camsocs_pipeline.resolve.colleges import BY_ID as COLLEGES_BY_ID
from camsocs_pipeline.resolve.names import fold, name_parts

#: Registers whose listing makes a group a University-level society.
SOCIETY_REGISTERS = ("su", "proctors")
#: The register records the type rule writes on, best first.
REGISTER_SOURCES = ("su_directory", "proctors_register")


@dataclass(frozen=True)
class RuleClaim:
    """One value a rule derives, attributed to the record it read."""

    field: str
    value: Any
    record: Observation
    extractor: str
    #: What in the source the rule read (the claim's ``valueRaw``).
    value_raw: str | None = None


def _pattern(*words: str) -> re.Pattern[str]:
    return re.compile(r"\b(" + "|".join(words) + r")\b")


# --- type and level ----------------------------------------------------------------------

#: A college named for what it is not ("Fitzwilliam Museum Society").
_NOT_COLLEGES = _pattern("fitzwilliam museum", "darwin day", "holy trinity", "jesus christ")
_DEPARTMENT = _pattern(
    "faculty of",
    "department of",
    "dept of",
    "school of",
    "business school",
    "clinical school",
    "judge business school",
)
_MEDIA = _pattern("journal", "review", "magazine", "newspaper", "gazette", "radio", "podcast")
#: Names that may be something other than a student society: asked of the model.
_AMBIGUOUS = _pattern(
    "journal",
    "review",
    "magazine",
    "newspaper",
    "gazette",
    "radio",
    "podcast",
    "press",
    "media",
    "publishing",
    "trust",
    "foundation",
    "chaplaincy",
    "corps",
    "squadron",
    "naval",
    "regiment",
    "unit",
    "hub",
    "initiative",
    "laboratory",
    "lab",
    "fund",
    "centre",
    "institute",
)


def _folded(text: str) -> str:
    return fold(text)


def college_in_name(name: str) -> str | None:
    """The one college a group's name names, as a college id ("Fitz Swing
    Band" → ``fitzwilliam``), or None (none, several, or a namesake)."""
    if _NOT_COLLEGES.search(_folded(name)):
        return None
    colleges = name_parts(name).colleges
    return next(iter(colleges)) if len(colleges) == 1 else None


def ambiguous_type(profile: OrgProfile) -> bool:
    """Whether a registered society's name suggests another type (module docstring)."""
    return any(_AMBIGUOUS.search(_folded(name)) for name in _register_names(profile))


def _register_record(profile: OrgProfile) -> Observation | None:
    return profile.record(*REGISTER_SOURCES)


def _register_names(profile: OrgProfile) -> list[str]:
    record = _register_record(profile)
    if record is None:
        return []
    return list(dict.fromkeys([record.identity.name, *record.identity.aliases]))


def type_and_level(profile: OrgProfile, *, college_keys: set[str]) -> list[RuleClaim]:
    """orgType, level and collegeKeys of a registered society (module
    docstring). `college_keys`: colleges that exist as organisations."""
    record = _register_record(profile)
    if record is None or not any(profile.registered(r) for r in SOCIETY_REGISTERS):
        return []
    name = record.identity.name
    folded = _folded(name)
    claims: list[RuleClaim] = []
    college = college_in_name(name)
    department = _DEPARTMENT.search(folded)
    if college is not None:
        org_type, level = "college_club", "college"
        raw = f"named for {COLLEGES_BY_ID[college].name}: {name}"
        college_key = COLLEGES_BY_ID[college].key
        if not profile.has("collegeKeys") and college_key in college_keys:
            claims.append(
                RuleClaim("collegeKeys", [college_key], record, "classify.college_in_name", raw)
            )
    elif department is not None:
        org_type, level = "society", "department"
        raw = f"names a department ({department.group(0)}): {name}"
    else:
        org_type, level = "society", "university"
        raw = f"registered society: {name}"
    if _MEDIA.search(folded) and college is None:
        org_type = "media"
        raw = f"a publication or station: {name}"
    if not profile.has("orgType"):
        claims.append(RuleClaim("orgType", org_type, record, "classify.registered_society", raw))
    if not profile.has("level"):
        claims.append(RuleClaim("level", level, record, "classify.registered_society", raw))
    return claims


# --- categories --------------------------------------------------------------------------

_SPORT = _pattern(
    "badminton",
    "volleyball",
    "netball",
    "football",
    "futsal",
    "rugby",
    "cricket",
    "hockey",
    "tennis",
    "squash",
    "rowing",
    "rowers",
    "boat club",
    "sailing",
    "swimming",
    "water polo",
    "athletics",
    "crosscountry",
    "cycling",
    "muay thai",
    "kickboxing",
    "karate",
    "judo",
    "jiujitsu",
    "jujitsu",
    "taekwondo",
    "kung fu",
    "wushu",
    "boxing",
    "fencing",
    "archery",
    "lacrosse",
    "quadball",
    "quidditch",
    "frisbee",
    "basketball",
    "baseball",
    "softball",
    "golf",
    "kabaddi",
    "wrestling",
    "weightlifting",
    "powerlifting",
    "triathlon",
    "orienteering",
    "pole sports",
    "pole fitness",
    "dancesport",
    "sport stacking",
    "country sports",
    "skiing",
    "snowboard",
    "snowsports",
    "climbing",
    "bouldering",
    "table tennis",
    "handball",
    "korfball",
    "dodgeball",
    "gymnastics",
    "cheerleading",
    "trampolining",
    "equestrian",
    "polo",
    "darts",
    "snooker",
)
_FAITH = _pattern(
    "christian",
    "christians",
    "christian union",
    "ciccu",
    "catholic",
    "chaplaincy",
    "church",
    "anglican",
    "methodist",
    "baptist",
    "evangelical",
    "bible",
    "islam",
    "islamic",
    "muslim",
    "muslims",
    "ahmadiyya",
    "ahlul bayt",
    "jewish",
    "chabad",
    "judaism",
    "hindu",
    "sikh",
    "buddhist",
    "buddhism",
    "bahai",
    "krishna",
    "jain",
    "zoroastrian",
    "quaker",
    "interfaith",
)
_CULTURE = _pattern(
    "afghan",
    "african",
    "albanian",
    "american",
    "arab",
    "argentina",
    "argentine",
    "armenian",
    "asia",
    "asian",
    "australian",
    "austrian",
    "azerbaijani",
    "bangla",
    "bangladeshi",
    "belgian",
    "brazilian",
    "bulgarian",
    "cantabulgarian",
    "caledonian",
    "canadian",
    "caribbean",
    "catalan",
    "chile",
    "chilean",
    "china",
    "chinese",
    "colombian",
    "croatian",
    "cypriot",
    "czech",
    "danish",
    "dutch",
    "egyptian",
    "estonian",
    "ethiopian",
    "european",
    "filipino",
    "finnish",
    "french",
    "german",
    "ghanaian",
    "greek",
    "hellenic",
    "hispanic",
    "hong kong",
    "hungarian",
    "icelandic",
    "india",
    "indian",
    "indonesia",
    "indonesian",
    "iranian",
    "irish",
    "israeli",
    "italian",
    "jamaican",
    "japan",
    "japanese",
    "kazakh",
    "kenyan",
    "kerala",
    "korean",
    "kurdish",
    "latin american",
    "latvian",
    "lebanese",
    "lithuanian",
    "luxembourg",
    "malaysia",
    "malaysian",
    "mauritius",
    "mauritian",
    "mexican",
    "middle eastern",
    "nepal",
    "nepali",
    "new zealand",
    "nigerian",
    "nordic",
    "norwegian",
    "pakistan",
    "pakistani",
    "persian",
    "peruvian",
    "philippine",
    "polish",
    "portuguese",
    "punjabi",
    "romanian",
    "russian",
    "saudi",
    "scandinavian",
    "scottish",
    "serbian",
    "singapore",
    "singaporean",
    "slovak",
    "somali",
    "spanish",
    "sri lanka",
    "sri lankan",
    "swedish",
    "swiss",
    "taiwanese",
    "tamil",
    "telugu",
    "turkish",
    "ukrainian",
    "urdu",
    "uzbek",
    "vietnamese",
    "welsh",
    "international students",
    "languages and culture",
)
#: Words after which a nationality is a style, not a community ("Cuban Salsa",
#: "Muay Thai", "Indian Classical Dance" keeps both).
_CULTURE_STYLE = _pattern("muay thai", "irish dance", "scottish country")
_MUSIC = _pattern(
    "orchestra",
    "choir",
    "chorus",
    "choral",
    "band",
    "jazz",
    "ensemble",
    "singers",
    "consort",
    "schola",
    "cantorum",
    "a cappella",
    "acappella",
    "philharmonic",
    "symphony",
    "sinfonia",
    "opera",
    "barbershop",
    "steel pan",
    "samulnori",
    "music",
    "musica",
    "madrigal",
    "dj",
    "techno",
    "heavy metal",
    "hiphop",
    "kpop",
)
_THEATRE = _pattern(
    "theatre",
    "theater",
    "drama",
    "dramatic",
    "players",
    "thespian",
    "film",
    "films",
    "cinema",
    "documentary",
    "dance",
    "dancing",
    "ballet",
    "ballroom",
    "salsa",
    "tango",
    "bollywood",
    "bhangra",
    "kuthu",
    "comedy",
    "improv",
    "revue",
    "pantomime",
    "dragtime",
    "musical theatre",
)
_MEDIA_CATEGORY = _pattern(
    "journal", "review", "magazine", "newspaper", "gazette", "radio", "podcast", "publishing"
)

#: Category rules in order of precedence (the first three that match).
CATEGORY_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("sport", _SPORT),
    ("faith", _FAITH),
    ("cultural_international", _CULTURE),
    ("music", _MUSIC),
    ("theatre_film_dance", _THEATRE),
    ("media_publishing", _MEDIA_CATEGORY),
)
MAX_CATEGORIES = 3


def _name_record(profile: OrgProfile) -> Observation | None:
    """The record whose name the name rules read: a register's, else the
    first that names the group."""
    return profile.record(*REGISTER_SOURCES, "sport_az", "camdram", "cucbc", "su_profile")


#: A college's student body (JCR / MCR): community, representation and welfare.
BODY_CATEGORIES = ("identity_wellbeing",)


def category_rules(profile: OrgProfile) -> list[RuleClaim]:
    """Categories a name states, for an organisation no source categorises;
    a JCR or MCR is a community and welfare body (`BODY_CATEGORIES`)."""
    if profile.has("categories"):
        return []
    for body_record, obs in profile.values.get("orgType", []):
        if obs.value in ("jcr", "mcr"):
            return [
                RuleClaim(
                    "categories",
                    list(BODY_CATEGORIES),
                    body_record,
                    "classify.student_body_category",
                    f"a college's {str(obs.value).upper()}",
                )
            ]
    record = _name_record(profile)
    if record is None:
        return []
    names = [record.identity.name, *record.identity.aliases]
    text = " | ".join(_folded(name) for name in names)
    found: list[str] = []
    for category, pattern in CATEGORY_RULES:
        if category == "cultural_international":
            hit = pattern.search(_CULTURE_STYLE.sub(" ", text))
        else:
            hit = pattern.search(text)
        if hit and category not in found:
            found.append(category)
    if not found:
        return []
    return [
        RuleClaim(
            "categories",
            found[:MAX_CATEGORIES],
            record,
            "classify.name_category",
            record.identity.name,
        )
    ]


# --- audiences and activity types ------------------------------------------------------------

_AUDIENCES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("postgraduates", _pattern("postgraduate", "postgraduates", "graduate", "mcr", "phd")),
    # "Women in Law" societies welcome everyone: only a women's group says so.
    ("women", _pattern("womens", "girl", "girls", "society of women")),
    ("men", _pattern("men", "mens")),
    ("lgbtq", _pattern("lgbt", "lgbtq", "lgbtqia", "queer")),
    # "International Student Film Festival" is not for international students.
    ("international", _pattern("international students")),
)
_NOT_POSTGRADUATE = _pattern("graduate course", "graduate entry")


def audience_rules(profile: OrgProfile) -> list[RuleClaim]:
    """Audiences a register's name states, for an organisation no source gives any."""
    if profile.has("audiences"):
        return []
    record = _register_record(profile)
    if record is None:
        return []
    text = _folded(record.identity.name)
    found = [
        audience
        for audience, pattern in _AUDIENCES
        if pattern.search(text)
        and not (audience == "postgraduates" and _NOT_POSTGRADUATE.search(text))
    ]
    if not found:
        return []
    return [RuleClaim("audiences", found, record, "classify.name_audience", record.identity.name)]


_ENSEMBLE = _pattern(
    "orchestra", "choir", "chorus", "band", "ensemble", "singers", "consort", "sinfonia"
)


def activity_rules(profile: OrgProfile) -> list[RuleClaim]:
    """What a sports club, a theatre company or an ensemble does, for an
    organisation no source gives activity types."""
    if profile.has("activityTypes"):
        return []
    types = profile.org_types
    sport = profile.registered("sportsService") or types & {"sports_club", "college_boat_club"}
    if sport:
        record = profile.record("sport_az", "cucbc", *REGISTER_SOURCES)
        if record is not None:
            return [
                RuleClaim(
                    "activityTypes",
                    ["training", "competitions"],
                    record,
                    "classify.sports_club_activity",
                    "a sports club",
                )
            ]
    if "theatre_company" in types:
        record = profile.record("camdram")
        if record is not None:
            return [
                RuleClaim(
                    "activityTypes",
                    ["performances"],
                    record,
                    "classify.theatre_activity",
                    "a theatre company",
                )
            ]
    record = _register_record(profile)
    if record is not None and _ENSEMBLE.search(_folded(record.identity.name)):
        return [
            RuleClaim(
                "activityTypes",
                ["performances"],
                record,
                "classify.ensemble_activity",
                record.identity.name,
            )
        ]
    return []


def rule_claims(profile: OrgProfile, *, college_keys: set[str]) -> list[RuleClaim]:
    """Every rule's claims for one organisation (module docstring)."""
    return [
        *type_and_level(profile, college_keys=college_keys),
        *category_rules(profile),
        *audience_rules(profile),
        *activity_rules(profile),
    ]


__all__ = [
    "BODY_CATEGORIES",
    "CATEGORY_RULES",
    "MAX_CATEGORIES",
    "RuleClaim",
    "activity_rules",
    "ambiguous_type",
    "audience_rules",
    "category_rules",
    "college_in_name",
    "rule_claims",
    "type_and_level",
]
