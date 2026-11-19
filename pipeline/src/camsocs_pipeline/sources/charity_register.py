"""The Charity Commission register's Part B annual-return figures for the
colleges (source-research §22): parse the daily bulk extract, keep the 31
colleges' rows, map them to the wealth page's measures, check them and apply
the reviewed overrides.

Pure: no network, no Convex. `stages/college_finances.py` fetches the extract
and posts what `assess` returns.

The extract (``publicextract.charity_annual_return_partb.zip``) holds one
tab-separated text file: UTF-8 with a byte-order mark, a header row, no
quoting, dates as ``YYYY-MM-DD 00:00:00.0000000``, amounts in whole pounds.
Every charity has its last five financial periods. The mapping:

- ``endowmentGbp`` ← ``assets_long_term_investment`` (the balance sheet's
  non-current investments; not ``funds_endowment``, which is only the
  restricted endowment funds);
- ``netAssetsGbp`` ← ``funds_total``;
- ``incomeGbp`` ← ``income_total_income_and_endowments`` (Part B; not Part A's
  gross income, which differs for most colleges);
- ``periodEnd`` ← ``fin_period_end_date``.

The return is self-reported and not audited as a form, so each row is
checked (`CHECKS`). A row that fails a check and has no reviewed override is
posted ``needs_review`` and stays out of the page's figures.
"""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from collections import defaultdict
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

EXTRACT_URL = (
    "https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/"
    "publicextract.charity_annual_return_partb.zip"
)
#: The register's public page for a charity.
REGISTER_URL = "https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/{number}"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CHARITIES_PATH = DATA_DIR / "college_charities.json"
OVERRIDES_PATH = DATA_DIR / "college_finance_overrides.json"

#: The columns the stage reads. One missing (renamed) fails the stage.
REQUIRED_COLUMNS: tuple[str, ...] = (
    "registered_charity_number",
    "fin_period_end_date",
    "assets_long_term_investment",
    "assets_own_use",
    "funds_total",
    "income_total_income_and_endowments",
)

#: A year-on-year change in endowment beyond this fraction needs a reader.
MAX_YEAR_CHANGE = 0.25
#: An endowment above net assets by more than this fraction needs a reader.
MAX_ENDOWMENT_OVER_NET_ASSETS = 0.5
#: Lines look swapped when swapping them explains the previous year this much better.
SWAP_RATIO = 0.5
#: Below these a college's figure is not in pounds (a return filed in
#: thousands): every college's investments and net assets are tens of
#: millions, its income millions. Catches a bad oldest period too, which has
#: no previous year to compare with.
MIN_POUNDS = {"endowmentGbp": 1_000_000, "netAssetsGbp": 1_000_000, "incomeGbp": 100_000}

#: The checks a row can fail (`checks` on the wire: the name, or ``name:detail``).
CHECKS = (
    "missing",  # missing:<field>
    "year_change",  # year_change:+31.2%
    "endowment_over_net_assets",
    "lines_swapped",  # long-term investments and own-use assets look swapped
    "too_small",  # too_small:<field>, a figure not in pounds (filed in thousands)
    "review",  # an override or a standing review held the row back: review:<reason>
    "override_stale",  # override_stale:<field>, the register now says other than what was reviewed
)

Status = Literal["register", "override", "needs_review"]

_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$")


class RegisterFormatError(ValueError):
    """The extract is not what the parser was written for (a renamed column,
    another file layout). The stage fails, so the operator hears of it."""


# --- the colleges and the overrides ---------------------------------------------------


def load_charities(path: Path = CHARITIES_PATH) -> dict[str, str]:
    """Charity number → college key (``org-<slug>``), for the 31 colleges."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return {row["charityNumber"]: row["collegeKey"] for row in data["colleges"]}


@dataclass(frozen=True)
class Citation:
    url: str
    page: str
    reason: str


#: The figure names an override's ``registerFiled`` may pin.
FIGURES = ("endowmentGbp", "netAssetsGbp", "incomeGbp")


@dataclass(frozen=True)
class Override:
    """A reviewed correction of one college's period (`college_finance_overrides.json`)."""

    charity_number: str
    period_end: str
    citation: Citation
    endowment_gbp: int | None = None
    net_assets_gbp: int | None = None
    income_gbp: int | None = None
    #: Hold the row back from the figures, for this reason.
    review: str | None = None
    #: What the register said when the override was reviewed (figure name →
    #: pounds). A correcting or accepting override applies only while the
    #: register still says this: a re-filed return is read again, never
    #: corrected or accepted on the strength of an older one.
    register_filed: Mapping[str, int] = field(default_factory=dict)

    @property
    def changes_values(self) -> bool:
        return any(
            value is not None
            for value in (self.endowment_gbp, self.net_assets_gbp, self.income_gbp)
        )


