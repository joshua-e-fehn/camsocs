"""Calendar noise (decision D6, 2026-10-10): the model for borderline
readings, the claims a verdict becomes, and the sifting every load does
(data-model §2 "Calendar noise"). The rules themselves are deterministic and
live in `events.noise`.

**Where it runs.** `sift_events`, called by `ConvexLoader.post_observations` —
the one path every event takes to Convex (the load stage, and the inbox
stage's own posts) — before duplicates are found, so a notice never becomes
another reading's primary. Staging keeps every reading as its source listed
it. A ``notice`` is **dropped**: none of its claims is posted, and the notes
count each rule and show a few titles (addresses withheld) with their keys.
When another listing's kept reading has the same key (one calendar UID on
two calendars: the Islamic Society's sisters' calendar lists the brothers'
Quran circle as "PR closed to sisters (Brothers Quran Circle)"), the notice
is **retracted** instead (`retraction`): every field it gave is restated
``missing`` / ``not_found`` from its listing and method, so its earlier
readings — posted before D6 — stop competing with the event's own title.
Every other keyed reading gains a ``hosting`` observation — ``takes_part``
for an external event, with its page as ``externalUrl`` (``missing`` /
``not_found`` when the text gives none, so an earlier page does not linger) —
unless its source states ``hosting`` itself.

**Provenance** (`verdict_fields`). A rule's verdict is a parser claim,
``inferred`` (a rule judges what a text means; the source does not state
it), extractor ``event_noise.<rule>``, the words it matched as the evidence
quote. A model's verdict is an LLM claim, extractor the model id, prompt
version ``event_noise_v1``, its quote checked against the text it was shown:
``found`` with a verified quote, ``inferred`` without. Server-side, of each
source's ``hosting`` claims only the newest counts, whatever its method, and
across sources ``takes_part`` wins (convex/lib/fields.ts).

**The model for what stays borderline** (`NoiseClassifier`): the bulk model
reads the entry with the prompt ``extract/prompts/event_noise_v1.md`` and
returns ``{kind, evidence_quote, external_link}``. A ``notice`` without a
verified quote is kept as an event (a wrong notice would hide a real event);
an ``external`` verdict without one is still claimed, ``inferred``. The link
must be one of the candidate pages the entry gave (`events.noise.
candidate_links`: never a chat invite, a form, a meeting link, a map, a
social or personal profile, a file or the organiser's own site). Replies are
cached by the input's sha256 (`extract.memo`). talks.cam content never
reaches the model (§6), nor text that relays it (a talks.cam link), nor a
general source whose host or page keeps AI out (`extract.ai_gate`); such
borderline readings — and, in a dry run, those without a cached reply —
stay ``hosts`` (``event.default``) and the notes count them.
"""

from __future__ import annotations

import logging
import re
import threading
from collections import Counter
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from string import Template

from pydantic import BaseModel, ConfigDict

from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES, evidence_of, missing_field, parser_field
from camsocs_pipeline.config import ConfigError, Settings
from camsocs_pipeline.events.noise import EventText, Kind, NoiseContext, Verdict, judge
from camsocs_pipeline.extract.ai_gate import AiGate
from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote
from camsocs_pipeline.extract.llm import LLMClient, NoLLMHost, assert_llm_source_allowed
from camsocs_pipeline.extract.memo import LLMMemo, memo_key
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.models.observation import EventObservation, FieldObs, Observation
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.links import CRSID_PATTERN, EMAIL_PATTERN

logger = logging.getLogger(__name__)

PROMPT_NAME = "event_noise_v1"
PROMPT_PATH = Path(__file__).parent / "prompts" / f"{PROMPT_NAME}.md"
#: The extractor prefix of a rule's verdict: ``event_noise.<rule>``.
EXTRACTOR = "event_noise"

#: Longest description the model is shown (the CTFtime imports run to pages).
MAX_DESCRIPTION = 3_000
#: Titles shown per notice rule in the load notes.
EXAMPLES_PER_RULE = 3


_CRSID = re.compile(rf"\b{CRSID_PATTERN}\b")  # CRSids are lower case: "MT26" is none


def _example(title: str) -> str:
    """A dropped notice's title as the run notes show it: one line, no
    address, no CRSid."""
    title = _CRSID.sub("[withheld]", EMAIL_PATTERN.sub("[address withheld]", title))
    return " ".join(title.split())[:80]


