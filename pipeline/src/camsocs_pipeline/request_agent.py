"""The request agent (ENG-126): drafts what to apply for each open listing
request, for the broker to confirm.

Every minute (systemd `camsocs-request-agent.timer`, `camsocs request-drafts`)
the agent asks Convex for the open claims, corrections, removals and
objections that still need a draft (`POST /api/pipeline/requests/pending`),
asks the strong model for each through cliproxy (`extract/llm.py`, Codex
models only), and posts the reply, or the failure's error class, back
(`POST /api/pipeline/requests/draft`). The broker sees the draft on the
dashboard, where it pre-fills the accept dialog, and confirms; Convex runs
the acceptance. The agent applies nothing and has no tool to.

What the model sees and what is checked is Convex's
(`webapp/convex/lib/requestDraft.ts`): addresses and phone numbers arrive
masked (`[sender]`, `[email 1]`, `[phone]`), the reply's values are typed
and checked there, and a link or address the request does not give is
dropped. This module only renders the prompt, validates the reply's shape
and reports counts: it never logs a request's text, a reply or a key.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from camsocs_pipeline.extract.llm import LLMClient

logger = logging.getLogger(__name__)

PROMPT_NAME = "request_draft_v1"
PROMPT_PATH = Path(__file__).parent / "extract" / "prompts" / f"{PROMPT_NAME}.md"

#: What a request is, in the prompt's words.
KIND_LABELS = {
    "claim": "a claim: the sender says they run this society and wants to manage its listing",
    "correct": "a correction to the listing",
    "remove": "a request to remove the listing or part of it",
    "object": "an objection to the listing (to the processing of someone's data)",
}

#: Longest strings and lists kept from a reply (Convex cuts again).
MAX_TEXT = 4_000


class Correction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    field: str = Field(max_length=80)
    value: str = Field(max_length=MAX_TEXT)
    reason: str = Field(default="", max_length=400)


class Removal(BaseModel):
    model_config = ConfigDict(extra="ignore")

    scope: Literal["organisation", "field", "contact", "name", "event"]
    fields: list[str] = Field(default_factory=list, max_length=40)
    address: str | None = None
    name: str | None = Field(default=None, max_length=120)
    event_keys: list[str] = Field(default_factory=list, max_length=20)


class DraftReply(BaseModel):
    model_config = ConfigDict(extra="ignore")

    summary: str = Field(max_length=MAX_TEXT)
    action: Literal["corrections", "removal", "none"]
    corrections: list[Correction] = Field(default_factory=list, max_length=40)
    removal: Removal | None = None
    concerns: list[str] = Field(default_factory=list, max_length=10)
    reply: str = Field(default="", max_length=MAX_TEXT)

    def payload(self) -> dict[str, Any]:
        """The reply as `requests/draft` takes it (camelCase, no nulls)."""
        removal: dict[str, Any] | None = None
        if self.removal is not None:
            removal = {"scope": self.removal.scope}
            if self.removal.fields:
                removal["fields"] = self.removal.fields
            if self.removal.address:
                removal["address"] = self.removal.address
            if self.removal.name:
                removal["name"] = self.removal.name
            if self.removal.event_keys:
                removal["eventKeys"] = self.removal.event_keys
        return {
            "summary": self.summary,
            "action": self.action,
            "corrections": [
                {"field": c.field, "value": c.value, **({"reason": c.reason} if c.reason else {})}
                for c in self.corrections
            ],
            "removal": removal,
            "concerns": [concern[:400] for concern in self.concerns],
            "reply": self.reply,
        }


class Poster(Protocol):
    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]: ...


def render_guide(guide: list[dict[str, str]]) -> str:
    return "\n".join(f"- `{g['field']}` ({g['label']}): {g['format']}" for g in guide)


def render_request(item: dict[str, Any], scopes: list[str]) -> str:
    """One request as the prompt shows it. Everything in it is already masked
    by Convex."""
    checks = item.get("checks") or {}
    sender = [
        f"- Domain: {item.get('fromDomain') or 'unknown'}",
        f"- A University address (cam.ac.uk): {'yes' if checks.get('cam') else 'no'}",
        "- An address this listing publishes: " + ("yes" if checks.get("listed") else "no"),
        "- On the domain of the listing's website: "
        + ("yes" if checks.get("siteDomain") else "no"),
        f"- Role they give: {item.get('role') or 'none'}",
    ]
    listing = item.get("listing")
    if listing:
        current = listing.get("current") or {}
        shown = "\n".join(f"- `{field}`: {value}" for field, value in current.items()) or "- none"
        listing_text = f"Name: {listing['name']}\nCurrent values:\n{shown}"
    else:
        listing_text = "The request names no listing."
    fields = item.get("fields") or {}
    proposed = "\n".join(f"- `{name}`: {value}" for name, value in fields.items()) or "- none"
    parts = [
        f"Kind: {KIND_LABELS.get(item['kind'], item['kind'])}",
        f"Removal scopes: {', '.join(scopes)}",
        f"Address tokens in this request: {', '.join(item.get('tokens') or []) or 'none'}",
        "",
        "## Sender",
        *sender,
        "",
        "## Listing",
        listing_text,
    ]
    if item.get("eventKey"):
        parts += ["", f"The request was sent from the page of event {item['eventKey']}."]
    parts += [
        "",
        "## Values proposed in the form",
        proposed,
        "",
        "## Message (as sent)",
        "<<<",
        item.get("message") or "",
        ">>>",
    ]
    return "\n".join(parts)


@dataclass
class DraftCounts:
    offered: int = 0
    drafted: int = 0
    failed: int = 0

    def line(self) -> str:
        return f"{self.offered} offered, {self.drafted} drafted, {self.failed} failed"


def run_drafts(loader: Poster, llm: LLMClient) -> DraftCounts:
    """One round: fetch the requests that need a draft, draft each, post the
    outcomes. A failed model call is reported as failed (Convex retries it
    later); a failed post raises."""
    template = Template(PROMPT_PATH.read_text(encoding="utf-8"))
    work = loader.post("requests/pending", {})
    items = work.get("items") or []
    guide = render_guide(work.get("fieldGuide") or [])
    scopes = list(work.get("removalScopes") or [])
    counts = DraftCounts(offered=len(items))
    for item in items:
        prompt = template.safe_substitute(guide=guide, request=render_request(item, scopes))
        try:
            call = llm.complete_json(
                schema=DraftReply,
                messages=[{"role": "user", "content": prompt}],
                prompt_version=PROMPT_NAME,
                tier="strong",
            )
        except Exception as error:  # validation or transport: tried again later
            counts.failed += 1
            logger.warning("request draft failed (%s)", type(error).__name__)
            loader.post(
                "requests/draft",
                {"key": item["key"], "ok": False, "error": type(error).__name__},
            )
            continue
        loader.post(
            "requests/draft",
            {
                "key": item["key"],
                "ok": True,
                "model": call.model,
                "promptVersion": PROMPT_NAME,
                "reply": call.value.payload(),
            },
        )
        counts.drafted += 1
    return counts
