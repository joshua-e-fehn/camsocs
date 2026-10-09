"""Public free text with personal names replaced by roles. This is Joshua's
decision D1 (PLAN.md decisions log, 2026-10-08): "contact our President,
Anna" is published as "contact our President".

**What it covers** (`PUBLIC_TEXT_FIELDS`), from every source (SU, websites,
Camdram, Sport, termcards, mail, SU What's On, calendar feeds, talks.cam):

- an organisation's shortDescription, description, howToJoin,
  timeCommitment, accessibilityNote and sport kit-cost note;
- the labels and notes of its membership tiers, its bursary note, the note
  and dates of its trials, and how to join its chat channels;
- a session's title, venue and note;
- an event's title, venue, price text and description.

A **title** that cannot be made safe takes its event (or session) with it:
none of its claims is posted (`RedactionStats.dropped`), because a title is
required and a withheld one would leave the last published title standing.

The speakers an event publishes (`events.speakers`) are public and stay
named, both in that field and in its description — but never a name that is
some organisation's known committee member. Committee members (D2) live only
in the private broker tables; an organisation's are applied to its own
texts, its sessions' and the events it organises.

**Links.** A link to a person's profile (LinkedIn ``/in/``, never stored,
source-research §14) is reduced to its text before anything else, and once
the names are known, a link or URL that spells a redacted name
("linkedin.com/in/anna-smith", "annasmith.com") is reduced to its (already
redacted) text too: a name must not survive in a URL.

**Where it runs.** `redact_claims`, called from
`ConvexLoader.post_observations`, the one path every claim takes to Convex
(the load and inbox stages). Staged observations keep the text as the source
wrote it. The posted claim's value is the redacted text and its `valueRaw` is
the original, which only internal tables hold (data-model §3).

**How** (`Redactor.redact`):

1. **No candidate name, no change.** If every capitalised word in a text is
   a known non-name (`SAFE_WORDS`, the words of the entity's own key, the
   event's speakers), the text has no role word or contact verb (in any
   case: "PRESIDENT: ANNA SMITH", "president - anna smith") and no letters of
   another script (a Chinese society's 会长), the text cannot name a private
   person, and no LLM call is made. The gate fails closed: a role word or a
   contact verb alone sends a text to the model.
2. **The LLM pass.** The bulk model runs the prompt
   ``extract/prompts/redact_names_v2.md`` and returns
   ``{text, redactions: [{original, replacement}]}``. It replaces the names of
   private individuals with their role or a neutral phrase, and keeps
   organisations, places, public figures, historical people and namesakes,
   published authors, visiting speakers and the event's speakers. Replies
   are cached by the sha256 of the input (`extract/memo.py`). talks.cam
   content never goes to the model (§6), nor text from a general source
   whose host or page keeps AI out (`extract.ai_gate`); they take step 4.
3. **Deterministic post-checks** (`accept_reply`). Every ``original`` must be
   in the input, and none may be a kept name. Every replacement must be made
   of role and neutral words (`REPLACEMENT_WORDS`). The text may introduce no
   other new word. Its length must stay within what the replacements explain.
   No redacted name and no known committee member may be left in it, and a
   removal may not leave an empty slot ("coach in , an", "the President, ,").
4. **The fallback**, used when the reply fails a check, the model fails, or
   no model may or can be asked (`rule_redact`). The reply's verified names
   (longest first, each widened to the whole capitalised name around it, so
   "Sebastian" takes "Sebastian Habersack Martos" with it) and the known
   committee members are replaced — by the reply's role, else by the neutral
   ``someone`` (`NEUTRAL`), which claims no membership it cannot know —
   committee-list lines ("President: Anna Smith") are dropped, and
   capitalised names right next to a role word or a contact verb are
   removed. If a candidate name still stands near a role word, a contact
   verb or a credit ("Directed by Lucy Hall"), the text is **withheld**: the
   claim is posted as ``missing`` / ``not_published`` instead. When the
   model was asked and failed (`strict`), a title with any candidate name
   left, or a text in another script, is withheld too.

**Provenance.** The claim's status is unchanged (found or inferred). Its
`extractor` gains ``+redacted:v2`` (the LLM pass, or no names found),
``+redacted:v2:rule`` (the fallback) or ``+redacted:v2:withheld``.
"""

from __future__ import annotations

import itertools
import logging
import re
import threading
import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES
from camsocs_pipeline.config import ConfigError, Settings
from camsocs_pipeline.extract.ai_gate import AiGate
from camsocs_pipeline.extract.events import SPEAKER_EVENT_TYPES
from camsocs_pipeline.extract.llm import LLMClient, NoLLMHost, assert_llm_source_allowed
from camsocs_pipeline.extract.memo import LLMMemo, memo_key
from camsocs_pipeline.keys import canonical_json, event_key
from camsocs_pipeline.models.observation import EventObservation, Observation
from camsocs_pipeline.models.wire import ClaimInput
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.links import is_personal_profile

logger = logging.getLogger(__name__)

PROMPT_NAME = "redact_names_v2"
PROMPT_PATH = Path(__file__).parent / "prompts" / f"{PROMPT_NAME}.md"
TAG = "redacted:v2"
RULE_TAG = "redacted:v2:rule"
WITHHELD_TAG = "redacted:v2:withheld"

#: (entity type, field) → the shape of its public text. A ``title`` is a
#: text whose withholding drops its whole entity (module docstring).
PUBLIC_TEXT_FIELDS: Mapping[tuple[str, str], str] = {
    ("organisation", "shortDescription"): "text",
    ("organisation", "description"): "text",
    ("organisation", "howToJoin"): "text",
    ("organisation", "timeCommitment"): "text",
    ("organisation", "accessibilityNote"): "text",
    ("organisation", "sport.kitCostNote"): "text",
    ("organisation", "membership"): "membership",
    ("organisation", "trials"): "trials",
    ("organisation", "chatChannels"): "chat",
    ("session", "title"): "title",
    ("session", "venueText"): "text",
    ("session", "note"): "text",
    ("event", "title"): "title",
    ("event", "venueText"): "text",
    ("event", "price"): "price",
    ("event", "description"): "text",
}

#: Field length limits (webapp/convex/lib/fields.ts) a longer replacement
#: could break; the rest are far above any redaction.
LIMITS: Mapping[tuple[str, str], int] = {("organisation", "shortDescription"): 200}
#: A server-side cap on extractor ids (webapp/convex/ingest/claims.ts).
MAX_EXTRACTOR = 200

Method = Literal["none", "llm", "rule", "withheld"]

# --- vocabularies ---------------------------------------------------------------------------

