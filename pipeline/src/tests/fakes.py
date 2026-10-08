"""Test doubles and synthetic fixtures for the LLM stages (inbox, instagram,
termcards). Every society, address and person here is fictional; domains are
`example.org` (reserved for documentation)."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.extract.llm import LLMCall, LLMValidationError
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.models.wire import PendingMail

Reply = dict[str, Any] | Exception


class FakeLLM:
    """Stands in for `LLMClient`: answers by looking at the user message.

    `respond(user_text, tier)` returns a reply dict (validated against the
    requested schema), or an exception to raise."""

    def __init__(self, respond: Callable[[str, str], Reply]) -> None:
        self.respond = respond
        self.calls: list[dict[str, Any]] = []

    def model_for(self, tier: str) -> str:
        return {"bulk": "bulk-model-1", "strong": "strong-model-1"}[tier]

    def complete_json[T: BaseModel](
        self,
        *,
        schema: type[T],
        messages: list[dict[str, Any]],
        prompt_version: str,
        tier: str = "bulk",
        temperature: float = 0.0,
    ) -> LLMCall[T]:
        user = messages[-1]["content"]
        text = user if isinstance(user, str) else user[0]["text"]
        images = 0 if isinstance(user, str) else len(user) - 1
        self.calls.append({"text": text, "tier": tier, "version": prompt_version, "images": images})
        reply = self.respond(text, tier)
        if isinstance(reply, Exception):
            raise reply
        return LLMCall(
            schema.model_validate(reply),
            self.model_for(tier),
            prompt_version,
            False,
            json.dumps(reply),
        )


def invalid_reply() -> LLMValidationError:
    return LLMValidationError("reply did not validate after one corrective retry")


def org_observation(
    key: str,
    name: str,
    *,
    sympa_list: str | None = None,
    email: str | None = None,
    website: str | None = None,
    instagram: str | None = None,
    termcard: str | None = None,
    aliases: tuple[str, ...] = (),
    short_name: str | None = None,
) -> Observation:
    """A keyed organisation observation, as the resolver would stage it."""
    fields = [parser_field("name", name, extractor="test", evidence="primary")]
    if email:
        fields.append(parser_field("email", email, extractor="test", evidence="primary"))
    if website:
        fields.append(parser_field("website", website, extractor="test", evidence="primary"))
    if short_name:
        fields.append(parser_field("shortName", short_name, extractor="test", evidence="primary"))
    if instagram:
        fields.append(
            parser_field(
                "socials",
                [{"platform": "instagram", "url": f"https://www.instagram.com/{instagram}/"}],
                extractor="test",
                evidence="primary",
            )
        )
    if termcard:
        fields.append(parser_field("termcardUrl", termcard, extractor="test", evidence="primary"))
    return Observation(
        source_type="su_profile",
        source_key=key,
        source_url=f"https://su.example.org/organisation/{key}/",
        retrieved_at=datetime(2026, 10, 1, 9, 0, tzinfo=UTC),
        entity_type="organisation",
        identity=IdentityHints(name=name, aliases=list(aliases), known_key=key),
        entity_key=key,
        fields=fields,
        internal={"sympa_list": sympa_list} if sympa_list else {},
    )


QUOKKA_KEY = "org-cambridge-university-quokka-appreciation-society"
ORRERY_KEY = "org-cambridge-university-orrery-club"


def known_orgs_records() -> list[Observation]:
    return [
        org_observation(
            QUOKKA_KEY,
            "Cambridge University Quokka Appreciation Society",
            sympa_list="soc-cuqas",
            email="committee@cuqas.example.org",
            website="https://cuqas.example.org/",
            instagram="cuqas_example",
            short_name="CUQAS",
        ),
        org_observation(
            ORRERY_KEY,
            "Cambridge University Orrery Club",
            sympa_list="soc-orrery",
            aliases=("CU Orrery Club",),
            termcard="https://orrery.example.org/termcard",
        ),
    ]


def _ms(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=UTC).timestamp() * 1000)


# --- synthetic list mail ---------------------------------------------------------------

WEEKLY_TEXT = """Hi everyone,