def load_overrides(path: Path = OVERRIDES_PATH) -> dict[tuple[str, str], Override]:
    data = json.loads(path.read_text(encoding="utf-8"))
    overrides: dict[tuple[str, str], Override] = {}
    for entry in data["overrides"]:
        override = Override(
            charity_number=entry["charityNumber"],
            period_end=entry["periodEnd"],
            citation=Citation(**entry["citation"]),
            endowment_gbp=entry.get("endowmentGbp"),
            net_assets_gbp=entry.get("netAssetsGbp"),
            income_gbp=entry.get("incomeGbp"),
            review=entry.get("review"),
            register_filed=dict(entry.get("registerFiled", {})),
        )
        label = f"Override {override.charity_number} {override.period_end}"
        if override.review and override.changes_values:
            raise ValueError(f"{label}: both")
        unknown = set(override.register_filed) - set(FIGURES)
        if unknown:
            raise ValueError(f"{label}: registerFiled names {sorted(unknown)}")
        if not override.review and not override.register_filed:
            raise ValueError(f"{label}: a correction or acceptance must pin registerFiled")
        key = (override.charity_number, override.period_end)
        if key in overrides:
            raise ValueError(f"Override {key} is listed twice")
        overrides[key] = override
    return overrides


@dataclass(frozen=True)
class StandingReview:
    """A college whose register figure differs in definition from the page's
    every year (Clare's investments include its inflation swaps): each of its
    periods without its own override is held back for this reason."""

    charity_number: str
    review: str
    citation: Citation


def load_standing_reviews(path: Path = OVERRIDES_PATH) -> dict[str, StandingReview]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, StandingReview] = {}
    for entry in data.get("standing", []):
        standing = StandingReview(
            charity_number=entry["charityNumber"],
            review=entry["review"],
            citation=Citation(**entry["citation"]),
        )
        if standing.charity_number in out:
            raise ValueError(f"Standing review {standing.charity_number} is listed twice")
        out[standing.charity_number] = standing
    return out


# --- parsing --------------------------------------------------------------------------


@dataclass(frozen=True)
class PartBRow:
    """One financial period of one charity, as the register states it."""

    charity_number: str
    period_end: str
    long_term_investment: int | None
    own_use: int | None
    funds_total: int | None
    income_total: int | None