#: Capitalised words that are not personal names in Cambridge society text:
#: function words, the calendar, places, colleges, common nouns of society
#: pages. Words that are also common first names or surnames (May, June,
#: March, Will, Clare, John, Lucy, Hall, Lane, Court, Art, Robinson, King …)
#: are left out on purpose, so a text with them is read by the model; the
#: college ones are safe only inside a college's name (`CONTEXT_SAFE_WORDS`).
#: Lower-case, as `_norm_word` leaves them ("King's" → "king").
SAFE_WORDS = frozenset(
    """
    a about academic access after again all also alumni an and annual any are arts as at
    autumn ball be beginner beginners blue blues bumps but by can cambridge cambridgeshire
    careers centre chapel check christmas club clubs college colleges come committee
    competition competitions computer contact cu cusu dance day dear december department
    debate debates do does each easter email england english europe european event events
    every everyone facebook faculty fair february festival film find follow for formal
    formals free freshers friday from fund get go google graduate graduates group groups
    have he hello her here hi his history how i if in instagram institute international is
    it its january jcr join july just law learn lecture lent let library linkedin linktree
    london looking lunch mcr meet meeting meetings member members membership michaelmas
    monday more museum music my national new no not november now october of on once one open
    or our out oxford party please politics postgraduate postgraduates practice registered
    research road room rowing saturday school science season see september session sessions
    she sign so social socials societies society some sport sports spring street student
    students su summer sunday support talk talks team teams term terms that the their them
    then there these they this those thursday tiktok to training trip trips tuesday uk
    undergraduate undergraduates union university us varsity visit want we wednesday week
    weekly weeks welcome what whatsapp when where whether which who why winter with workshop
    workshops world year years you your youtube zoom caius corpus downing fitzwilliam girton
    gonville homerton magdalene newnham pembroke peterhouse trinity
    """.split()  # noqa: SIM905 (a word list reads better as text)
)
#: Words that are also names ("Jesus", "King", "Robinson", "Hall") and are
#: safe only as part of a college's or a building's name: possessive
#: ("King's", "Christ's", "Queens'") or followed — directly or through other
#: such words ("Sidney Sussex College", "Lucy Cavendish College") — by
#: College / Hall / Court / Road …
CONTEXT_SAFE_WORDS = frozenset(
    """
    jesus christ christi king queen queens hall court robinson darwin churchill clare
    wolfson selwyn sidney sussex emmanuel lucy cavendish murray edwards hughes catharine
    edmund john st saint
    """.split()  # noqa: SIM905 (a word list reads better as text)
)
_CONTEXT_FOLLOWERS = frozenset(
    {"college", "colleges", "hall", "court", "road", "street", "lane", "chapel", "building"}
)

#: Words a replacement may be made of: determiners, roles, neutral phrases
#: (lower-case, possessives as `_norm_word` leaves them).
REPLACEMENT_WORDS = frozenset(
    """
    a an the our their its one of this that them they someone somebody person people
    member members committee team organiser organisers organizer organizers cast crew
    student students performer performers host hosts guest guests coach coaches contact
    us society club group president presidents vice co deputy assistant joint chair chairs
    chairperson secretary secretaries treasurer captain captains officer officers welfare
    social publicity external internal events event sponsorship general rep reps
    representative representatives coordinator co-ordinator convenor convener founder
    founders co-founder director directors musical artistic producer producers editor
    editors manager managers conductor leader leaders instructor instructors teacher
    teachers tutor tutors trainer trainers player players singer singers dancer dancers
    actor actors musician musicians writer author staff volunteer volunteers
    vice-president co-president vice-captain vice-chair co-chair head lead men women
    """.split()  # noqa: SIM905 (a word list reads better as text)
)

_ROLE_HEAD = (
    r"president|chair(?:person|man|woman)?|secretary|treasurer|captain|officer|"
    r"rep(?:resentative)?|co-?ordinator|convenor|convener|organi[sz]er|founder|director|"
    r"producer|editor(?:-in-chief)?|coach|manager|conductor|leader|webmaster|steward|"
    r"librarian|archivist|ambassador|liaison|chaplain|instructor|tutor|trainer|"
    r"committee member"
)
#: A role word, case-insensitive, with an optional prefix ("Vice-President").
_ROLE = rf"(?i:\b(?:(?:co|vice|deputy|assistant|joint)[- ])?(?:{_ROLE_HEAD})s?\b)"
_CONTACT = (
    r"(?i:\b(?:contact|e-?mail|message|dm|text|ask|ping|call|reach out to|speak to|talk to|"
    r"get in touch with|write to|chat to|chat with)\b)"
)
#: A credit: whoever follows it is named for a part in a show or an event.
_CREDIT = (
    r"(?i:\b(?:directed|produced|written|designed|choreographed|conducted|composed|devised|"
    r"adapted|starring|featuring|presented|performed|hosted|led|organised|organized)\b"
    r"(?:[ \t]+by)?)|\b(?:[Bb]y|[Ff]t\.?|[Ff]eat\.?)(?=[ \t]+[A-ZÀ-ÖØ-Þ])"
)
_UPPER = "A-ZÀ-ÖØ-Þ"
_LOWER = "a-zß-öø-ÿ"
_HONORIFIC = r"(?:Mr|Mrs|Ms|Mx|Dr|Prof|Professor|Sir|Dame|Lord|Lady|Rev|Revd|Cllr)\.?"
_NAME_WORD = (
    rf"(?:{_HONORIFIC}(?=[ \t])|[{_UPPER}][{_LOWER}]+(?:[-'’][{_UPPER}]?[{_LOWER}]+)*|[{_UPPER}]\.)"
)
_PARTICLE = r"(?:de|van|von|der|den|di|da|le|la|du|bin|al|el|del|dos)"
#: One to four capitalised words: "Anna", "Anna Smith", "Anna van der Berg".
_NAME = rf"{_NAME_WORD}(?:[ \t]+(?:{_PARTICLE}[ \t]+)*{_NAME_WORD}){{0,3}}"