Welcome to Week 2! Here's what's coming up:

PUB QUIZ – Wednesday of Week 3, 7:30pm, The Mill (upstairs)
Teams of up to 6. £3 members / £5 non-members. Sign up: https://cuqas.example.org/quiz
Prizes for the best quokka pun.

TALK: "Marsupials of Western Australia" – Friday 23rd October, 6pm–7:30pm
Dr Ada Example (Department of Zoology) tells us everything about Rottnest Island.
Babbage Lecture Theatre, New Museums Site. Free, no booking needed.

Punting social – Sunday Week 3, meet at Mill Pond at 2pm. This one is members only, sorry!

Last week's welcome drinks were great – thanks to everyone who came!

Questions? Email our secretary at secretary@cuqas.example.org or call 07700 900123.

Best wishes,
The CUQAS Committee
Cambridge University Quokka Appreciation Society

--
You are subscribed to soc-cuqas@lists.cam.ac.uk as jq999@cam.ac.uk.
"""

WEEKLY = PendingMail(
    message_id="<weekly-2@lists.cam.ac.uk>",
    received_at=_ms(2026, 10, 19, 8, 12),  # Mon 19 Oct 2026, 09:12 BST
    **{"from": '"CUQAS" <jq999@cam.ac.uk>'},
    list_id="soc-cuqas.lists.cam.ac.uk",
    list_name="CUQAS announcements",
    subject="CUQAS This Week: Pub Quiz, Marsupials Talk & Punting!",
    text=WEEKLY_TEXT,
    # Exchange's ARC verdict passed DKIM for the sender (server-side check).
    sender_verified=True,
)

WEEKLY_REPLY: dict[str, Any] = {
    "society_name": "Cambridge University Quokka Appreciation Society",
    "society_name_quote": "Cambridge University Quokka Appreciation Society",
    "events": [
        {
            "title": "Pub Quiz",
            "title_quote": "PUB QUIZ",
            "description": "Teams of up to 6.",
            "term_week": 3,
            "weekday": "wednesday",
            "start_time": "19:30",
            "when_quote": "Wednesday of Week 3, 7:30pm",
            "venue": "The Mill (upstairs)",
            "venue_quote": "The Mill (upstairs)",
            "event_type": "social",
            "price_text": "£3 members / £5 non-members",
            "free": False,
            "min_price_pence": 300,
            "max_price_pence": 500,
            "booking_url": "https://cuqas.example.org/quiz",
        },
        {
            "title": "Marsupials of Western Australia",
            "title_quote": "Marsupials of Western Australia",
            "date": "2026-10-23",
            "start_time": "18:00",
            "end_time": "19:30",
            "when_quote": "Friday 23rd October, 6pm–7:30pm",
            "venue": "Babbage Lecture Theatre, New Museums Site",
            "event_type": "talk",
            "free": True,
            "price_text": "Free, no booking needed",
            # Not in the mail: must be dropped.
            "booking_url": "https://cuqas.example.org/talk-tickets",
            "speakers": [{"name": "Dr Ada Example", "affiliation": "Department of Zoology"}],
            "speakers_quote": "Dr Ada Example (Department of Zoology)",
        },
        {
            "title": "Punting social",
            "term_week": 3,
            "weekday": "sunday",
            "start_time": "14:00",
            "when_quote": "Sunday Week 3, meet at Mill Pond at 2pm",
            "venue": "Mill Pond",
            "event_type": "social",
            "members_only": True,
            "members_only_quote": "members only",
        },
    ],
}

FORWARDED_TEXT = """FYI

---------- Forwarded message ---------
From: Cambridge University Orrery Club <soc-orrery-announce@lists.cam.ac.uk>
Date: Tue, 6 Oct 2026 at 10:00
Subject: Orrery Club: Michaelmas termcard
To: <soc-orrery-announce@lists.cam.ac.uk>