def parse_amount(text: str) -> int | None:
    """Whole pounds; blank is None (not filed), never zero."""
    text = text.strip()
    if not text:
        return None
    try:
        return int(Decimal(text).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    except InvalidOperation as error:
        raise RegisterFormatError(f"not an amount: {text!r}") from error


def parse_date(text: str) -> str:
    match = _DATE.match(text.strip())
    if not match:
        raise RegisterFormatError(f"not a date: {text!r}")
    return match.group(1)


def read_extract(content: bytes, charities: Collection[str]) -> list[PartBRow]:
    """The rows of `charities` in the zipped extract, streamed (the text file
    is about 30 MB; only the colleges' rows are kept)."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as error:
        raise RegisterFormatError(f"not a zip file: {error}") from error
    with archive:
        members = [name for name in archive.namelist() if name.endswith(".txt")]
        if len(members) != 1:
            raise RegisterFormatError(f"expected one .txt file in the extract, found {members}")
        with archive.open(members[0]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
            return parse_rows(text, charities)


def parse_rows(lines: Iterable[str], charities: Collection[str]) -> list[PartBRow]:
    """`read_extract` on the text file's lines."""
    csv.field_size_limit(1 << 24)
    reader = csv.reader(lines, delimiter="\t", quoting=csv.QUOTE_NONE)
    header = next(reader, None)
    if header is None:
        raise RegisterFormatError("the extract is empty")
    header = [name.strip() for name in header]
    missing = [name for name in REQUIRED_COLUMNS if name not in header]
    if missing:
        raise RegisterFormatError(f"the extract lacks the columns {missing}")
    at = {name: header.index(name) for name in REQUIRED_COLUMNS}
    wanted = set(charities)
    rows: list[PartBRow] = []
    for cells in reader:
        if len(cells) <= at["registered_charity_number"]:
            continue
        number = cells[at["registered_charity_number"]].strip()
        if number not in wanted:
            continue
        if len(cells) < len(header):
            raise RegisterFormatError(
                f"charity {number}: {len(cells)} cells for {len(header)} columns"
            )
        rows.append(
            PartBRow(
                charity_number=number,
                period_end=parse_date(cells[at["fin_period_end_date"]]),
                long_term_investment=parse_amount(cells[at["assets_long_term_investment"]]),
                own_use=parse_amount(cells[at["assets_own_use"]]),
                funds_total=parse_amount(cells[at["funds_total"]]),
                income_total=parse_amount(cells[at["income_total_income_and_endowments"]]),
            )
        )
    return rows


# --- checks and overrides -------------------------------------------------------------


@dataclass
class Assessed:
    """One college's period, ready to post (`models.wire.CollegeFinance`)."""

    charity_number: str
    college_key: str
    period_end: str
    status: Status
    checks: list[str] = field(default_factory=list)
    endowment_gbp: int | None = None
    net_assets_gbp: int | None = None
    income_gbp: int | None = None
    override: Override | None = None


def _pct(change: float) -> str:
    return f"{change * 100:+.1f}%"


def _swapped(row: PartBRow, prev_lti: int | None, prev_own: int | None) -> bool:
    """Whether the long-term investments and own-use lines read better swapped:
    each is closer to the *other* line's previous value."""
    values = (row.long_term_investment, row.own_use, prev_lti, prev_own)
    if any(value is None or value <= 0 for value in values):
        return False
    lti, own = row.long_term_investment or 0, row.own_use or 0
    p_lti, p_own = prev_lti or 0, prev_own or 0
    straight = abs(lti - p_lti) + abs(own - p_own)
    crossed = abs(lti - p_own) + abs(own - p_lti)
    return straight > 0 and crossed < SWAP_RATIO * straight


def assess(
    rows: Iterable[PartBRow],
    colleges: Mapping[str, str],
    overrides: Mapping[tuple[str, str], Override],
    standing: Mapping[str, StandingReview] | None = None,
) -> list[Assessed]:
    """Map, check and correct every row, oldest period first per college.

    Each check compares with the previous believable period, its lines
    swapped back when they looked swapped, so one bad return does not flag
    the good one after it."""
    by_charity: dict[str, dict[str, PartBRow]] = defaultdict(dict)
    for row in rows:
        if row.charity_number not in colleges:
            continue
        if row.period_end in by_charity[row.charity_number]:
            raise RegisterFormatError(f"charity {row.charity_number}: {row.period_end} twice")
        by_charity[row.charity_number][row.period_end] = row

    out: list[Assessed] = []
    for number in sorted(by_charity):
        prev_lti: int | None = None
        prev_own: int | None = None
        prev_endowment: int | None = None
        for period_end in sorted(by_charity[number]):
            row = by_charity[number][period_end]
            checks: list[str] = []
            filed = {
                "endowmentGbp": row.long_term_investment,
                "netAssetsGbp": row.funds_total,
                "incomeGbp": row.income_total,
            }
            for name, value in filed.items():
                if value is None:
                    checks.append(f"missing:{name}")
                elif abs(value) < MIN_POUNDS[name]:
                    checks.append(f"too_small:{name}")
            swapped = _swapped(row, prev_lti, prev_own)
            if swapped:
                checks.append("lines_swapped")
            endowment = row.long_term_investment
            if endowment is not None and prev_endowment:
                change = endowment / prev_endowment - 1
                if abs(change) > MAX_YEAR_CHANGE:
                    checks.append(f"year_change:{_pct(change)}")
            if (
                endowment is not None
                and row.funds_total is not None
                and row.funds_total > 0
                and endowment > row.funds_total * (1 + MAX_ENDOWMENT_OVER_NET_ASSETS)
            ):
                checks.append("endowment_over_net_assets")

            override = overrides.get((number, period_end))
            assessed = Assessed(
                charity_number=number,
                college_key=colleges[number],
                period_end=period_end,
                status="needs_review" if checks else "register",
                checks=checks,
                endowment_gbp=row.long_term_investment,
                net_assets_gbp=row.funds_total,
                income_gbp=row.income_total,
                override=override,
            )
            stale = (
                [name for name, value in override.register_filed.items() if filed[name] != value]
                if override is not None
                else []
            )
            if override is not None and stale and not override.review:
                # Re-filed since the review: the correction or acceptance no
                # longer speaks for this return.
                assessed.status = "needs_review"
                assessed.checks.extend(f"override_stale:{name}" for name in stale)
                assessed.override = None
            elif override is not None:
                if override.review:
                    assessed.status = "needs_review"
                    assessed.checks.append(f"review:{override.review}")
                elif override.changes_values:
                    assessed.status = "override"
                    if override.endowment_gbp is not None:
                        assessed.endowment_gbp = override.endowment_gbp
                    if override.net_assets_gbp is not None:
                        assessed.net_assets_gbp = override.net_assets_gbp
                    if override.income_gbp is not None:
                        assessed.income_gbp = override.income_gbp
                else:
                    assessed.status = "register"
            elif standing and number in standing:
                assessed.status = "needs_review"
                assessed.checks.append(f"review:{standing[number].review}")
            out.append(assessed)

            # What the next period is compared with: the register's own lines
            # (the next return is on the register's definition, whatever an
            # override corrected), swapped back when they looked swapped. A
            # row held back for any other reason (a figure in thousands, a
            # missing line) is skipped, so the next return is compared with
            # the last one that was believable.
            unreliable = assessed.status == "needs_review" and any(
                check != "lines_swapped" and not check.startswith("review:") for check in checks
            )
            if not unreliable:
                lti, own = row.long_term_investment, row.own_use
                if swapped:
                    lti, own = own, lti
                prev_lti, prev_own, prev_endowment = lti, own, lti
    return out


__all__ = [
    "CHECKS",
    "EXTRACT_URL",
    "FIGURES",
    "MIN_POUNDS",
    "REGISTER_URL",
    "REQUIRED_COLUMNS",
    "Assessed",
    "Citation",
    "Override",
    "PartBRow",
    "RegisterFormatError",
    "StandingReview",
    "assess",
    "load_charities",
    "load_overrides",
    "load_standing_reviews",
    "parse_amount",
    "parse_date",
    "parse_rows",
    "read_extract",
]