_COMMITTEE_LINE = re.compile(
    rf"^[ \t]*(?:[-*•][ \t]*)?(?:\*\*)?(?:[\w'’ ]{{0,30}}?)?{_ROLE}(?:\*\*)?[ \t]*[:\-–—][ \t]*"
    rf"(?P<name>{_NAME})(?:[ \t]*\([^)\n]*\))?[ \t]*\.?[ \t]*(?:\n|$)",
    re.MULTILINE,
)
_ROLE_THEN_NAME = re.compile(
    rf"(?P<role>{_ROLE})(?P<sep>[ \t]*[,:–—-]?[ \t]+)(?P<name>{_NAME})(?![\w'’])(?P<after>[ \t]*,)?"
)
_NAME_THEN_ROLE = re.compile(
    rf"(?<![\w'’])(?P<name>{_NAME})[ \t]*,?[ \t]+(?P<det>(?i:our|the|club|society))[ \t]+"
    rf"(?P<role>(?:[\w'’-]+[ \t]+){{0,2}}?{_ROLE})"
)
_NAME_PAREN_ROLE = re.compile(
    rf"(?<![\w'’])(?P<name>{_NAME})[ \t]*\((?P<role>(?:[A-Za-z'’&-]+[ \t]+){{0,3}}{_ROLE})\)"
)
#: The last word of a prefix that already says "the" / "our".
_DETERMINER_END = re.compile(r"(?i)\b(?:the|our|their|a|an)[ \t]*$")
_CONTACT_NAME = re.compile(rf"(?P<verb>{_CONTACT})(?P<sp>[ \t]+)(?P<name>{_NAME})(?![\w'’])")
_TRIGGER = re.compile(rf"{_ROLE}|{_CONTACT}")
#: What makes the fallback look for names nearby: also credits.
_RISK_TRIGGER = re.compile(rf"{_ROLE}|{_CONTACT}|{_CREDIT}")
#: A role or contact word then a list separator then a word in any case
#: ("president - anna smith", "PRESIDENT: ANNA SMITH").
_ROLE_LIST = re.compile(rf"{_ROLE}[ \t]*[:\-–—][ \t]*(?P<word>[^\W\d_]+)")
#: Words a committee list puts where a name would be.
_NO_HOLDER = frozenset({"tbc", "tba", "tbd", "vacant", "none", "open", "position", "role"})
#: Letters of scripts the capitalisation rule cannot read (Greek, Cyrillic,
#: Hebrew, Arabic, Indic, Thai, Hangul, kana, CJK): such text goes to the model.
_OTHER_SCRIPT = re.compile(
    "[\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u0dff\u0e00-\u0e7f"
    "\u1100-\u11ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]"
)
#: A word in capitals ("ANNA", "SMITH"): a name as often as an acronym.
_ALL_CAPS = re.compile(rf"(?<![\w'’])[{_UPPER}]{{2,}}(?:[-'’][{_UPPER}]+)*(?![\w'’])")
_CAPITALISED = re.compile(rf"(?<![\w'’])[{_UPPER}][{_LOWER}]+(?:[-'’][{_UPPER}]?[{_LOWER}]+)*")
_WORD = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*")
#: Marks where a removal left a gap, so tidying touches only those spots
#: and never the source's own spacing or punctuation elsewhere.
_MARK = "\x00"
_GAP_BEFORE_PUNCT = re.compile(r"[ \t]*\x00[ \t\x00]*(?=[,.;:!?)])")
_COMMA_GAP_COMMA = re.compile(r",[ \t]*\x00[ \t\x00]*,")
_GAP = re.compile(r"[ \t\n]*\x00[ \t\n\x00]*")
_TRIGGER_WINDOW = 4
#: What precedes the first word of a sentence, a line or a list item.
_SENTENCE_START = re.compile(r"(?:^|[.!?:;]\s+|\n\s*(?:[-*•]\s*)?|[(\[\"“]\s*)$")
_SENTENCE_END = re.compile(r"[.!?;](?=\s)|\n")
_DETERMINERS = frozenset({"the", "our", "a", "an", "their", "its", "this", "these", "your"})
#: Words after a sentence's first word that make it a subject ("Anna is …").
_COPULAS = frozenset({"is", "was", "will", "has", "and", "&", "runs", "leads"})
#: What the rule puts in place of a known committee member, or of a name a
#: model reply verified without a usable role. It claims nothing about the
#: person (a fund's namesake is not "a member of the committee"), and it
#: contains no role word, so it never trips the risk check itself.
NEUTRAL = "someone"
#: Spots a removal can leave empty: "coach in , an", "the President, ,", "()".
_EMPTY_SLOTS = (
    re.compile(r"\(\s*\)|\[\s*\]"),
    re.compile(r"[,;:]\s*[,;:.!?)]"),
    re.compile(
        r"(?i)\b(?:in|at|by|of|from|with|and|or|to|for|the|our|a|an|is|was|thanks)[ \t]*[,;:.!?)]"
    ),
    re.compile(r"(?m)^[ \t]*[,;:)]"),
)


def _norm_word(word: str) -> str:
    word = word.lower().replace("’", "'")
    return word.removesuffix("'s")


def _words(text: str) -> list[str]:
    return [_norm_word(word) for word in _WORD.findall(text)]


def _phrase(text: str) -> str:
    return " ".join(text.split())


def contains_name(text: str, name: str) -> bool:
    """Whether `text` names `name`: a whole-word match, case-sensitive for a
    single word (so "Joy" is not "enjoy"), whitespace-flexible."""
    words = name.split()
    if not words:
        return False
    pattern = r"(?<![\w'’])" + r"\s+".join(map(re.escape, words)) + r"(?![\w'’])"
    flags = re.IGNORECASE if len(words) > 1 else 0
    return re.search(pattern, text, flags) is not None


def _not_a_name(word: str, safe: set[str]) -> bool:
    """A known non-name: a safe word, a role or neutral word, or one of the
    entity's own words (`safe`)."""
    word = _norm_word(word)
    return word in SAFE_WORDS or word in REPLACEMENT_WORDS or word in safe


def _safe_in_context(text: str, start: int, end: int) -> bool:
    """Whether the word at ``text[start:end]`` is one of `CONTEXT_SAFE_WORDS`
    used as part of a college's or a building's name: possessive ("King's",
    "Queens'") or followed by College, Hall, Court, Road …"""
    word = text[start:end]
    if _norm_word(word) not in CONTEXT_SAFE_WORDS:
        return False
    if word.lower().replace("’", "'").endswith(("'s", "s'")):
        return True
    if text[end : end + 1] in ("'", "’"):
        return True
    position = end
    for _step in range(3):
        if text[position : position + 1] not in (" ", "\t"):
            return False
        following = _WORD.match(text, position + 1)
        if following is None:
            return False
        word = _norm_word(following.group(0))
        if word in _CONTEXT_FOLLOWERS:
            return True
        if word not in CONTEXT_SAFE_WORDS:
            return False
        position = following.end()
    return False


def _word_is_safe(text: str, start: int, end: int, safe: set[str]) -> bool:
    return _not_a_name(text[start:end], safe) or _safe_in_context(text, start, end)


def candidate_names(text: str, safe: Iterable[str] = ()) -> set[str]:
    """Capitalised words in `text` that could be a personal name: not in
    `SAFE_WORDS`, not a role word, not a college word in its college's name,
    and not in `safe` (words of the entity's own name or of names that are
    kept)."""
    extra = {_norm_word(word) for word in safe}
    return {
        match.group(0)
        for match in _CAPITALISED.finditer(text)
        if not _word_is_safe(text, match.start(), match.end(), extra)
    }


def needs_model(text: str, safe: Iterable[str] = ()) -> bool:
    """Whether a text may name a private person and must be read (module
    docstring, step 1): a candidate name, a role word or contact verb in any
    case, or letters of a script the capitalisation rule cannot read."""
    return bool(candidate_names(text, safe) or _TRIGGER.search(text) or _OTHER_SCRIPT.search(text))


def allowed_replacement(replacement: str) -> bool:
    """A replacement made only of role and neutral words (or nothing)."""
    return all(word in REPLACEMENT_WORDS for word in _words(replacement))


# --- the model's answer -----------------------------------------------------------------------


class NameRedaction(BaseModel):
    model_config = ConfigDict(extra="ignore")
    original: str = Field(description="The name exactly as it appears in the text.")
    replacement: str = Field(
        "", description="The role or neutral words put in its place, or '' if only removed."
    )


class RedactReply(BaseModel):
    """What the model returns. Field descriptions are part of the schema it sees."""

    model_config = ConfigDict(extra="ignore")
    text: str = Field(description="The whole text with only the name replacements made.")
    redactions: list[NameRedaction] = Field(default_factory=list)


@dataclass(frozen=True)
class Redaction:
    """The public-safe form of one text. `text` None means withheld."""

    original: str
    text: str | None
    method: Method
    redactions: tuple[tuple[str, str], ...] = ()

    @property
    def changed(self) -> bool:
        return self.text != self.original

    @property
    def tag(self) -> str:
        if self.method == "withheld":
            return WITHHELD_TAG
        return RULE_TAG if self.method == "rule" else TAG


@dataclass(frozen=True)
class RedactRequest:
    """One text to make public-safe. `keep`: names that stay (an event's
    speakers). `private`: names that must go (known committee members).
    `safe`: words of the entity's own name. `llm`: whether the text may be
    sent to the model (never for talks.cam). `title`: the text is a title,
    which the fallback withholds when any candidate name is left (`strict`)."""

    text: str
    keep: tuple[str, ...] = ()
    private: tuple[str, ...] = ()
    safe: tuple[str, ...] = ()
    llm: bool = True
    title: bool = False


