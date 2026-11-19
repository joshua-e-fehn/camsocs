"""Stage `college_finances` (source-research §22): the register's Part B
extract parsed, checked, corrected and posted. Every fixture is synthetic and
tiny; no real register row is copied here."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import UTC, datetime

import httpx
import pytest

from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.pipeline import load
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.sources import charity_register as cr
from camsocs_pipeline.sources.charity_register import (
    EXTRACT_URL,
    Citation,
    Override,
    PartBRow,
    RegisterFormatError,
    assess,
    load_charities,
    load_overrides,
    load_standing_reviews,
    parse_rows,
    read_extract,
)
from camsocs_pipeline.stages import college_finances
from camsocs_pipeline.staging.store import StagingStore

SITE = "https://happy-otter-123.convex.site"
WEALTH_JSON = REPO_ROOT / "webapp" / "lib" / "data" / "college-wealth.json"

#: The register's column order (a subset is enough: the parser reads by name).
HEADER = (
    "date_of_extract",
    "organisation_number",
    "registered_charity_number",
    "latest_fin_period_submitted_ind",
    "fin_period_order_number",
    "fin_period_end_date",
    "income_total_income_and_endowments",
    "assets_own_use",
    "assets_long_term_investment",
    "funds_total",
)

COLLEGES = {"1000001": "org-alpha-college", "1000002": "org-beta-college"}


def line(number: str, period_end: str, income: str, own: str, lti: str, funds: str) -> str:
    cells = (
        "2026-11-19 00:00:00.0000000",
        number,
        number,
        "False",
        "1",
        f"{period_end} 00:00:00.0000000",
        income,
        own,
        lti,
        funds,
    )
    return "\t".join(cells)


def extract_text(*lines: str) -> str:
    return "﻿" + "\t".join(HEADER) + "\r\n" + "\r\n".join(lines) + "\r\n"


def zipped(text: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("publicextract.charity_annual_return_partb.txt", text.encode("utf-8"))
    return buffer.getvalue()


M = 1_000_000


def row(period_end: str, lti: int | None, own: int | None = 50, funds: int | None = 200,
        income: int | None = 10, number: str = "1000001") -> PartBRow:  # fmt: skip
    """Figures in £m, except where a test passes pounds (above 10,000)."""

    def pounds(value: int | None) -> int | None:
        return value * M if value is not None and value < 10_000 else value

    return PartBRow(number, period_end, pounds(lti), pounds(own), pounds(funds), pounds(income))


CITATION = Citation(url="https://example.org/accounts.pdf", page="PDF p.1", reason="test")


# --- the colleges and the overrides ---------------------------------------------------


def test_the_charity_list_matches_the_wealth_dataset() -> None:
    wealth = json.loads(WEALTH_JSON.read_text(encoding="utf-8"))["colleges"]
    expected = {college["charityNumber"]: f"org-{college['slug']}" for college in wealth}
    assert load_charities() == expected
    assert len(expected) == 31


def test_every_override_names_a_college_period_and_its_accounts_page() -> None:
    colleges = load_charities()
    wealth = {
        college["charityNumber"]: college
        for college in json.loads(WEALTH_JSON.read_text(encoding="utf-8"))["colleges"]
    }
    overrides = load_overrides()
    assert overrides
    for (number, period_end), override in overrides.items():
        assert number in colleges
        assert period_end[4:] in ("-06-30", "-07-31")
        assert override.citation.url.startswith("https://")
        assert override.citation.page.startswith("PDF p.")
        assert override.citation.reason
        # A corrected value for the dataset's own year is the dataset's figure.
        if override.endowment_gbp is not None and period_end == wealth[number]["financialYearEnd"]:
            assert override.endowment_gbp == wealth[number]["endowmentGbp"]


def test_the_seeded_overrides_are_clare_newnham_and_hughes_hall() -> None:
    overrides = load_overrides()
    assert overrides[("1137531", "2025-06-30")].endowment_gbp == 203_897_000  # Clare
    assert overrides[("1137512", "2025-06-30")].endowment_gbp == 138_626_000  # Newnham
    hughes = overrides[("1137471", "2025-07-31")]
    assert not hughes.changes_values and hughes.review is None  # informational
    # Every correction or acceptance pins what the register said when read.
    for override in overrides.values():
        assert override.review or override.register_filed
    # Clare's register investments include its inflation swaps every year.
    assert set(load_standing_reviews()) == {"1137531"}


def test_an_unpinned_correction_is_refused(tmp_path) -> None:
    path = tmp_path / "overrides.json"
    entry = {
        "charityNumber": "1",
        "periodEnd": "2025-06-30",
        "endowmentGbp": 1,
        "citation": {"url": "https://x", "page": "PDF p.1", "reason": "r"},
    }
    path.write_text(json.dumps({"overrides": [entry]}))
    with pytest.raises(ValueError, match="registerFiled"):
        load_overrides(path)


# --- parsing --------------------------------------------------------------------------


def test_parses_the_colleges_rows_and_skips_the_rest() -> None:
    text = extract_text(
        line("1000001", "2025-06-30", "10000000", "40000000", "120000000", "180000000"),
        line("9999999", "2025-06-30", "1", "1", "1", "1"),
        line("1000002", "2025-07-31", "5000000.00", "", "60000000", "70000000"),
    )
    rows = read_extract(zipped(text), COLLEGES)
    assert rows == [
        PartBRow("1000001", "2025-06-30", 120_000_000, 40_000_000, 180_000_000, 10_000_000),
        PartBRow("1000002", "2025-07-31", 60_000_000, None, 70_000_000, 5_000_000),
    ]


def test_a_renamed_column_fails_loudly() -> None:
    text = extract_text().replace("funds_total", "funds_total_v2")
    with pytest.raises(RegisterFormatError, match="funds_total"):
        parse_rows(io.StringIO(text.lstrip("﻿")), COLLEGES)


def test_not_a_zip_fails_loudly() -> None:
    with pytest.raises(RegisterFormatError, match="zip"):
        read_extract(b"<Error>gone</Error>", COLLEGES)


def test_a_bad_amount_fails_loudly() -> None:
    text = extract_text(line("1000001", "2025-06-30", "ten", "1", "1", "1"))
    with pytest.raises(RegisterFormatError, match="amount"):
        read_extract(zipped(text), COLLEGES)


# --- checks ---------------------------------------------------------------------------


def statuses(assessed: list[cr.Assessed]) -> list[tuple[str, str, list[str]]]:
    return [(a.period_end, a.status, a.checks) for a in assessed]


def test_a_steady_series_is_accepted_as_filed() -> None:
    rows = [row("2023-06-30", 100), row("2024-06-30", 110), row("2025-06-30", 105)]
    assert [a.status for a in assess(rows, COLLEGES, {})] == ["register"] * 3


def test_a_return_in_thousands_is_held_back_and_the_next_compares_with_the_last_good_one() -> None:
    rows = [
        row("2021-06-30", 140_000_000, own=60_000_000, funds=170_000_000),
        row("2022-06-30", 132_000, own=72_000, funds=171_000),
        row("2023-06-30", 128_000_000, own=79_000_000, funds=174_000_000),
    ]
    assert statuses(assess(rows, COLLEGES, {})) == [
        ("2021-06-30", "register", []),
        (
            "2022-06-30",
            "needs_review",
            ["too_small:endowmentGbp", "too_small:netAssetsGbp", "year_change:-99.9%"],
        ),
        ("2023-06-30", "register", []),
    ]


def test_a_return_in_thousands_is_caught_in_the_oldest_period_too() -> None:
    rows = [
        row("2021-06-30", 140_000, own=60_000, funds=170_000, income=17_000_000),
        row("2022-06-30", 141_000_000, own=61_000_000, funds=171_000_000, income=17_000_000),
    ]
    assert statuses(assess(rows, COLLEGES, {})) == [
        ("2021-06-30", "needs_review", ["too_small:endowmentGbp", "too_small:netAssetsGbp"]),
        ("2022-06-30", "register", []),
    ]


def test_swapped_lines_are_caught_and_do_not_flag_the_next_year() -> None:
    rows = [
        row("2023-06-30", 120, own=150, funds=260),
        row("2024-06-30", 140, own=122, funds=270),  # swapped
        row("2025-06-30", 125, own=152, funds=275),  # straight again
    ]
    result = assess(rows, COLLEGES, {})
    assert result[1].status == "needs_review" and result[1].checks == ["lines_swapped"]
    assert result[2].status == "register" and result[2].checks == []


def test_an_endowment_far_above_net_assets_and_a_missing_line_need_review() -> None:
    result = assess(
        [row("2025-06-30", 400, funds=200), row("2025-06-30", None, number="1000002")],
        COLLEGES,
        {},
    )
    assert result[0].checks == ["endowment_over_net_assets"]
    assert result[1].checks == ["missing:endowmentGbp"]
    assert result[1].endowment_gbp is None
    assert {a.status for a in result} == {"needs_review"}


def test_overrides_correct_hold_back_or_accept() -> None:
    rows = [
        row("2023-06-30", 100),
        row("2024-06-30", 160),  # +60 %: accepted after review
        row("2025-06-30", 170),  # corrected
        row("2025-06-30", 90, number="1000002"),  # held back
    ]
    overrides = {
        ("1000001", "2024-06-30"): Override("1000001", "2024-06-30", CITATION),
        ("1000001", "2025-06-30"): Override("1000001", "2025-06-30", CITATION, endowment_gbp=150),
        ("1000002", "2025-06-30"): Override("1000002", "2025-06-30", CITATION, review="why"),
    }
    result = assess(rows, COLLEGES, overrides)
    assert statuses(result) == [
        ("2023-06-30", "register", []),
        ("2024-06-30", "register", ["year_change:+60.0%"]),
        ("2025-06-30", "override", []),
        ("2025-06-30", "needs_review", ["review:why"]),
    ]
    assert result[2].endowment_gbp == 150 and result[2].override is not None


def test_a_correction_or_acceptance_lapses_when_the_college_re_files() -> None:
    rows = [
        row("2024-06-30", 100),
        row("2025-06-30", 160),  # +60 %: was accepted when the register said £160m
        row("2025-06-30", 90, number="1000002"),  # was corrected when it said £95m
    ]
    overrides = {
        ("1000001", "2025-06-30"): Override(
            "1000001", "2025-06-30", CITATION, register_filed={"endowmentGbp": 160 * M}
        ),
        ("1000002", "2025-06-30"): Override(
            "1000002",
            "2025-06-30",
            CITATION,
            endowment_gbp=80 * M,
            register_filed={"endowmentGbp": 95 * M},
        ),
    }
    result = assess(rows, COLLEGES, overrides)
    assert statuses(result) == [
        ("2024-06-30", "register", []),
        ("2025-06-30", "register", ["year_change:+60.0%"]),
        ("2025-06-30", "needs_review", ["override_stale:endowmentGbp"]),
    ]
    assert result[2].endowment_gbp == 90 * M and result[2].override is None


def test_a_standing_review_holds_back_every_year_without_its_own_entry() -> None:
    standing = {"1000001": cr.StandingReview("1000001", "definition differs", CITATION)}
    rows = [row("2024-06-30", 100), row("2025-06-30", 105), row("2025-06-30", 90, number="1000002")]
    overrides = {
        ("1000001", "2024-06-30"): Override(
            "1000001", "2024-06-30", CITATION, endowment_gbp=80 * M,
            register_filed={"endowmentGbp": 100 * M},
        ),
    }  # fmt: skip
    assert statuses(assess(rows, COLLEGES, overrides, standing)) == [
        ("2024-06-30", "override", []),
        ("2025-06-30", "needs_review", ["review:definition differs"]),
        ("2025-06-30", "register", []),
    ]


def test_an_override_file_entry_cannot_both_correct_and_hold_back(tmp_path) -> None:
    path = tmp_path / "overrides.json"
    entry = {
        "charityNumber": "1",
        "periodEnd": "2025-06-30",
        "endowmentGbp": 1,
        "review": "x",
        "citation": {"url": "https://x", "page": "PDF p.1", "reason": "r"},
    }
    path.write_text(json.dumps({"overrides": [entry]}))
    with pytest.raises(ValueError, match="both"):
        load_overrides(path)


# --- the stage ------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


@pytest.fixture
def two_colleges(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(college_finances, "load_charities", lambda: dict(COLLEGES))
    monkeypatch.setattr(college_finances, "load_overrides", dict)
    monkeypatch.setattr(college_finances, "load_standing_reviews", dict)


def context(make_settings, state: SyncState, *, dry_run: bool = False) -> StageContext:
    settings = make_settings(min_host_interval=0.0)
    run = RunReport(run_key="20261119T120000Z-abcdef", command="sync", dry_run=dry_run)
    return StageContext(
        settings=settings,
        report=run.stage("college_finances"),
        run=run,
        loader=ConvexLoader(SITE, "test-key", max_retries=1, dry_run=dry_run),
        state=state,
        staging=StagingStore(settings.staging_dir),
        dry_run=dry_run,
        limit=None,
    )


EXTRACT = zipped(
    extract_text(
        line("1000001", "2024-06-30", "9000000", "40000000", "110000000", "170000000"),
        line("1000001", "2025-06-30", "10000000", "40000000", "120000000", "180000000"),
        line("1000002", "2025-07-31", "5000000", "30000000", "60000000", "90000000"),
    )
)
MODIFIED_MS = int(datetime(2026, 11, 19, 1, 10, 47, tzinfo=UTC).timestamp() * 1000)
ROBOTS = "https://ccewuksprdoneregsadata1.blob.core.windows.net/robots.txt"


def test_the_stage_posts_each_period_with_its_source_then_skips_an_unchanged_extract(
    net, make_settings, two_colleges
) -> None:
    net.get(ROBOTS).respond(400)
    extract = net.get(EXTRACT_URL).mock(
        side_effect=[
            httpx.Response(
                200,
                content=EXTRACT,
                headers={"ETag": "0x1", "Last-Modified": "Thu, 19 Nov 2026 01:10:47 GMT"},
            ),
            httpx.Response(304),
        ]
    )
    route = net.post(f"{SITE}/api/pipeline/collegeFinances").respond(
        200, json={"inserted": 3, "updated": 0, "unchanged": 0}
    )
    state = SyncState()

    ctx = context(make_settings, state)
    college_finances.run(ctx)
    assert ctx.report.inserted == 3
    body = json.loads(route.calls[0].request.content)["finances"]
    assert [f["periodEnd"] for f in body] == ["2024-06-30", "2025-06-30", "2025-07-31"]
    latest = body[1]
    assert latest == {
        "charityNumber": "1000001",
        "collegeKey": "org-alpha-college",
        "periodEnd": "2025-06-30",
        "endowmentGbp": 120_000_000,
        "netAssetsGbp": 180_000_000,
        "incomeGbp": 10_000_000,
        "status": "register",
        "checks": [],
        "source": {
            "extractUrl": EXTRACT_URL,
            "extractModified": MODIFIED_MS,
            "registerUrl": "https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/1000001",
        },
        "retrievedAt": latest["retrievedAt"],
    }
    assert "null" not in route.calls[0].request.content.decode()
    assert ctx.report.notes == [
        "2/2 colleges, 3 periods (2024-06-30 to 2025-07-31): 3 register",
    ]

    # The next run: the extract answers 304 and matches what was posted.
    again = context(make_settings, state)
    college_finances.run(again)
    assert extract.call_count == 2
    assert route.call_count == 1
    assert any("unchanged" in note for note in again.report.notes)


def test_a_failed_download_fails_the_stage(net, make_settings, two_colleges) -> None:
    net.get(ROBOTS).respond(400)
    net.get(EXTRACT_URL).respond(404)
    with pytest.raises(college_finances.ExtractUnavailable, match="not_found"):
        college_finances.run(context(make_settings, SyncState()))


def test_a_changed_layout_fails_the_stage(net, make_settings, two_colleges) -> None:
    net.get(ROBOTS).respond(400)
    renamed = zipped(extract_text().replace("assets_long_term_investment", "assets_lti"))
    net.get(EXTRACT_URL).respond(200, content=renamed)
    with pytest.raises(college_finances.ExtractUnavailable, match="changed format"):
        college_finances.run(context(make_settings, SyncState()))


def test_a_dry_run_without_a_cached_extract_reads_nothing(make_settings, two_colleges) -> None:
    ctx = context(make_settings, SyncState(), dry_run=True)
    college_finances.run(ctx)
    assert ctx.report.notes == ["dry run: no cached register extract; nothing read"]


def test_an_edited_override_is_posted_though_the_extract_is_unchanged(
    net, make_settings, two_colleges, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    net.get(ROBOTS).respond(400)
    net.get(EXTRACT_URL).mock(
        side_effect=[httpx.Response(200, content=EXTRACT), httpx.Response(304)]
    )
    route = net.post(f"{SITE}/api/pipeline/collegeFinances").respond(
        200, json={"inserted": 0, "updated": 0, "unchanged": 3}
    )
    overrides = tmp_path / "overrides.json"
    overrides.write_text(json.dumps({"overrides": []}))
    monkeypatch.setattr(college_finances, "OVERRIDES_PATH", overrides)
    state = SyncState()
    college_finances.run(context(make_settings, state))
    overrides.write_text(json.dumps({"overrides": [], "standing": []}))
    college_finances.run(context(make_settings, state))
    assert route.call_count == 2


def test_a_college_missing_from_the_extract_fails_after_the_others_post(
    net, make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    three = {**COLLEGES, "1000003": "org-gamma-college"}
    monkeypatch.setattr(college_finances, "load_charities", lambda: dict(three))
    monkeypatch.setattr(college_finances, "load_overrides", dict)
    monkeypatch.setattr(college_finances, "load_standing_reviews", dict)
    net.get(ROBOTS).respond(400)
    net.get(EXTRACT_URL).respond(200, content=EXTRACT)
    route = net.post(f"{SITE}/api/pipeline/collegeFinances").respond(
        200, json={"inserted": 3, "updated": 0, "unchanged": 0}
    )
    state = SyncState()
    with pytest.raises(college_finances.CollegesMissing, match="org-gamma-college"):
        college_finances.run(context(make_settings, state))
    assert route.call_count == 1
    assert "posted_sha256" not in state.data("college_finances")
