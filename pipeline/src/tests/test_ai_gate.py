"""AI opt-outs of general sources hold when their staged text is read again
(`extract/ai_gate.py`): by the D1 redaction at load and by classify."""

from __future__ import annotations

from pathlib import Path

import respx

from camsocs_pipeline.claims import build_claim, parser_field
from camsocs_pipeline.extract.ai_gate import AiGate
from camsocs_pipeline.extract.redact import Redactor, redact_claims
from camsocs_pipeline.sources.base import HostGates, PoliteClient
from tests.fakes import FakeLLM
from tests.test_redact import AT, ORG, reply

SPORT = "https://www.sport.example/clubs/quokka"
SOCIETY = "https://cuquokka.example/"


def polite(tmp_path: Path) -> PoliteClient:
    return PoliteClient(
        user_agent="camsocs-test/0.1",
        cache_dir=tmp_path / "cache",
        min_interval=0,
        gates=HostGates(),
        sleep=lambda _s: None,
    )


def test_general_sources_that_keep_ai_out_are_refused(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    net.get("https://www.sport.example/robots.txt").respond(
        200, text="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    )
    net.get("https://cuquokka.example/robots.txt").respond(
        200, text="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    )
    net.get("https://open.example/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
    gate = AiGate(polite(tmp_path))
    assert gate.verdict(SPORT, "sport_club_page") == "refused"
    # A society's own site: D3 overrides its opt-out.
    assert gate.verdict(SOCIETY, "society_website") == "allowed"
    assert gate.verdict("https://open.example/x", "su_profile") == "allowed"
    # Never talks.cam; mail and operator decisions are the pipeline's own.
    assert gate.verdict("https://talks.cam.ac.uk/talk/index/1", "talks_list") == "refused"
    assert gate.verdict("inbound:<m1@example>", "mailing_list_email") == "allowed"
    # No client (nothing can be checked): refused.
    assert AiGate(None).verdict("https://open.example/x", "su_profile") == "refused"


def test_the_redaction_keeps_a_refused_sources_text_from_the_model(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    net.get("https://www.sport.example/robots.txt").respond(
        200, text="User-agent: *\nAllow: /\nContent-Signal: ai-input=no\n"
    )
    llm = FakeLLM(lambda _t, _tier: reply("unused"))
    text = "Contact our Captain, Sam Example, about trials."
    claim = build_claim(
        parser_field("description", text, extractor="sport.description", evidence="primary"),
        entity_type="organisation",
        entity_key=ORG,
        source_url=SPORT,
        source_type="sport_club_page",
        retrieved_at=AT,
    )
    redactor = Redactor(llm, gate=AiGate(polite(tmp_path)))  # type: ignore[arg-type]
    (posted,), _ = redact_claims([claim], redactor)
    assert llm.calls == []
    assert posted.value == "Contact our Captain about trials."
