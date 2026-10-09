"""Public free text with personal names replaced by roles. This is Joshua's
decision D1 (PLAN.md decisions log, 2026-10-08): "contact our President,
Anna" is published as "contact our President".

**What it covers** (`PUBLIC_TEXT_FIELDS`), from every source (SU, websites,
Camdram, Sport, termcards, mail, SU What's On, calendar feeds, talks.cam):

- an organisation's shortDescription, description, howToJoin,
  timeCommitment and accessibilityNote;
- the labels and notes of its membership tiers, its bursary note, and the
  note of its trials;
- a session's note;
- an event's description.

The speakers an event publishes (`events.speakers`) are public and stay
named, both in that field and in its description. Committee members
(D2) live only in the private broker tables.

**Where it runs.** `redact_claims`, called from
`ConvexLoader.post_observations`, the one path every claim takes to Convex
(the load and inbox stages). Staged observations keep the text as the source
wrote it. The posted claim's value is the redacted text and its `valueRaw` is
the original, which only internal tables hold (data-model §3).

**How** (`Redactor.redact`):

1. **No candidate name, no change.** If every capitalised word in a text is
   a known non-name (`SAFE_WORDS`, the words of the entity's own key, the
   event's speakers), the text cannot name a private person, and no LLM call
   is made.
2. **The LLM pass.** The bulk model runs the prompt
   ``extract/prompts/redact_names_v1.md`` and returns
   ``{text, redactions: [{original, replacement}]}``. It replaces the names of
   private individuals with their role or a neutral phrase, and keeps
   organisations, places, public figures and the event's speakers. Replies
   are cached by the sha256 of the input (`extract/memo.py`). talks.cam
   content never goes to the model (§6); it takes step 4 only.
3. **Deterministic post-checks** (`accept_reply`). Every ``original`` must be
   in the input, and none may be a kept name. Every replacement must be made
   of role and neutral words (`REPLACEMENT_WORDS`). The text may introduce no
   other new word. Its length must stay within what the replacements explain.
   No redacted name and no known committee member may be left in it.
4. **The fallback**, used when the reply fails a check, the model fails, or
   no model may or can be asked (`rule_redact`). The reply's verified names
   and the known committee members are replaced, committee-list lines
   ("President: Anna Smith") are dropped, and capitalised names right next
   to a role word or a contact verb are removed. If a candidate name still
   stands next to a role word or a contact verb, the text is **withheld**:
   the claim is posted as ``missing`` / ``not_published`` instead.

**Provenance.** The claim's status is unchanged (found or inferred). Its
`extractor` gains ``+redacted:v1`` (the LLM pass, or no names found),
``+redacted:v1:rule`` (the fallback) or ``+redacted:v1:withheld``.
"""

from __future__ import annotations

import logging
import re
import threading
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES
from camsocs_pipeline.config import ConfigError, Settings
from camsocs_pipeline.extract.llm import LLMClient, NoLLMHost, assert_llm_source_allowed
from camsocs_pipeline.extract.memo import LLMMemo, memo_key
from camsocs_pipeline.keys import canonical_json
from camsocs_pipeline.models.observation import EventObservation, Observation
from camsocs_pipeline.models.wire import ClaimInput

logger = logging.getLogger(__name__)

PROMPT_NAME = "redact_names_v1"
PROMPT_PATH = Path(__file__).parent / "prompts" / f"{PROMPT_NAME}.md"
TAG = "redacted:v1"
RULE_TAG = "redacted:v1:rule"
WITHHELD_TAG = "redacted:v1:withheld"

