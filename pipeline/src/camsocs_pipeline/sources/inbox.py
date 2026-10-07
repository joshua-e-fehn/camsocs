"""Forwarded society list mail (source-research §16): who sent it.

Mail reaches `inboundEmails` through the inbound webhook (Joshua's Outlook rule
redirects list mail to it). Before any LLM call, `identify_sender` works out
which known organisation sent a mail from deterministic signals, strongest
first:

1. the organisation the server already recorded (`orgKey` on the row);
2. the `List-Id` (`soc-cugs.lists.cam.ac.uk`) against the Sympa lists on
   record, then its society component (`soc-cugs-news` → `soc-cugs`);
3. the sender's exact address, then its own domain (never a shared one:
   webmail, cam.ac.uk, the SU, SRCF);
4. the sender's display name (`"CU German Society" <…>`) and the list's
   name phrase against known names and aliases.

The same signals are read from an inline-forwarded header block ("From: … /
Subject: …" under "Forwarded message"), for mail forwarded rather than
redirected. A sign-off the LLM reads ("— The CUGS Committee") is the last
resort, applied by the stage once the quote is verified.

`is_list_mail` keeps the inbox to list mail: anything without a list
signal and not from a known organisation is skipped before the LLM sees it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from email.utils import getaddresses

from camsocs_pipeline.known_orgs import KnownOrgs, sympa_list_name
from camsocs_pipeline.models.wire import PendingMail

_FORWARD_MARKERS = re.compile(
    r"(?im)^\s*(?:-{2,}\s*(?:forwarded message|original message)\s*-{2,}|begin forwarded message:)"
)
_HEADER_LINE = re.compile(r"(?im)^\s*(from|sent|date|subject|to|list-id)\s*:\s*(.+)$")


@dataclass(frozen=True)
class Sender:
    display_name: str | None
    address: str | None


def parse_sender(header: str | None) -> Sender:
    """`"CU German Society" <x@y.org>` → display name and lower-cased address."""
    if not header:
        return Sender(None, None)
    pairs = getaddresses([header])
    if not pairs:
        return Sender(None, None)
    name, address = pairs[0]
    return Sender(name.strip() or None, address.strip().lower() if "@" in address else None)


@dataclass(frozen=True)
class ForwardedHeaders:
    sender: Sender
    subject: str | None
    list_name: str | None


def forwarded_headers(text: str) -> ForwardedHeaders | None:
    """The header block of an inline-forwarded mail, if the text has one."""
    marker = _FORWARD_MARKERS.search(text)
    if not marker:
        return None
    block = text[marker.end() : marker.end() + 2_000]
    headers: dict[str, str] = {}
    for match in _HEADER_LINE.finditer(block):
        headers.setdefault(match.group(1).lower(), match.group(2).strip())
    if "from" not in headers:
        return None
    sender = parse_sender(headers["from"])
    list_name = None
    for value in (headers.get("list-id"), headers.get("to"), sender.address):
        if value:
            list_name = sympa_list_name(value.strip("<> ")) or list_name
    return ForwardedHeaders(sender, headers.get("subject"), list_name)


def list_name_of(mail: PendingMail) -> str | None:
    """The Sympa list name of a mail (`soc-cugs`), when it came through
    lists.cam.ac.uk."""
    if mail.list_id:
        found = sympa_list_name(mail.list_id)
        if found:
            return found
    sender = parse_sender(mail.from_)
    if sender.address:
        found = sympa_list_name(sender.address)
        if found:
            return found
    forwarded = forwarded_headers(mail.text)
    return forwarded.list_name if forwarded else None


def is_list_mail(mail: PendingMail) -> bool:
    """Any list signal: a `List-Id`, or a lists.cam.ac.uk sender (direct or in
    an inline-forwarded block)."""
    return bool(mail.list_id) or list_name_of(mail) is not None


@dataclass(frozen=True)
class Identified:
    org_key: str | None
    #: Which signal decided it (for the extraction note), or why none did.
    how: str


def identify_sender(mail: PendingMail, known: KnownOrgs) -> Identified:
    """The organisation a mail is from, by deterministic signals only."""
    if mail.org_key:
        return Identified(mail.org_key, "recorded on the mail")
    list_name = list_name_of(mail)
    for candidate in (mail.list_id, list_name):
        found = known.by_list(candidate)
        if found:
            return Identified(found, f"list {list_name or candidate}")

    senders = [parse_sender(mail.from_)]
    forwarded = forwarded_headers(mail.text)
    if forwarded:
        senders.append(forwarded.sender)
    for sender in senders:
        found = known.by_address(sender.address)
        if found:
            return Identified(found, "sender address")
    for sender in senders:
        found = known.by_domain(sender.address)
        if found:
            return Identified(found, "sender domain")
    for name in [s.display_name for s in senders] + [mail.list_name]:
        found = known.by_name(name)
        if found:
            return Identified(found, "sender or list name")
    return Identified(None, f"no known organisation for list {list_name or mail.list_id or '-'}")


__all__ = [
    "ForwardedHeaders",
    "Identified",
    "Sender",
    "forwarded_headers",
    "identify_sender",
    "is_list_mail",
    "list_name_of",
    "parse_sender",
]