def _apply(text: str, pairs: Sequence[tuple[str, str]]) -> str:
    """`text` with each original replaced (longest first, whole words); a
    removal leaves a gap mark for `_tidy`."""
    for original, replacement in sorted(pairs, key=lambda pair: -len(pair[0])):
        pattern = r"(?<![\w'’])" + re.escape(original) + r"(?![\w'’])"
        text = re.sub(pattern, lambda _m, r=replacement: r or _MARK, text)
    return _tidy(text)


def _tidy(text: str) -> str:
    """Closes the gaps removals left (`_MARK`), and only those: no space
    before punctuation, no doubled comma, one space inside a line, a
    paragraph break where whole lines went, nothing at either end."""
    if _MARK not in text:
        return text
    text = _COMMA_GAP_COMMA.sub(",", text)
    text = _GAP_BEFORE_PUNCT.sub("", text)

    def gap(match: re.Match[str]) -> str:
        if match.start() == 0 or match.end() == len(text):
            return ""
        newlines = match.group(0).count("\n")
        return "\n\n" if newlines >= 2 else "\n" if newlines == 1 else " "

    return _GAP.sub(gap, text).replace(_MARK, "")


def empty_slots(text: str) -> int:
    """How many spots in `text` read like a removal left them empty."""
    return sum(len(pattern.findall(text)) for pattern in _EMPTY_SLOTS)


def _kept(name: str, keep: Sequence[str]) -> bool:
    """Whether `name` is (part of) a kept name, or a kept name is part of it:
    "Prof Jane Doe" keeps "Jane Doe" and "Doe"."""
    words = set(_words(name))
    if not words:
        return False
    for kept in keep:
        kept_words = set(_words(kept))
        if kept_words and (words <= kept_words or kept_words <= words):
            return True
    return False


def _name_like(text: str, safe: set[str]) -> bool:
    """A personal name as the model may report one: one to five words, each
    capitalised (or a particle such as "van"), no digits or addresses, and
    not made only of known non-names or the entity's own words."""
    words = text.split()
    if not 1 <= len(words) <= 5 or len(text) > 80 or "@" in text:
        return False
    if any(char.isdigit() for char in text):
        return False
    particles = re.compile(rf"^{_PARTICLE}$")
    if not all(word[:1].isupper() or particles.match(word) for word in words):
        return False
    return not all(word in SAFE_WORDS or word in safe for word in _words(text))


def accept_reply(request: RedactRequest, reply: RedactReply) -> Redaction | None:
    """The model's text when it passes every post-check (module docstring,
    step 3), else None."""
    original = request.text
    safe = {_norm_word(word) for word in request.safe}
    pairs: list[tuple[str, str]] = []
    for item in reply.redactions:
        name = item.original.strip()
        replacement = _phrase(item.replacement)
        if not name or name not in original:
            continue  # nothing to check it against: ignored, the text decides
        if _kept(name, request.keep) or not _name_like(name, safe):
            return None  # a speaker, or something that is not a name
        if not allowed_replacement(replacement):
            return None
        pairs.append((name, replacement))
    text = reply.text
    allowed = set(_words(original)) | REPLACEMENT_WORDS
    if any(word not in allowed for word in _words(text)):
        return None
    removed = sum(len(name) for name, _ in pairs)
    added = sum(len(replacement) for _, replacement in pairs)
    slack = 12 + len(original) // 50
    if not (len(original) - removed - slack <= len(text) <= len(original) + added + slack):
        return None
    for name, _ in pairs:
        if contains_name(text, name) and not _kept(name, request.keep):
            return None
    if any(contains_name(text, name) for name in request.private):
        return None
    if not text.strip() or (not pairs and _phrase(text) != _phrase(original)):
        return None  # emptied, or changed without saying what: not a redaction
    if empty_slots(text) > empty_slots(original):
        return None  # a name removed where the sentence needed one ("coach in , an")
    rebuilt = _apply(original, pairs)
    if _phrase(rebuilt) == _phrase(text):
        text = rebuilt  # the source's own formatting, exactly
    return Redaction(original, text, "llm", tuple(pairs))


# --- the deterministic fallback --------------------------------------------------------------


def _split_name(name: str, safe: set[str]) -> tuple[str, str, str]:
    """``(prefix, person, suffix)`` of a match of the name pattern: the known
    non-name words it caught at either end ("Contact Anna Smith Welcome")
    stay, only the middle can be a person."""
    spans = [(m.start(), m.end()) for m in _WORD.finditer(name)]

    def is_safe(span: tuple[int, int]) -> bool:
        return _word_is_safe(name, span[0], span[1], safe)

    first, last = 0, len(spans)
    while first < last and is_safe(spans[first]):
        first += 1
    while last > first and is_safe(spans[last - 1]):
        last -= 1
    if first == last:
        return name, "", ""
    start, end = spans[first][0], spans[last - 1][1]
    return name[:start], name[start:end], name[end:]


_NEXT_NAME_WORD = re.compile(rf"[ \t]+(?:{_PARTICLE}[ \t]+)*(?P<word>{_NAME_WORD})(?![\w'’])")
_PREVIOUS_NAME_WORD = re.compile(rf"(?<![\w'’])(?P<word>{_NAME_WORD})[ \t]+(?:{_PARTICLE}[ \t]+)*$")
_ROLE_AT_END = re.compile(rf"{_ROLE}[ \t]*,?$")
_ROLE_AT_START = re.compile(rf"^[ \t]*[,(]?[ \t]*(?:(?:our|the)[ \t]+)?{_ROLE}")


def _widen(text: str, start: int, end: int, safe: set[str]) -> tuple[int, int]:
    """The span of the whole personal name around ``text[start:end]``: the
    capitalised words next to it that are not known non-names, with their
    particles ("Sebastian" → "Sebastian Habersack Martos"); never a
    sentence's first word."""
    while (match := _NEXT_NAME_WORD.match(text, end)) is not None and not _word_is_safe(
        text, match.start("word"), match.end("word"), safe
    ):
        end = match.end("word")
    while True:
        window_start = max(0, start - 80)
        match = _PREVIOUS_NAME_WORD.search(text[window_start:start])
        if match is None:
            break
        word_start = window_start + match.start("word")
        word_end = window_start + match.end("word")
        # A sentence's first word is capitalised anyway ("Pay Jane …").
        at_sentence_start = _SENTENCE_START.search(text[:word_start]) is not None
        if at_sentence_start or _word_is_safe(text, word_start, word_end, safe):
            break
        start = word_start
    return start, end


def _replace_name(text: str, name: str, replacement: str, safe: set[str]) -> tuple[str, str | None]:
    """`text` with every whole-word `name`, widened to the name around it
    (`_widen`), replaced. An empty `replacement` removes a name whose role is
    written next to it and puts `NEUTRAL` anywhere else; a replacement the
    text already says right before the name ("our president Sebastian …"
    → "our president") is not said twice. Returns the text and the
    replacement used (None if `name` was not there)."""
    pattern = re.compile(r"(?<![\w'’])" + re.escape(name) + r"(?![\w'’])")
    out: list[str] = []
    position = 0
    used: str | None = None
    for match in pattern.finditer(text):
        if match.start() < position:
            continue
        start, end = _widen(text, match.start(), match.end(), safe)
        start = max(start, position)
        before = "".join(out) + text[position:start]
        context = before.rstrip(" \t[*_")
        chosen = replacement
        if not chosen:
            role_next = _ROLE_AT_END.search(context) or _ROLE_AT_START.match(text[end:])
            chosen = "" if role_next else NEUTRAL
        if chosen and context.lower().endswith(chosen.lower()):
            chosen = ""
        out.append(text[position:start])
        out.append(chosen or _MARK)
        position = end
        used = chosen if used is None else used
    if used is None:
        return text, None
    out.append(text[position:])
    return "".join(out), used