Dear all, our Michaelmas 2026 programme:
Week 1 Thursday 8pm – Freshers' Stargazing, Observatory lawn
Week 4 Tuesday 7pm – Building a Tellurion workshop, Old Cavendish
Clear skies!
CUOC
"""

FORWARDED = PendingMail(
    message_id="<fwd-orrery@example.org>",
    received_at=_ms(2026, 10, 7, 9, 0),  # Wed 7 Oct 2026
    **{"from": "J Q <jq999@cam.ac.uk>"},
    subject="Fwd: Orrery Club: Michaelmas termcard",
    text=FORWARDED_TEXT,
    sender_verified=True,
)

FORWARDED_REPLY: dict[str, Any] = {
    "term": "michaelmas",
    "term_year": 2026,
    "events": [
        {
            "title": "Freshers' Stargazing",
            "term_week": 1,
            "weekday": "thursday",
            "start_time": "20:00",
            "when_quote": "Week 1 Thursday 8pm",
            "venue": "Observatory lawn",
            "event_type": "social",
        },
        {
            "title": "Building a Tellurion workshop",
            "term_week": 4,
            "weekday": "tuesday",
            "start_time": "19:00",
            "when_quote": "Week 4 Tuesday 7pm",
            "venue": "Old Cavendish",
            "event_type": "workshop",
        },
    ],
}

NOT_LIST = PendingMail(
    message_id="<hello@example.com>",
    received_at=_ms(2026, 10, 7, 9, 0),
    **{"from": "Someone <someone@example.com>"},
    subject="Hello",
    text="Are you free for coffee on Thursday?",
)

WELCOME = PendingMail(
    message_id="<welcome@lists.cam.ac.uk>",
    received_at=_ms(2026, 10, 7, 9, 0),
    **{"from": "sympa@lists.cam.ac.uk"},
    list_id="soc-cuqas.lists.cam.ac.uk",
    subject="Welcome to list soc-cuqas",
    text="Welcome to list soc-cuqas. To unsubscribe, send a message to sympa.",
    sender_verified=True,
)

EXPECTED_WEEKLY_STARTS = {
    # Wed 28 Oct 2026 19:30 GMT (clocks went back on Sun 25 Oct).
    "Pub Quiz": _ms(2026, 10, 28, 19, 30),
    # Fri 23 Oct 2026 18:00 BST.
    "Marsupials of Western Australia": _ms(2026, 10, 23, 17, 0),
    # Sun 25 Oct 2026 14:00 GMT.
    "Punting social": _ms(2026, 10, 25, 14, 0),
}


def make_pdf(lines: list[str]) -> bytes:
    """A one-page PDF whose text layer holds `lines` (Latin-1 only)."""

    def escape(text: str) -> str:
        return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    content = (
        "BT /F1 14 Tf 50 750 Td 18 TL "
        + " ".join(f"({escape(line)}) Tj T*" for line in lines)
        + " ET"
    )
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{offset:010d} 00000 n \n" for offset in offsets).encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ).encode()
    return out


TERMCARD_LINES = [
    "CU Orrery Club - Michaelmas 2026",
    "Week 2 Wednesday 7pm: Planetarium trip",
    "Week 5 Friday 8pm: Orrery building (members only)",
]

TERMCARD_REPLY: dict[str, Any] = {
    "society_name": "CU Orrery Club",
    "term": "michaelmas",
    "term_year": 2026,
    "events": [
        {
            "title": "Planetarium trip",
            "term_week": 2,
            "weekday": "wednesday",
            "start_time": "19:00",
            "when_quote": "Week 2 Wednesday 7pm",
            "event_type": "trip",
        },
        {
            "title": "Orrery building",
            "term_week": 5,
            "weekday": "friday",
            "start_time": "20:00",
            "when_quote": "Week 5 Friday 8pm",
            "event_type": "workshop",
            "members_only": True,
            "members_only_quote": "members only",
        },
    ],
}