#: (entity type, field) → the shape of its public text.
PUBLIC_TEXT_FIELDS: Mapping[tuple[str, str], str] = {
    ("organisation", "shortDescription"): "text",
    ("organisation", "description"): "text",
    ("organisation", "howToJoin"): "text",
    ("organisation", "timeCommitment"): "text",
    ("organisation", "accessibilityNote"): "text",
    ("organisation", "membership"): "membership",
    ("organisation", "trials"): "trials",
    ("session", "note"): "text",
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
#: Will, Clare, John, Lucy, Sidney, Robinson …) are left out on purpose, so a
#: text with them is read by the model. Lower-case, as `_norm_word` leaves
#: them ("King's" → "king").
SAFE_WORDS = frozenset(
    """
    a about academic access after again all also alumni an and annual any are art arts as at
    autumn ball be beginner beginners blue blues bumps but by can cambridge cambridgeshire
    careers centre chapel check christmas club clubs college colleges come committee
    competition competitions computer contact court cu cusu dance day dear december
    department debate debates do does each easter email england english europe european
    event events every everyone facebook faculty fair february festival film find follow
    for formal formals free freshers friday from fund get go google graduate graduates
    group groups hall have he hello her here hi his history how i if in instagram
    institute international is it its january jcr join july just lane law learn lecture
    lent let library linkedin linktree london looking lunch march mcr meet meeting
    meetings member members membership michaelmas monday more museum music my national
    new no not november now october of on once one open or our out oxford party please
    politics postgraduate postgraduates practice registered research road room rowing
    saturday school science season see september session sessions she sign so social
    socials societies society some sport sports spring street student students su summer
    sunday support talk talks team teams term terms that the their them then there these
    they this those thursday tiktok to training trip trips tuesday uk undergraduate
    undergraduates union university us varsity visit want we wednesday week weekly weeks
    welcome what whatsapp when where whether which who why winter with workshop workshops
    world year years you your youtube zoom
    caius christ corpus downing fitzwilliam girton gonville homerton jesus king magdalene
    newnham pembroke peterhouse queen queens trinity
    """.split()  # noqa: SIM905 (a word list reads better as text)
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
#: model reply verified without a usable role. It contains no role word, so
#: it never trips the risk check itself.
NEUTRAL = "a member of the committee"


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


def candidate_names(text: str, safe: Iterable[str] = ()) -> set[str]:
    """Capitalised words in `text` that could be a personal name: not in
    `SAFE_WORDS`, not a role word, and not in `safe` (words of the entity's
    own name or of names that are kept)."""
    extra = {_norm_word(word) for word in safe}
    return {
        match.group(0)
        for match in _CAPITALISED.finditer(text)
        if not _not_a_name(match.group(0), extra)
    }


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
    sent to the model (never for talks.cam)."""

    text: str
    keep: tuple[str, ...] = ()
    private: tuple[str, ...] = ()
    safe: tuple[str, ...] = ()
    llm: bool = True


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
        return _not_a_name(name[span[0] : span[1]], safe)

    first, last = 0, len(spans)
    while first < last and is_safe(spans[first]):
        first += 1
    while last > first and is_safe(spans[last - 1]):
        last -= 1
    if first == last:
        return name, "", ""
    start, end = spans[first][0], spans[last - 1][1]
    return name[:start], name[start:end], name[end:]


def rule_redact(request: RedactRequest, extra: Sequence[tuple[str, str]] = ()) -> Redaction:
    """The conservative deterministic redaction (module docstring, step 4).
    `extra`: verified (name, replacement) pairs from a model reply that failed
    its checks."""
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
    for name, replacement in named:
        if contains_name(text, name):
            usable = replacement if allowed_replacement(replacement) else NEUTRAL
            text = _apply(text, [(name, usable or NEUTRAL)])
            pairs.append((name, usable))
    text = _tidy(text)
    if not text.strip() or _risky(
        text, safe | {_norm_word(w) for k in keep for w in k.split()}, keep
    ):
        return Redaction(request.text, None, "withheld", tuple(pairs))
    return Redaction(request.text, text, "rule", tuple(pairs))


def _risky(text: str, safe: set[str], keep: Sequence[str]) -> bool:
    """A candidate name within a few words of a role word or contact verb,
    in the same sentence.

    Candidates are runs of capitalised words that are not all known
    non-names. A run right after "the", "our", "a" … is a title or a team
    ("the Lower Boats Captains"), not a person. A single word that starts a
    sentence is a name only when a verb like "is" follows it ("Anna is our
    President"); otherwise it is the sentence's first word ("Chaired by")."""
    tokens = [(match.start(), match.group(0)) for match in _WORD.finditer(text)]
    triggers = [match.start() for match in _TRIGGER.finditer(text)]
    if not triggers:
        return False
    starts = [start for start, _ in tokens]
    trigger_index = {starts.index(t) for t in triggers if t in starts}
    breaks = [match.end() for match in _SENTENCE_END.finditer(text)]
    sentence = [sum(1 for end in breaks if end <= start) for start in starts]
    capitalised = [bool(_CAPITALISED.fullmatch(word)) for _start, word in tokens]

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
            i for i in run if not _not_a_name(tokens[i][1], safe) and not _kept(tokens[i][1], keep)
        ]
        previous = tokens[index - 1][1].lower() if index > 0 else ""
        follower = tokens[end + 1][1].lower() if end + 1 < len(tokens) else ""
        lone_first_word = (
            len(run) == 1
            and _SENTENCE_START.search(text[: tokens[index][0]]) is not None
            and follower not in _COPULAS
        )
        near_trigger = any(
            abs(i - t) <= _TRIGGER_WINDOW and sentence[t] == sentence[i]
            for i in names
            for t in trigger_index
        )
        if names and previous not in _DETERMINERS and not lone_first_word and near_trigger:
            return True
        index = end + 1
    return False


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

    def __str__(self) -> str:
        methods = ", ".join(f"{name} {count}" for name, count in sorted(self.by_method.items()))
        return (
            f"redaction (D1): {self.texts} texts, {self.changed} redacted, "
            f"{self.withheld} withheld, {self.unchanged} unchanged ({methods}); "
            f"LLM {self.llm_calls} calls, {self.llm_cached} cached, {self.llm_failed} failed, "
            f"{self.rejected_replies} replies failed the checks"
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
    ) -> None:
        self.llm = llm
        self.memo = memo
        self.workers = max(1, workers)
        self.prompt = PROMPT_PATH.read_text(encoding="utf-8")
        self.stats = RedactionStats()
        self._lock = threading.Lock()

    def _count(self, name: str) -> None:
        with self._lock:
            setattr(self.stats, name, getattr(self.stats, name) + 1)

    def redact(self, request: RedactRequest) -> Redaction:
        text = request.text
        if not text.strip():
            return Redaction(text, text, "none")
        safe = [*request.safe, *(word for name in request.keep for word in name.split())]
        if not candidate_names(text, safe) and not any(
            contains_name(text, name) for name in request.private
        ):
            return Redaction(text, text, "none")
        if not request.llm:
            return rule_redact(request)
        reply = self._reply(request)
        if reply is None:
            return rule_redact(request)
        accepted = accept_reply(request, reply)
        if accepted is not None:
            return accepted
        self._count("rejected_replies")
        verified = [
            (item.original.strip(), _phrase(item.replacement))
            for item in reply.redactions
            if item.original.strip() and item.original.strip() in text
        ]
        return rule_redact(request, verified)

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
    return Redactor(llm, memo, workers=settings.llm_concurrency), None


# --- claims ---------------------------------------------------------------------------------------


def private_names(records: Iterable[Observation | EventObservation]) -> dict[str, tuple[str, ...]]:
    """Known committee members per entity key: the broker ``people`` (and
    ``private_names``, the names a site's reading listed) of an organisation,
    shared with its sessions."""
    by_org: dict[str, set[str]] = {}
    sessions: dict[str, str] = {}
    for record in records:
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
    return result


def _speakers(claims: Sequence[ClaimInput]) -> dict[str, tuple[str, ...]]:
    names: dict[str, set[str]] = {}
    for claim in claims:
        if claim.entity_type == "event" and claim.field == "speakers" and claim.value:
            for speaker in claim.value if isinstance(claim.value, list) else []:
                if isinstance(speaker, dict) and isinstance(speaker.get("name"), str):
                    names.setdefault(claim.entity_key, set()).add(speaker["name"].strip())
    return {key: tuple(sorted(n for n in found if n)) for key, found in names.items()}


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
    if kind == "text":
        return [value] if isinstance(value, str) else []
    out: list[str] = []
    if kind == "membership" and isinstance(value, dict):
        for tier in value.get("tiers") or []:
            if isinstance(tier, dict):
                out += [tier[k] for k in ("label", "note") if isinstance(tier.get(k), str)]
        if isinstance(value.get("bursaryNote"), str):
            out.append(value["bursaryNote"])
    if kind == "trials" and isinstance(value, dict) and isinstance(value.get("note"), str):
        out.append(value["note"])
    return out


def _rebuild(kind: str, value: Any, done: Mapping[str, Redaction]) -> Any:
    """`value` with every text replaced by its redaction; a withheld label
    drops its tier, a withheld note is left out. None when nothing is left."""
    if kind == "text":
        text = done[value].text
        return text if text and text.strip() else None
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
        if not isinstance(value.get("note"), str):
            return value
        rebuilt = dict(value)
        note = done[value["note"]].text
        if note is None:
            rebuilt.pop("note")
        else:
            rebuilt["note"] = note
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
    text becomes a ``missing`` / ``not_published`` claim. Other claims pass
    through untouched."""
    private = private or {}
    speakers = _speakers(claims)
    targets: list[tuple[int, str, list[tuple[str, RedactRequest]]]] = []
    for index, claim in enumerate(claims):
        kind = PUBLIC_TEXT_FIELDS.get((claim.entity_type, claim.field))
        if kind is None or claim.value is None:
            continue
        texts = [
            (
                text,
                RedactRequest(
                    text=text,
                    keep=speakers.get(claim.entity_key, ()),
                    private=private.get(claim.entity_key, ()),
                    safe=_entity_words(claim.entity_key),
                    llm=_llm_allowed(claim),
                ),
            )
            for text in _texts(kind, claim.value)
        ]
        targets.append((index, kind, texts))
    unique = list(dict.fromkeys(request for _i, _k, texts in targets for _t, request in texts))
    results = dict(zip(unique, redactor.redact_many(unique), strict=True))
    out = list(claims)
    for index, kind, texts in targets:
        done = {text: results[request] for text, request in texts}
        out[index] = _redacted_claim(claims[index], kind, done, redactor.stats)
    return out, redactor.stats


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
    "private_names",
    "redact_claims",
    "redactor_for",
    "rule_redact",
]