def rule_redact(
    request: RedactRequest, extra: Sequence[tuple[str, str]] = (), *, strict: bool = False
) -> Redaction:
    """The conservative deterministic redaction (module docstring, step 4).
    `extra`: verified (name, replacement) pairs from a model reply that failed
    its checks. `strict`: the model was asked and could not be used, so a
    title with a candidate name left, or a text in another script, is
    withheld rather than guessed safe."""
    safe = {_norm_word(word) for word in request.safe}
    keep = request.keep
    text = request.text
    pairs: list[tuple[str, str]] = []

    def person(match: re.Match[str]) -> tuple[str, str, str] | None:
        """The match's name split around its person, or None if no person."""
        prefix, core, suffix = _split_name(match.group("name"), safe)
        if not core or _kept(core, keep):
            return None
        return prefix, core, suffix

    def drop_line(match: re.Match[str]) -> str:
        found = person(match)
        if found is None:
            return match.group(0)
        pairs.append((found[1], ""))
        return _MARK + ("\n" if match.group(0).endswith("\n") else "")

    text = _COMMITTEE_LINE.sub(drop_line, text)

    def role_then_name(match: re.Match[str]) -> str:
        found = person(match)
        if found is None or found[0].strip():
            return match.group(0)
        pairs.append((found[1], ""))
        after = match.group("after") or ""
        if found[2].strip():
            return f"{match.group('role')}{match.group('sep')}{found[2].strip()}{after}"
        return match.group("role") + _MARK + ("" if "," in match.group("sep") else after)

    text = _ROLE_THEN_NAME.sub(role_then_name, text)

    def name_then_role(match: re.Match[str]) -> str:
        found = person(match)
        if found is None or found[2].strip():
            return match.group(0)
        pairs.append((found[1], ""))
        return f"{found[0]}{match.group('det')} {match.group('role')}"

    text = _NAME_THEN_ROLE.sub(name_then_role, text)

    def name_paren_role(match: re.Match[str]) -> str:
        found = person(match)
        if found is None or found[2].strip():
            return match.group(0)
        pairs.append((found[1], ""))
        article = "" if _DETERMINER_END.search(found[0]) else "the "
        return f"{found[0]}{article}{match.group('role').strip()}"

    text = _NAME_PAREN_ROLE.sub(name_paren_role, text)

    def contact_name(match: re.Match[str]) -> str:
        found = person(match)
        if found is None or found[0].strip():
            return match.group(0)
        pairs.append((found[1], "the committee"))
        return f"{match.group('verb')}{match.group('sp')}the committee{found[2]}"

    text = _CONTACT_NAME.sub(contact_name, text)

    named = [(name, replacement) for name, replacement in extra if not _kept(name, keep)]
    named += [(name, NEUTRAL) for name in request.private if name.strip()]
    # Longest first, so a full name goes before a part of it would split it.
    for name, replacement in sorted(named, key=lambda pair: -len(pair[0])):
        usable = replacement if allowed_replacement(replacement) else NEUTRAL
        text, used = _replace_name(text, name, usable, safe)
        if used is not None:
            pairs.append((name, used))
    text = _tidy(text)
    kept_words = safe | {_norm_word(w) for k in keep for w in k.split()}
    if not text.strip() or _risky(text, kept_words, keep):
        return Redaction(request.text, None, "withheld", tuple(pairs))
    if strict and (
        _OTHER_SCRIPT.search(text) or (request.title and candidate_names(text, kept_words))
    ):
        return Redaction(request.text, None, "withheld", tuple(pairs))
    return Redaction(request.text, text, "rule", tuple(pairs))


def _is_candidate(text: str, start: int, end: int, safe: set[str], keep: Sequence[str]) -> bool:
    word = text[start:end]
    if _CAPITALISED.fullmatch(word) is None and _ALL_CAPS.fullmatch(word) is None:
        return False
    return not _word_is_safe(text, start, end, safe) and not _kept(word, keep)


def _risky(text: str, safe: set[str], keep: Sequence[str]) -> bool:
    """A candidate name within a few words of a role word, a contact verb or
    a credit ("Directed by"), in the same sentence.

    Candidates are runs of capitalised (or all-capital) words that are not
    all known non-names. A run right after "the", "our", "a" … that ends in
    a role or other known word is a title or a team ("the Lower Boats
    Captains"), not a person — but "our President Habersack Martos" is a
    person. A single word that starts a sentence is a name only when a verb
    like "is" follows it ("Anna is our President"); otherwise it is the
    sentence's first word ("Chaired by"). A role or contact word followed by
    a list separator and an unknown word in any case ("president - anna
    smith") is risky too."""
    for match in _ROLE_LIST.finditer(text):
        word = match.group("word")
        if word.lower() not in _NO_HOLDER and not _not_a_name(word, safe) and not _kept(word, keep):
            return True
    tokens = [(match.start(), match.group(0)) for match in _WORD.finditer(text)]
    triggers = [match.start() for match in _RISK_TRIGGER.finditer(text)]
    if not triggers:
        return False
    starts = [start for start, _ in tokens]
    trigger_index = {starts.index(t) for t in triggers if t in starts}
    breaks = [match.end() for match in _SENTENCE_END.finditer(text)]
    sentence = [sum(1 for end in breaks if end <= start) for start in starts]
    capitalised = [
        bool(_CAPITALISED.fullmatch(word) or _ALL_CAPS.fullmatch(word)) for _start, word in tokens
    ]

    index = 0
    while index < len(tokens):
        if not capitalised[index]:
            index += 1
            continue
        end = index
        while (
            end + 1 < len(tokens) and capitalised[end + 1] and sentence[end + 1] == sentence[index]
        ):
            end += 1
        run = range(index, end + 1)
        names = [
            i
            for i in run
            if _is_candidate(text, tokens[i][0], tokens[i][0] + len(tokens[i][1]), safe, keep)
        ]
        previous = tokens[index - 1][1].lower() if index > 0 else ""
        follower = tokens[end + 1][1].lower() if end + 1 < len(tokens) else ""
        lone_first_word = (
            len(run) == 1
            and _SENTENCE_START.search(text[: tokens[index][0]]) is not None
            and follower not in _COPULAS
        )
        # "the Lower Boats Captains" is a title; "our President Habersack
        # Martos" names a person after the title.
        titled = previous in _DETERMINERS and end not in names
        near_trigger = any(
            abs(i - t) <= _TRIGGER_WINDOW and sentence[t] == sentence[i]
            for i in names
            for t in trigger_index
        )
        if names and not titled and not lone_first_word and near_trigger:
            return True
        index = end + 1
    return False


# --- links ----------------------------------------------------------------------------------------

_MARKDOWN_LINK = re.compile(r"\[(?P<label>[^\]\n]*)\]\((?P<url>https?://[^\s)]+)\)")
_BARE_LINK = re.compile(r"(?<![(\w/])https?://[^\s<>()\[\]]+")
_HONORIFIC_WORDS = frozenset(
    {"mr", "mrs", "ms", "mx", "dr", "prof", "professor", "sir", "dame", "lord", "lady", "rev"}
)