# --- the model ------------------------------------------------------------------------------


class NoiseReply(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: Kind
    evidence_quote: str = ""
    #: 1-based number of the candidate link that is the external event's page.
    external_link: int | None = None


_LISTINGS = {
    "ics_feed": "the organisation's own calendar feed",
    "luma": "the organisation's own Luma calendar",
    "society_website": "the organisation's own website",
    "termcard": "the organisation's own termcard",
    "mailing_list_email": "a mail to the organisation's mailing list",
    "instagram_api": "the organisation's own Instagram post",
}


def render_entry(text: EventText, signals: Sequence[str]) -> str:
    """The entry as the prompt shows it."""
    description = text.description[:MAX_DESCRIPTION]
    lines = [
        f"Listed by: {', '.join(text.organisers[:3]) or '(not known)'}",
        f"Listing: {_LISTINGS.get(text.source_type, text.source_type)}",
        f"Signals: {', '.join(signals) or 'none'}",
        "",
        "--- ENTRY ---",
        f"Title: {text.title}",
        f"Venue: {text.venue or '(none)'}",
        "Description:",
        description or "(none)",
        "",
        "--- LINKS ---",
    ]
    links = text.links()
    lines.extend(f"{number}. {link}" for number, link in enumerate(links, start=1))
    if not links:
        lines.append("(none)")
    return "\n".join(lines)


def _relays_talks_cam(text: EventText) -> bool:
    return any("talks.cam.ac.uk" in part.lower() for part in (text.text(), *text.urls))


@dataclass
class NoiseStats:
    """What `sift_events` did: the load notes."""

    readings: int = 0
    dropped: Counter = field(default_factory=Counter)
    external: Counter = field(default_factory=Counter)
    #: (rule, title, event key) of a few dropped notices per rule.
    examples: list[tuple[str, str, str]] = field(default_factory=list)
    dropped_keys: list[str] = field(default_factory=list)
    #: Dropped notices whose event another listing keeps: restated `not_found`.
    retracted: int = 0
    borderline: int = 0
    model_calls: int = 0
    model_cached: int = 0
    model_failed: int = 0
    #: Model verdicts whose quote was not in the text (a notice is then kept).
    unverified: int = 0
    #: Borderline readings no model could read (talks.cam, an AI opt-out, a dry run).
    undecided: int = 0

    def notes(self) -> list[str]:
        if not self.readings:
            return []
        dropped = sum(self.dropped.values())
        external = sum(self.external.values())

        def tally(counter: Counter) -> str:
            return ", ".join(f"{name} {count}" for name, count in sorted(counter.items()))

        notes = [
            f"calendar noise (D6): {self.readings} event readings; {dropped} notices dropped"
            + (f" ({tally(self.dropped)})" if dropped else "")
            + f"; {external} taken part in, not hosted"
            + (f" ({tally(self.external)})" if external else "")
            + f"; {self.borderline} borderline: model {self.model_calls} calls, "
            f"{self.model_cached} cached, {self.model_failed} failed, "
            f"{self.unverified} without a verified quote, {self.undecided} left hosted (no model)"
        ]
        if self.retracted:
            notes.append(
                f"  {self.retracted} of the notices restated not_found on an event another "
                "listing keeps"
            )
        notes.extend(f'  {rule}: "{title}" ({key})' for rule, title, key in self.examples)
        return notes


class NoiseClassifier:
    """Judges readings by rule, and borderline ones with the model. `llm`
    None: cached replies and the rules only (a dry run, or no model
    configured). Thread-safe; share one per run."""

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
        self.gate = gate
        self.workers = max(1, workers)
        self.template = Template(PROMPT_PATH.read_text(encoding="utf-8"))
        self.stats = NoiseStats()
        self._lock = threading.Lock()

    def _count(self, name: str) -> None:
        with self._lock:
            setattr(self.stats, name, getattr(self.stats, name) + 1)

    def classify(self, record: EventObservation, text: EventText) -> Verdict:
        verdict = judge(text)
        if not verdict.borderline:
            return verdict
        self._count("borderline")
        if not self._may_read(record, text):
            self._count("undecided")
            return verdict
        reply = self._reply(text, verdict.borderline)
        if reply is None:
            self._count("undecided")
            return verdict
        answer, model = reply
        match = check_quote(answer.evidence_quote, text.text())
        verified = match is not EvidenceMatch.ABSENT
        if answer.kind == "notice" and not verified:
            self._count("unverified")
            return verdict
        if answer.kind == "external" and not verified:
            self._count("unverified")
        links = text.links()
        chosen = answer.external_link if answer.kind == "external" else None
        url = links[chosen - 1] if chosen is not None and 1 <= chosen <= len(links) else None
        return Verdict(
            answer.kind,
            "model",
            answer.evidence_quote.strip() or None,
            external_url=url,
            borderline=verdict.borderline,
            model=model,
            quote_check=match.value,
        )

    def _may_read(self, record: EventObservation, text: EventText) -> bool:
        if record.source_type in NO_LLM_SOURCE_TYPES or _relays_talks_cam(text):
            return False
        try:
            assert_llm_source_allowed(record.source_url)
        except NoLLMHost:
            return False
        return self.gate is None or self.gate.allows(record.source_url, record.source_type)

    def _reply(self, text: EventText, signals: Sequence[str]) -> tuple[NoiseReply, str] | None:
        entry = render_entry(text, signals)
        key = memo_key(PROMPT_NAME, entry)
        if self.memo is not None:
            cached = self.memo.get(PROMPT_NAME, key, NoiseReply)
            if cached is not None:
                self._count("model_cached")
                return cached
        if self.llm is None:
            return None
        try:
            call = self.llm.complete_json(
                schema=NoiseReply,
                messages=[{"role": "user", "content": self.template.safe_substitute(entry=entry)}],
                prompt_version=PROMPT_NAME,
            )
        except Exception as error:  # validation or transport: the rules stand
            self._count("model_failed")
            logger.warning("calendar-noise LLM call failed (%s)", type(error).__name__)
            return None
        self._count("model_calls")
        if self.memo is not None:
            self.memo.put(PROMPT_NAME, key, call.value, call.model)
        return call.value, call.model

    def classify_many(self, items: Sequence[tuple[EventObservation, EventText]]) -> list[Verdict]:
        if not items:
            return []
        with ThreadPoolExecutor(max_workers=min(self.workers, len(items))) as pool:
            return list(pool.map(lambda item: self.classify(*item), items))


# --- verdicts as claims ---------------------------------------------------------------------


def verdict_fields(record: EventObservation, verdict: Verdict) -> list[FieldObs]:
    """The `hosting` (and, for an external event, `externalUrl`) observations
    a kept reading carries (module docstring)."""
    evidence = evidence_of(record.fields)
    hosting = "takes_part" if verdict.kind == "external" else "hosts"
    quote = (verdict.evidence or "")[:500] or None
    if verdict.model is not None:
        extractor = verdict.model
        method = "llm"
        observed = FieldObs(
            field="hosting",
            value=hosting,
            method="llm",
            evidence=evidence,
            extractor=extractor,
            prompt_version=PROMPT_NAME,
            evidence_quote=quote,
            quote_check=verdict.quote_check,
            status=None if verdict.quote_check in ("exact", "normalised") else "inferred",
        )
    else:
        extractor = f"{EXTRACTOR}.{verdict.rule}"
        method = "parser"
        observed = parser_field(
            "hosting", hosting, extractor=extractor, evidence=evidence, inferred=True
        ).model_copy(update={"evidence_quote": quote})
    fields = [observed]
    if verdict.kind != "external":
        return fields
    if verdict.external_url:
        url = FieldObs(
            field="externalUrl",
            value=verdict.external_url,
            method=method,
            evidence=evidence,
            extractor=extractor,
            prompt_version=PROMPT_NAME if method == "llm" else None,
            evidence_quote=verdict.external_url if method == "llm" else None,
            quote_check="exact" if method == "llm" else None,
            status="inferred" if method == "parser" else None,
        )
        fields.append(url)
    else:
        absent = missing_field(
            "externalUrl", "not_found", extractor=extractor, evidence=evidence, method=method
        )
        if method == "llm":
            absent = absent.model_copy(update={"prompt_version": PROMPT_NAME})
        fields.append(absent)
    return fields


def retraction(record: EventObservation, verdict: Verdict) -> EventObservation:
    """A notice's reading of an event another listing keeps (module
    docstring): every field it gave restated ``missing`` / ``not_found`` from
    the same listing and method, so the server supersedes its earlier values;
    no venue, so no venue claim is derived from it."""
    fields: list[FieldObs] = []
    seen: set[tuple[str, str]] = set()
    for obs in record.fields:
        if (obs.field, obs.method) in seen:
            continue
        seen.add((obs.field, obs.method))
        absent = missing_field(
            obs.field,
            "not_found",
            extractor=f"{EXTRACTOR}.{verdict.rule}",
            evidence=obs.evidence,
            method=obs.method,
        )
        if obs.method == "llm":
            absent = absent.model_copy(update={"prompt_version": obs.prompt_version})
        fields.append(absent)
    return record.model_copy(update={"fields": fields, "venue": None})


def sift_events(
    records: Sequence[Observation | EventObservation], classifier: NoiseClassifier
) -> list[Observation | EventObservation]:
    """`records` without the notices among their keyed event readings, and
    with every other keyed reading's `hosting` verdict added (module
    docstring). What it did is in `classifier.stats`."""
    context = NoiseContext.from_records(records)
    pending: list[tuple[int, EventObservation, EventText]] = []
    for index, record in enumerate(records):
        if isinstance(record, EventObservation) and record.is_keyed:
            if any(obs.field == "hosting" for obs in record.fields):
                continue  # the source states it itself
            pending.append((index, record, context.text_of(record)))
    verdicts = classifier.classify_many([(record, text) for _, record, text in pending])
    stats = classifier.stats
    stats.readings += len(pending)
    replaced: dict[int, EventObservation | None] = {}
    shown: Counter = Counter()
    kept_keys = {
        event_key(record.event_source, record.external_id)
        for (_index, record, _text), verdict in zip(pending, verdicts, strict=True)
        if verdict.kind != "notice"
    }
    for (index, record, text), verdict in zip(pending, verdicts, strict=True):
        if verdict.kind == "notice":
            key = event_key(record.event_source, record.external_id)
            if key in kept_keys:
                replaced[index] = retraction(record, verdict)
                stats.retracted += 1
            else:
                replaced[index] = None
            stats.dropped[verdict.rule] += 1
            stats.dropped_keys.append(key)
            if shown[verdict.rule] < EXAMPLES_PER_RULE:
                shown[verdict.rule] += 1
                stats.examples.append((verdict.rule, _example(text.title), key))
            continue
        if verdict.kind == "external":
            stats.external[verdict.rule] += 1
        replaced[index] = record.model_copy(
            update={"fields": [*record.fields, *verdict_fields(record, verdict)]}
        )
    out: list[Observation | EventObservation] = []
    for index, record in enumerate(records):
        if index not in replaced:
            out.append(record)
        elif (kept := replaced[index]) is not None:
            out.append(kept)
    return out


def classifier_for(settings: Settings, *, dry_run: bool) -> tuple[NoiseClassifier, str | None]:
    """The run's classifier: the bulk model with the reply cache, or cached
    replies and the rules only in a dry run or without a configured model.
    Returns it with a note for the stage report when no model is used."""
    memo = LLMMemo(settings.cache_dir / "llm")
    if dry_run:
        return NoiseClassifier(None, memo), "calendar noise: dry run, cached replies and the rules"
    try:
        llm = LLMClient(settings.require_llm())
    except ConfigError as error:
        return NoiseClassifier(None, memo), f"calendar noise: no LLM ({error}), the rules only"
    note = None
    try:
        client: PoliteClient | None = PoliteClient(
            user_agent=settings.require_user_agent(),
            cache_dir=settings.cache_dir,
            min_interval=settings.min_host_interval,
        )
    except ConfigError as error:
        # As the redaction does: without a client no general source's AI
        # opt-outs can be checked, so only society content and mail reach the
        # model (`AiGate` refuses the rest).
        client = None
        note = f"calendar noise: AI opt-outs cannot be checked ({error}); general sources by rule"
    gate = AiGate(client)
    return NoiseClassifier(llm, memo, workers=settings.llm_concurrency, gate=gate), note


__all__ = [
    "EXTRACTOR",
    "PROMPT_NAME",
    "NoiseClassifier",
    "NoiseReply",
    "NoiseStats",
    "classifier_for",
    "render_entry",
    "sift_events",
    "verdict_fields",
]
