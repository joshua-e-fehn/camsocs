"""Whether a source's text may reach the model when a later step reads it
again: the D1 redaction at load (`extract.redact`) and the `classify` stage
(source-research §14, decision D3).

The stages that fetch a page and hand it to the model straight away (website
enrichment, website events, termcards) check its AI opt-outs themselves. The
texts staged by the other harvesters — SU profiles, the Sport pages, the
Proctors' register, Camdram, college pages read with the general purpose —
reach the model only later, so they are checked here, by source:

- talks.cam (and tbc.xyz) never (`NO_LLM_SOURCE_TYPES`, `NoLLMHost`);
- a society's own content (a society website, its Linktree, a termcard, a
  Google Calendar feed it links; `policy.society_class`) may be read: D3
  overrides an AI opt-out there, and the stage that fetched it recorded the
  override on its `sources` row;
- anything else is general and honours every AI opt-out: an AI crawler
  disallowed by name or ``Content-Signal: ai-input=no`` in the host's
  robots.txt (`PoliteClient.ai_input_allowed`), or a ``noai`` /
  ``noimageai`` robots meta on the cached page itself. Such a text is
  ``refused``: the redaction then uses its deterministic rule, and classify
  leaves the text out of the prompt.

A text with no web source (``inbound:`` mail, ``manual:`` decisions) is the
pipeline's own to read. Verdicts are cached per URL for the run.
"""

from __future__ import annotations

import threading
from typing import Literal

from camsocs_pipeline.claims import NO_LLM_SOURCE_TYPES
from camsocs_pipeline.extract.llm import NoLLMHost, assert_llm_source_allowed
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.policy import (
    GENERAL,
    SOCIETY,
    SOCIETY_WEBSITE,
    FetchPurpose,
    ai_optout_override,
)
from camsocs_pipeline.sources.websites.page import robots_directives

Verdict = Literal["allowed", "refused"]

#: Source types a society publishes itself, read with its website's class.
_WEBSITE_TYPES = frozenset({"society_website", "linktree", "termcard"})
#: Feeds a society links (Google Calendar public ICS feeds are a D3 class).
_FEED_TYPES = frozenset({"ics_feed", "luma"})
_NOAI = frozenset({"noai", "noimageai"})


def purpose_for(source_type: str, url: str) -> FetchPurpose:
    """The purpose the source was fetched with, as far as its type says."""
    if source_type in _WEBSITE_TYPES:
        return SOCIETY_WEBSITE.bound_to(url)
    if source_type in _FEED_TYPES:
        return SOCIETY
    return GENERAL


class AiGate:
    """Per-source AI verdicts for one run (module docstring). Without a
    client (a dry run, no User-Agent) nothing can be checked and every web
    source is ``refused`` — callers then keep to their deterministic rule."""

    def __init__(self, client: PoliteClient | None) -> None:
        self.client = client
        self._verdicts: dict[tuple[str, FetchPurpose], Verdict] = {}
        self._lock = threading.Lock()

    def verdict(self, source_url: str, source_type: str) -> Verdict:
        if source_type in NO_LLM_SOURCE_TYPES:
            return "refused"
        try:
            assert_llm_source_allowed(source_url)
        except NoLLMHost:
            return "refused"
        if not source_url.startswith(("http://", "https://")):
            return "allowed"
        purpose = purpose_for(source_type, source_url)
        if ai_optout_override(source_url, purpose):
            return "allowed"  # D3: the fetching stage recorded any override
        key = (source_url, purpose)
        with self._lock:
            known = self._verdicts.get(key)
        if known is not None:
            return known
        found = self._check(source_url, purpose)
        with self._lock:
            self._verdicts[key] = found
        return found

    def allows(self, source_url: str, source_type: str) -> bool:
        return self.verdict(source_url, source_type) == "allowed"

    def _check(self, url: str, purpose: FetchPurpose) -> Verdict:
        if self.client is None:
            return "refused"
        try:
            if not self.client.ai_input_allowed(url, purpose):
                return "refused"
            cached = self.client.cached(url, purpose)
        except ValueError:
            return "refused"
        page_noai = (
            cached is not None
            and "html" in (cached.content_type or "html").lower()
            and bool(_NOAI & robots_directives(cached.text or ""))
        )
        return "refused" if page_noai else "allowed"


__all__ = ["AiGate", "Verdict", "purpose_for"]