def strip_profile_links(text: str) -> str:
    """`text` with every link to a person's profile (LinkedIn ``/in/``)
    reduced to its label, and a bare one removed: such a URL is never stored
    (source-research §14) and names its person."""
    if "linkedin" not in text.lower():
        return text

    def markdown(match: re.Match[str]) -> str:
        if not is_personal_profile(match.group("url")):
            return match.group(0)
        label = match.group("label")
        return _MARK if not label.strip() or label.startswith("http") else label

    text = _MARKDOWN_LINK.sub(markdown, text)
    text = _BARE_LINK.sub(
        lambda match: _MARK if is_personal_profile(match.group(0)) else match.group(0), text
    )
    return _tidy(text)


def _name_parts(name: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return [w for w in re.findall(r"[a-z]+", folded) if len(w) >= 2 and w not in _HONORIFIC_WORDS]


def url_names(url: str, names: Iterable[str]) -> bool:
    """Whether `url` spells one of `names`: two of its words joined
    ("anna-smith", "annasmith", "anna.smith"), or a one-word name of four
    letters or more as a whole word of the path ("cal.com/jian-xin")."""
    lowered = url.lower()
    parts = urlsplit(lowered)
    path_words = set(re.findall(r"[a-z]+", f"{parts.path} {parts.query}"))
    for name in names:
        words = _name_parts(name)
        for first, second in itertools.pairwise(words):
            for joiner in ("", "-", "_", ".", "+", "%20"):
                joined = f"{first}{joiner}{second}"
                if len(joined) >= 6 and joined in lowered:
                    return True
        if any(len(word) >= 4 and word in path_words for word in words):
            return True
    return False


def strip_named_links(text: str, names: Sequence[str]) -> str:
    """`text` with every link whose URL spells one of `names` reduced to its
    (already redacted) label, and such a bare URL removed."""
    names = [name for name in names if name.strip()]
    if not names or "http" not in text:
        return text

    def markdown(match: re.Match[str]) -> str:
        if not url_names(match.group("url"), names):
            return match.group(0)
        label = match.group("label")
        return _MARK if not label.strip() or label.startswith("http") else label

    text = _MARKDOWN_LINK.sub(markdown, text)
    text = _BARE_LINK.sub(
        lambda match: _MARK if url_names(match.group(0), names) else match.group(0), text
    )
    return _tidy(text)


# --- the redactor -------------------------------------------------------------------------------


@dataclass
class RedactionStats:
    texts: int = 0
    unchanged: int = 0
    changed: int = 0
    withheld: int = 0
    llm_calls: int = 0
    llm_cached: int = 0
    llm_failed: int = 0
    rejected_replies: int = 0
    by_method: Counter = field(default_factory=Counter)
    #: Keys of events and sessions not posted: their title could not be made safe.
    dropped: list[str] = field(default_factory=list)
    #: Speaker lists not published (not a talk's, unquoted, or naming a
    #: known committee member).
    speakers_withheld: int = 0

    def __str__(self) -> str:
        methods = ", ".join(f"{name} {count}" for name, count in sorted(self.by_method.items()))
        dropped = f"; {len(self.dropped)} titles unsafe, not posted" if self.dropped else ""
        speakers = (
            f"; {self.speakers_withheld} speaker lists withheld" if self.speakers_withheld else ""
        )
        return (
            f"redaction (D1): {self.texts} texts, {self.changed} redacted, "
            f"{self.withheld} withheld, {self.unchanged} unchanged ({methods}); "
            f"LLM {self.llm_calls} calls, {self.llm_cached} cached, {self.llm_failed} failed, "
            f"{self.rejected_replies} replies failed the checks{dropped}{speakers}"
        )


class Redactor:
    """Makes texts public-safe. `llm` None: cached replies and the rule only
    (a dry run, or no model configured). Thread-safe; share one per run."""

    def __init__(
        self,
        llm: LLMClient | None = None,
        memo: LLMMemo | None = None,
        *,
        workers: int = 8,
        gate: AiGate | None = None,
    ) -> None:
        self.llm = llm
        self.memo = memo
        #: Per-source AI opt-outs (`extract.ai_gate`): a text whose general
        #: source keeps AI out is redacted by the rule, never by the model.
        self.gate = gate
        self.workers = max(1, workers)
        self.prompt = PROMPT_PATH.read_text(encoding="utf-8")
        self.stats = RedactionStats()
        self._lock = threading.Lock()

    def _count(self, name: str) -> None:
        with self._lock:
            setattr(self.stats, name, getattr(self.stats, name) + 1)

    def redact(self, request: RedactRequest) -> Redaction:
        """The public-safe form of `request.text` (module docstring): links to
        personal profiles reduced to their text first, then the gate, the
        model or the rule, then links that spell a redacted name."""
        original = request.text
        if not original.strip():
            return Redaction(original, original, "none")
        text = strip_profile_links(original)
        inner = request if text == original else replace(request, text=text)
        result = self._redact(inner)
        if result.text is None:
            return Redaction(original, None, "withheld", result.redactions)
        names = [name for name, _ in result.redactions] + list(request.private)
        final = strip_named_links(result.text, names) if names else result.text
        return Redaction(original, final, result.method, result.redactions)

    def _redact(self, request: RedactRequest) -> Redaction:
        text = request.text
        safe = [*request.safe, *(word for name in request.keep for word in name.split())]
        if not needs_model(text, safe) and not any(
            contains_name(text, name) for name in request.private
        ):
            return Redaction(text, text, "none")
        if not request.llm:
            return rule_redact(request)
        reply = self._reply(request)
        if reply is None:
            # No reply: the model failed (strict), or none is configured (a
            # dry run, cached replies only).
            return rule_redact(request, strict=self.llm is not None)
        accepted = accept_reply(request, reply)
        if accepted is not None:
            return accepted
        self._count("rejected_replies")
        verified = [
            (item.original.strip(), _phrase(item.replacement))
            for item in reply.redactions
            if item.original.strip() and item.original.strip() in text
        ]
        return rule_redact(request, verified, strict=True)

    def redact_many(self, requests: Sequence[RedactRequest]) -> list[Redaction]:
        """Every request, the model calls in parallel (`workers`)."""
        if not requests:
            return []
        with ThreadPoolExecutor(max_workers=min(self.workers, len(requests))) as pool:
            return list(pool.map(self.redact, requests))

    def _reply(self, request: RedactRequest) -> RedactReply | None:
        key = memo_key(
            PROMPT_NAME, request.text, "\n".join(sorted(request.keep)), "\n".join(request.private)
        )
        if self.memo is not None:
            cached = self.memo.get(PROMPT_NAME, key, RedactReply)
            if cached is not None:
                self._count("llm_cached")
                return cached[0]
        if self.llm is None:
            return None
        try:
            call = self.llm.complete_json(
                schema=RedactReply,
                messages=[
                    {"role": "system", "content": self.prompt},
                    {"role": "user", "content": _user_message(request)},
                ],
                prompt_version=PROMPT_NAME,
            )
        except Exception as error:  # validation or transport: the fallback decides
            self._count("llm_failed")
            logger.warning("redaction LLM call failed (%s)", type(error).__name__)
            return None
        self._count("llm_calls")
        if self.memo is not None:
            self.memo.put(PROMPT_NAME, key, call.value, call.model)
        return call.value


def _user_message(request: RedactRequest) -> str:
    keep = "\n".join(f"- {name}" for name in request.keep) or "(none)"
    private = "\n".join(f"- {name}" for name in request.private) or "(none)"
    return (
        f"Keep these names (published speakers):\n{keep}\n\n"
        f"Committee members (private, always replace):\n{private}\n\n"
        f"--- TEXT ---\n{request.text}"
    )


def redactor_for(settings: Settings, *, dry_run: bool) -> tuple[Redactor, str | None]:
    """The run's redactor: the bulk model with the reply cache, or cached
    replies and the rule only in a dry run or without a configured model.
    Returns it with a note for the stage report when no model is used."""
    memo = LLMMemo(settings.cache_dir / "llm")
    if dry_run:
        return Redactor(None, memo), "redaction: dry run, cached replies and the rule only"
    try:
        llm = LLMClient(settings.require_llm())
    except ConfigError as error:
        return Redactor(None, memo), f"redaction: no LLM ({error}), cached replies and the rule"
    note = None
    try:
        client: PoliteClient | None = PoliteClient(
            user_agent=settings.require_user_agent(),
            cache_dir=settings.cache_dir,
            min_interval=settings.min_host_interval,
        )
    except ConfigError as error:
        client = None
        note = f"redaction: AI opt-outs cannot be checked ({error}); general sources use the rule"
    redactor = Redactor(llm, memo, workers=settings.llm_concurrency, gate=AiGate(client))
    return redactor, note


# --- claims ---------------------------------------------------------------------------------------


def private_names(
    records: Iterable[Observation | EventObservation],
    primary_of: Mapping[tuple[str, str], tuple[str, str]] | None = None,
) -> dict[str, tuple[str, ...]]:
    """Known committee members per entity key: the broker ``people`` (and
    ``private_names``, the names a site's reading listed) of an organisation,
    shared with its sessions and with the events it organises (by organiser
    key; a reading merged into another source's event, `primary_of`, counts
    for that event)."""
    records = list(records)
    by_org: dict[str, set[str]] = {}
    sessions: dict[str, str] = {}
    events: dict[str, set[str]] = {}
    for record in records:
        if isinstance(record, EventObservation):
            identity = (record.event_source, record.external_id)
            target = event_key(*(primary_of or {}).get(identity, identity))
            organisers = {o.identity.known_key for o in record.organisers if o.identity.known_key}
            events.setdefault(target, set()).update(k for k in organisers if k)
            continue
        if not isinstance(record, Observation) or record.entity_key is None:
            continue
        if record.entity_type == "session" and record.parent and record.parent.known_key:
            sessions[record.entity_key] = record.parent.known_key
        if record.entity_type != "organisation":
            continue
        names = by_org.setdefault(record.entity_key, set())
        for person in record.broker.get("people", []):
            if isinstance(person, dict) and isinstance(person.get("name"), str):
                names.add(person["name"].strip())
        for name in record.broker.get("private_names", []):
            if isinstance(name, str):
                names.add(name.strip())
    result = {key: tuple(sorted(n for n in names if n)) for key, names in by_org.items() if names}
    for session, org in sessions.items():
        if org in result:
            result[session] = result[org]
    for event, organisers in events.items():
        names = {name for org in organisers for name in result.get(org, ())}
        if names:
            result[event] = tuple(sorted(names))
    return result


_GOOD_QUOTE = frozenset({"exact", "normalised"})


def _event_types(claims: Sequence[ClaimInput]) -> dict[str, set[str]]:
    types: dict[str, set[str]] = {}
    for claim in claims:
        if claim.entity_type == "event" and claim.field == "eventType" and claim.value:
            types.setdefault(claim.entity_key, set()).add(str(claim.value))
    return types


def _speaker_names(value: Any) -> list[str]:
    return [
        speaker["name"].strip()
        for speaker in (value if isinstance(value, list) else [])
        if isinstance(speaker, dict) and isinstance(speaker.get("name"), str)
    ]


def _known(name: str, known: Iterable[str]) -> bool:
    """Whether `name` is a known committee member (or one is part of it)."""
    return any(_kept(name, (member,)) for member in known if member.strip())


def published_speakers(
    claim: ClaimInput, types: Mapping[str, set[str]], known: Iterable[str]
) -> list[dict[str, Any]] | None:
    """The speakers of a `speakers` claim that may be published, or None
    when the list may not be: a model's list only for a talk or a workshop
    (`SPEAKER_EVENT_TYPES`) and with its quote on the page; never a known
    committee member of any organisation (D1, D2)."""
    if not isinstance(claim.value, list):
        return None
    if claim.method == "llm" and (
        claim.quote_check not in _GOOD_QUOTE
        or not types.get(claim.entity_key, set()) & SPEAKER_EVENT_TYPES
    ):
        return None
    kept = [
        speaker
        for speaker in claim.value
        if isinstance(speaker, dict)
        and isinstance(speaker.get("name"), str)
        and not _known(speaker["name"], known)
    ]
    return kept or None


def _entity_words(entity_key: str) -> tuple[str, ...]:
    """The words of an entity's own key (``org-cambridge-chess-club``)."""
    return tuple(word for word in entity_key.split("-")[1:] if len(word) > 1)


def _llm_allowed(claim: ClaimInput) -> bool:
    if claim.source_type in NO_LLM_SOURCE_TYPES:
        return False
    try:
        assert_llm_source_allowed(claim.source_url)
    except NoLLMHost:
        return False
    return True


def _texts(kind: str, value: Any) -> list[str]:
    """The public texts inside a value of `kind`."""
    if kind in ("text", "title"):
        return [value] if isinstance(value, str) else []
    out: list[str] = []
    if kind == "membership" and isinstance(value, dict):
        for tier in value.get("tiers") or []:
            if isinstance(tier, dict):
                out += [tier[k] for k in ("label", "note") if isinstance(tier.get(k), str)]
        if isinstance(value.get("bursaryNote"), str):
            out.append(value["bursaryNote"])
    if kind == "trials" and isinstance(value, dict):
        if isinstance(value.get("note"), str):
            out.append(value["note"])
        out += [d for d in value.get("dates") or [] if isinstance(d, str)]
    if kind == "price" and isinstance(value, dict) and isinstance(value.get("text"), str):
        out.append(value["text"])
    if kind == "chat" and isinstance(value, list):
        out += [
            item["howToJoin"]
            for item in value
            if isinstance(item, dict) and isinstance(item.get("howToJoin"), str)
        ]
    return out


def _without(value: dict[str, Any], key: str, done: Mapping[str, Redaction]) -> dict[str, Any]:
    """`value` with the text under `key` redacted, or left out if withheld."""
    rebuilt = dict(value)
    if isinstance(value.get(key), str):
        text = done[value[key]].text
        if text is None or not text.strip():
            rebuilt.pop(key)
        else:
            rebuilt[key] = text
    return rebuilt


def _rebuild(kind: str, value: Any, done: Mapping[str, Redaction]) -> Any:
    """`value` with every text replaced by its redaction; a withheld label
    drops its tier, a withheld note (date, price text, how to join) is left
    out. None when nothing is left."""
    if kind in ("text", "title"):
        text = done[value].text
        return text if text and text.strip() else None
    if kind == "price":
        return _without(value, "text", done) if isinstance(value, dict) else value
    if kind == "chat":
        if not isinstance(value, list):
            return value
        return [
            _without(item, "howToJoin", done) if isinstance(item, dict) else item for item in value
        ]
    if kind == "membership":
        tiers = []
        for tier in value.get("tiers") or []:
            if not isinstance(tier, dict):
                continue
            entry = dict(tier)
            if isinstance(tier.get("label"), str):
                label = done[tier["label"]].text
                if label is None:
                    continue
                entry["label"] = label
            if isinstance(tier.get("note"), str):
                note = done[tier["note"]].text
                if note is None:
                    entry.pop("note")
                else:
                    entry["note"] = note
            tiers.append(entry)
        rebuilt = {**value, "tiers": tiers}
        if isinstance(value.get("bursaryNote"), str):
            bursary = done[value["bursaryNote"]].text
            if bursary is None:
                rebuilt.pop("bursaryNote")
            else:
                rebuilt["bursaryNote"] = bursary
        return rebuilt if tiers or "bursaryNote" in rebuilt else None
    if kind == "trials":
        rebuilt = _without(value, "note", done)
        if isinstance(value.get("dates"), list):
            dates = [
                done[d].text if isinstance(d, str) else d
                for d in value["dates"]
                if not isinstance(d, str) or done[d].text
            ]
            if dates:
                rebuilt["dates"] = dates
            else:
                rebuilt.pop("dates")
        return rebuilt
    return value


def _fit(text: str, limit: int | None) -> str:
    """A redacted text a longer role made too long, cut at a word."""
    if limit is None or len(text.encode("utf-16-le")) // 2 <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def _tagged(extractor: str, tag: str) -> str:
    suffix = f"+{tag}"
    return extractor[: MAX_EXTRACTOR - len(suffix)] + suffix


def redact_claims(
    claims: Sequence[ClaimInput],
    redactor: Redactor,
    *,
    private: Mapping[str, tuple[str, ...]] | None = None,
) -> tuple[list[ClaimInput], RedactionStats]:
    """Every public free-text claim made public-safe (module docstring). The
    value becomes the redacted text and `valueRaw` the original; a withheld
    text becomes a ``missing`` / ``not_published`` claim, and a withheld
    title takes every claim of its event or session with it
    (`RedactionStats.dropped`). A speaker list that may not be published
    (`published_speakers`) becomes ``missing`` / ``not_published`` too, so an
    earlier reading of it is retracted. Other claims pass through untouched."""
    private = private or {}
    known = sorted({name for names in private.values() for name in names})
    types = _event_types(claims)
    out = list(claims)
    speakers: dict[str, set[str]] = {}
    unpublished: dict[str, set[str]] = {}
    for index, claim in enumerate(claims):
        if claim.entity_type != "event" or claim.field != "speakers" or claim.value is None:
            continue
        listed = _speaker_names(claim.value)
        kept = published_speakers(claim, types, known)
        if kept is None:
            out[index] = _not_published(claim)
            redactor.stats.speakers_withheld += 1
        elif len(kept) < len(claim.value):
            out[index] = claim.model_copy(update={"value": kept})
        names = set(_speaker_names(kept or []))
        speakers.setdefault(claim.entity_key, set()).update(names)
        # A name not published as a speaker is redacted like any other, and
        # a known committee member always.
        unpublished.setdefault(claim.entity_key, set()).update(
            name for name in listed if name not in names and _known(name, known)
        )
    targets: list[tuple[int, str, list[tuple[str, RedactRequest]]]] = []
    for index, claim in enumerate(out):
        kind = PUBLIC_TEXT_FIELDS.get((claim.entity_type, claim.field))
        if kind is None or claim.value is None:
            continue
        own = private.get(claim.entity_key, ())
        extra = tuple(sorted(unpublished.get(claim.entity_key, set()) - set(own)))
        texts = [
            (
                text,
                RedactRequest(
                    text=text,
                    keep=tuple(sorted(speakers.get(claim.entity_key, set()))),
                    private=(*own, *extra),
                    safe=_entity_words(claim.entity_key),
                    llm=_llm_allowed(claim)
                    and (
                        redactor.gate is None
                        or redactor.gate.allows(claim.source_url, claim.source_type)
                    ),
                    title=kind == "title",
                ),
            )
            for text in _texts(kind, claim.value)
        ]
        targets.append((index, kind, texts))
    unique = list(dict.fromkeys(request for _i, _k, texts in targets for _t, request in texts))
    results = dict(zip(unique, redactor.redact_many(unique), strict=True))
    dropped: set[tuple[str, str]] = set()
    for index, kind, texts in targets:
        done = {text: results[request] for text, request in texts}
        out[index] = _redacted_claim(out[index], kind, done, redactor.stats)
        if kind == "title" and any(r.text is None for r in done.values()):
            dropped.add((out[index].entity_type, out[index].entity_key))
    if dropped:
        redactor.stats.dropped.extend(sorted(key for _type, key in dropped))
        out = [c for c in out if (c.entity_type, c.entity_key) not in dropped]
    return out, redactor.stats


def _not_published(claim: ClaimInput) -> ClaimInput:
    return claim.model_copy(
        update={
            "value": None,
            "value_raw": None,
            "status": "missing",
            "missing_reason": "not_published",
            "evidence_quote": None,
            "quote_check": None,
        }
    )


def _redacted_claim(
    claim: ClaimInput, kind: str, done: Mapping[str, Redaction], stats: RedactionStats
) -> ClaimInput:
    redactions = list(done.values())
    stats.texts += 1
    for redaction in redactions:
        stats.by_method[redaction.method] += 1
    worst: Method = "none"
    for method in ("llm", "rule", "withheld"):
        if any(r.method == method for r in redactions):
            worst = method  # type: ignore[assignment]
    tag = WITHHELD_TAG if worst == "withheld" else RULE_TAG if worst == "rule" else TAG
    value = _rebuild(kind, claim.value, done)
    if isinstance(value, str):
        value = _fit(value, LIMITS.get((claim.entity_type, claim.field)))
    if value == claim.value:
        stats.unchanged += 1
        return claim.model_copy(update={"extractor": _tagged(claim.extractor, tag)})
    raw = claim.value if isinstance(claim.value, str) else canonical_json(claim.value)
    value_raw = claim.value_raw or raw
    if value is None:
        stats.withheld += 1
        return claim.model_copy(
            update={
                "value": None,
                "value_raw": value_raw,
                "status": "missing",
                "missing_reason": "not_published",
                "evidence_quote": None,
                "quote_check": None,
                "extractor": _tagged(claim.extractor, WITHHELD_TAG),
            }
        )
    stats.changed += 1
    if worst == "withheld":
        tag = RULE_TAG  # a part was withheld, the rest published
    return claim.model_copy(
        update={"value": value, "value_raw": value_raw, "extractor": _tagged(claim.extractor, tag)}
    )


__all__ = [
    "PROMPT_NAME",
    "PUBLIC_TEXT_FIELDS",
    "REPLACEMENT_WORDS",
    "RULE_TAG",
    "SAFE_WORDS",
    "SPEAKER_EVENT_TYPES",
    "TAG",
    "WITHHELD_TAG",
    "NameRedaction",
    "RedactReply",
    "RedactRequest",
    "Redaction",
    "RedactionStats",
    "Redactor",
    "accept_reply",
    "allowed_replacement",
    "candidate_names",
    "contains_name",
    "needs_model",
    "private_names",
    "published_speakers",
    "redact_claims",
    "redactor_for",
    "rule_redact",
    "strip_named_links",
    "strip_profile_links",
    "url_names",
]
