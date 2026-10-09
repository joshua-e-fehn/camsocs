"""Mailing-list text cut down to what event extraction needs, before any of it
reaches the LLM (DPIA-lite R-4; source-research §16).

List mail carries much more than its events: who forwarded or replied to it,
the quoted earlier messages, personal signatures with names, roles and phone
numbers, and the list's own subscription footer. None of that helps find an
event, and all of it is personal data or noise. `clean_mail_text` removes it
deterministically — no model decides what is personal — in this order:

1. **Reply quotes**: an "On … wrote:" line or an "-----Original Message-----"
   marker, and everything after it; any line quoted with ``>``. An Outlook
   header block (``From:`` / ``Sent:`` / ``To:`` / ``Subject:``) under a
   reply's subject (``Re:``) counts as a reply quote too.
2. **Forwarded headers**: the "Forwarded message" / "Begin forwarded
   message:" marker and the header lines under it, and an Outlook header
   block that is not a reply's — the forwarded *body* stays, since that is
   usually the society's announcement.
3. **Signatures**: an RFC 3676 ``-- `` delimiter and what follows it (up to a
   forwarded message); "Sent from my iPhone" and the like; a sign-off block
   ("Best wishes," and the short lines under it) — except lines naming an
   organisation ("The CUGS Committee", "CU Quokka Society"), which say who the
   mail is from and name no one.
4. **List footers**: every paragraph with an unsubscribe / "you are receiving
   this" / preferences / copyright line, and everything after one that comes
   in the last part of the mail.
5. **Addresses and phone numbers** (`events.redact_contacts`) in what is left.

The quote check later runs against this cleaned text, so a value is `found`
only if its words survived the cleaning.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from camsocs_pipeline.extract.events import redact_contacts

_REPLY_INTRO = re.compile(r"^\s*On\b.{4,300}\bwrote:\s*$", re.IGNORECASE)
_ORIGINAL = re.compile(r"^\s*-{2,}\s*Original Message\s*-{2,}\s*$", re.IGNORECASE)
_FORWARD = re.compile(
    r"^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$", re.IGNORECASE
)
_HEADER = re.compile(
    r"^\s*\*?(From|Sent|Date|To|Cc|Bcc|Subject|Reply-To|List-Id)\s*:\*?\s*.*$", re.IGNORECASE
)
_RULE = re.compile(r"^\s*_{8,}\s*$")
_SIG_DELIMITER = re.compile(r"^-- ?$")
_DEVICE = re.compile(
    r"^\s*(?:Sent from (?:my )?\S.{0,40}|Get Outlook for \S.{0,30}|Sent via \S.{0,40})\s*$",
    re.IGNORECASE,
)
_VALEDICTION = re.compile(
    r"^\s*(?:(?:best|kind|warm|warmest|many)\s+(?:wishes|regards|thanks)|best|regards|"
    r"cheers|thanks(?: so much| again)?|thank you|all the best|yours(?: sincerely| faithfully)?|"
    r"sincerely|love|warmly|see you (?:there|soon)|speak soon|take care|"
    r"(?:viele|liebe|beste|herzliche) grüße|mit freundlichen grüßen|cordialement|bises|"
    r"saludos|un saludo|cordiali saluti|un saluto)\s*[,!.]*\s*$",
    re.IGNORECASE,
)
#: A sign-off line naming an organisation rather than a person.
_ORGANISATION = re.compile(
    r"\b(?:society|soc|club|committee|association|union|jcr|mcr|team|group|network|"
    r"collective|choir|orchestra|ensemble|company|players|council|board|exec)\b",
    re.IGNORECASE,
)
_FOOTER = re.compile(
    r"unsubscribe|you are receiving this|you received this (?:message|email|mail)|"
    r"to stop receiving|manage (?:your )?(?:subscription|preferences|email)|"
    r"update your preferences|this (?:e-?mail|message) was sent to|"
    r"sympa@lists\.cam\.ac\.uk|why did i get this|view this (?:e-?mail|message) in your browser|"
    r"our mailing address is|copyright \(c\)|copyright ©|all rights reserved",
    re.IGNORECASE,
)
_REPLY_SUBJECT = re.compile(r"^\s*(?:re|aw|sv)\s*:", re.IGNORECASE)
#: A line that reads like an event (a time, a day, a date): a sign-off block
#: never swallows one.
_EVENTISH = re.compile(
    r"\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|"
    r"\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b|"
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b\s+\d|\bweek\s+\d",
    re.IGNORECASE,
)

#: Sign-off blocks are short: the valediction plus a few lines.
_SIGNOFF_LINES = 6
_SIGNOFF_LINE_LENGTH = 80
#: A footer this far into the mail ends it.
_FOOTER_TAIL = 0.6


@dataclass(frozen=True)
class CleanMail:
    text: str
    #: What was cut, by kind (counts only — never the content).
    removed: Counter[str] = field(default_factory=Counter)

    def summary(self) -> str:
        """`"cleaned: 2 quoted lines, 1 signature"`, or "" when nothing was cut."""
        if not self.removed:
            return ""
        return "cleaned: " + ", ".join(f"{n} {kind}" for kind, n in sorted(self.removed.items()))


def clean_mail_text(text: str, *, subject: str | None = None) -> CleanMail:
    """`text` without quotes, forwarded headers, signatures, list footers,
    addresses and phone numbers (module docstring)."""
    removed: Counter[str] = Counter()
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = _cut_reply(lines, bool(subject and _REPLY_SUBJECT.match(subject)), removed)
    lines = _drop_forward_headers(lines, removed)
    lines = _drop_signatures(lines, removed)
    lines = _drop_footers(lines, removed)
    cleaned = redact_contacts("\n".join(lines))
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return CleanMail(cleaned, Counter({k: v for k, v in removed.items() if v}))


def _header_block_at(lines: list[str], start: int) -> int:
    """The end (exclusive) of a mail header block starting at `start`, or
    `start`. A block opens with ``From:`` and is either three header lines or
    more, or two whose ``From:`` names an address — so an event's "From: 7pm /
    To: 10pm" is not one."""
    if not re.match(r"^\s*\*?From\s*:", lines[start], re.IGNORECASE):
        return start
    end = start
    while end < len(lines) and _HEADER.match(lines[end]):
        end += 1
    size = end - start
    if size >= 3 or (size == 2 and "@" in lines[start]):
        return end
    return start


def _cut_reply(lines: list[str], is_reply: bool, removed: Counter[str]) -> list[str]:
    out: list[str] = []
    for index, line in enumerate(lines):
        joined = f"{line} {lines[index + 1]}" if index + 1 < len(lines) else line
        intro = _REPLY_INTRO.match(line) or (
            line.strip().lower().startswith("on ")
            and not line.rstrip().endswith(":")
            and _REPLY_INTRO.match(joined)
        )
        outlook_reply = is_reply and _header_block_at(lines, index) > index
        if intro or _ORIGINAL.match(line) or outlook_reply:
            removed["quoted reply"] += 1
            # Drop a separator rule just above, too.
            while out and _RULE.match(out[-1]):
                out.pop()
            return out
        if line.lstrip().startswith(">"):
            removed["quoted lines"] += 1
            continue
        out.append(line)
    return out


def _drop_forward_headers(lines: list[str], removed: Counter[str]) -> list[str]:
    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if _FORWARD.match(line):
            index += 1
            while index < len(lines) and _HEADER.match(lines[index]):
                index += 1
            removed["forwarded headers"] += 1
            continue
        end = _header_block_at(lines, index)
        if end > index:
            while out and _RULE.match(out[-1]):
                out.pop()
            removed["forwarded headers"] += 1
            index = end
            continue
        out.append(line)
        index += 1
    return out


def _drop_signatures(lines: list[str], removed: Counter[str]) -> list[str]:
    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if _SIG_DELIMITER.match(line):
            # To the next forwarded message (whose body follows), else the end.
            index += 1
            while index < len(lines) and not _FORWARD.match(lines[index]):
                index += 1
            removed["signature"] += 1
            continue
        if _DEVICE.match(line):
            removed["signature"] += 1
            index += 1
            continue
        if _VALEDICTION.match(line):
            removed["signature"] += 1
            index += 1
            taken = 0
            while (
                index < len(lines)
                and lines[index].strip()
                and taken < _SIGNOFF_LINES
                and len(lines[index]) <= _SIGNOFF_LINE_LENGTH
                and not _EVENTISH.search(lines[index])
            ):
                if _ORGANISATION.search(lines[index]):
                    out.append(lines[index])
                index += 1
                taken += 1
            continue
        out.append(line)
        index += 1
    return out


def _paragraphs(lines: list[str]) -> list[list[str]]:
    paragraphs: list[list[str]] = [[]]
    for line in lines:
        if line.strip():
            paragraphs[-1].append(line)
        elif paragraphs[-1]:
            paragraphs.append([])
    return [paragraph for paragraph in paragraphs if paragraph]


def _drop_footers(lines: list[str], removed: Counter[str]) -> list[str]:
    paragraphs = _paragraphs(lines)
    kept: list[list[str]] = []
    for index, paragraph in enumerate(paragraphs):
        if any(_FOOTER.search(line) for line in paragraph):
            removed["list footer"] += 1
            if index >= len(paragraphs) * _FOOTER_TAIL:
                removed["list footer"] += len(paragraphs) - index - 1
                break
            continue
        kept.append(paragraph)
    return [line for paragraph in kept for line in [*paragraph, ""]]


__all__ = ["CleanMail", "clean_mail_text"]
