"""Stage `college_finances`: the colleges' endowment, net assets and income
from the Charity Commission register (source-research §22) → `collegeFinances`.

Runs in the weekly `full` group (no timer of its own). Each run:

1. fetches the register's daily Part B extract through the polite client, a
   conditional request on the cached copy's ETag / Last-Modified (a 304 moves
   no data). When the extract, the college list and the overrides are all
   byte-identical to what the last run posted (`state`), nothing is parsed or
   posted (an edited override is posted on the next run, extract unchanged);
2. keeps the 31 colleges' rows (`data/college_charities.json`), maps, checks
   and corrects them (`sources/charity_register.py`,
   `data/college_finance_overrides.json`);
3. posts every period to ``POST /api/pipeline/collegeFinances``; a row that
   failed a check without a reviewed override goes as ``needs_review`` with
   its reasons, and the site leaves it out of its figures.

A failed download or a changed column layout fails the stage, which the
runner reports to the operator; so does a college missing from the extract
(a renumbered or removed charity), after the others are posted, and on every
run until `data/college_charities.json` is fixed. A dry run reads the cached
extract only.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from datetime import datetime
from email.utils import parsedate_to_datetime

from camsocs_pipeline.claims import epoch_ms
from camsocs_pipeline.models.wire import (
    CollegeFinance,
    CollegeFinanceCitation,
    CollegeFinanceSource,
)
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.charity_register import (
    CHARITIES_PATH,
    EXTRACT_URL,
    OVERRIDES_PATH,
    REGISTER_URL,
    Assessed,
    RegisterFormatError,
    assess,
    load_charities,
    load_overrides,
    load_standing_reviews,
    read_extract,
)

STAGE = "college_finances"


class ExtractUnavailable(RuntimeError):
    """The register's extract could not be read; the stage fails."""


class CollegesMissing(RuntimeError):
    """A college's charity number is not in the extract; the stage fails
    after posting the others."""


#: Bump when the parser or the checks change what a given extract yields.
ASSESS_VERSION = "2"


def inputs_sha256(extract_sha256: str) -> str:
    """What one run's posting depends on: the extract, the college list, the
    overrides and the checks' version."""
    digest = hashlib.sha256(f"{ASSESS_VERSION}\n{extract_sha256}\n".encode())
    for path in (CHARITIES_PATH, OVERRIDES_PATH):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _http_date_ms(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(parsedate_to_datetime(value).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def to_wire(row: Assessed, *, retrieved_at: int, extract_modified: int | None) -> CollegeFinance:
    citation = row.override.citation if row.override is not None else None
    return CollegeFinance(
        charity_number=row.charity_number,
        college_key=row.college_key,
        period_end=row.period_end,
        endowment_gbp=row.endowment_gbp,
        net_assets_gbp=row.net_assets_gbp,
        income_gbp=row.income_gbp,
        status=row.status,
        checks=row.checks,
        source=CollegeFinanceSource(
            extract_url=EXTRACT_URL,
            extract_modified=extract_modified,
            register_url=REGISTER_URL.format(number=row.charity_number),
            override_citation=(
                CollegeFinanceCitation(url=citation.url, page=citation.page, reason=citation.reason)
                if citation is not None
                else None
            ),
        ),
        retrieved_at=retrieved_at,
    )


def run(ctx: StageContext) -> None:
    state = ctx.state.data(STAGE)
    with ctx.crawler() as client:
        if ctx.dry_run:
            result = client.cached(EXTRACT_URL)
            if result is None:
                ctx.report.notes.append("dry run: no cached register extract; nothing read")
                return
        else:
            result = client.fetch(EXTRACT_URL, accept="application/zip, */*;q=0.5")
    if not result.ok or result.content is None:
        detail = " ".join(str(part) for part in (result.status, result.detail) if part)
        raise ExtractUnavailable(f"register extract: {result.outcome} {detail}".strip())

    fingerprint = inputs_sha256(result.content_sha256) if result.content_sha256 else None
    if not ctx.dry_run and fingerprint and fingerprint == state.get("posted_sha256"):
        ctx.report.unchanged += int(state.get("posted_rows", 0))
        ctx.report.notes.append(
            f"register extract unchanged since {state.get('posted_at', 'the last run')}; not posted"
        )
        return

    colleges = load_charities()
    try:
        rows = read_extract(result.content, colleges)
    except RegisterFormatError as error:
        raise ExtractUnavailable(f"register extract changed format: {error}") from error
    found = {row.charity_number for row in rows}
    assessed = assess(rows, colleges, load_overrides(), load_standing_reviews())

    retrieved_at = epoch_ms(datetime.fromisoformat(result.fetched_at))
    extract_modified = _http_date_ms(result.last_modified)
    finances = [
        to_wire(row, retrieved_at=retrieved_at, extract_modified=extract_modified)
        for row in assessed
    ]
    posted = ctx.loader.upsert_college_finances(finances)
    ctx.report.inserted += posted.inserted
    ctx.report.updated += posted.updated
    ctx.report.unchanged += posted.unchanged

    statuses = Counter(row.status for row in assessed)
    periods = sorted({row.period_end for row in assessed})
    span = f"{periods[0]} to {periods[-1]}" if periods else "no periods"
    ctx.report.notes.append(
        f"{len(found)}/{len(colleges)} colleges, {len(assessed)} periods ({span}): "
        + ", ".join(f"{count} {status}" for status, count in sorted(statuses.items()))
    )
    absent = sorted(colleges[number] for number in set(colleges) - found)
    if absent:
        ctx.report.notes.append(f"not in the extract: {', '.join(absent)}")
    for row in assessed:
        if row.status == "needs_review":
            ctx.report.notes.append(
                f"needs review: {row.college_key} {row.period_end} "
                + "; ".join(check.split(":", 1)[0] for check in row.checks)
            )
    if absent:
        # No state: the next run reads, posts and fails again until fixed.
        raise CollegesMissing(
            f"not in the register extract (renumbered or removed?): {', '.join(absent)}"
        )
    if not ctx.dry_run and fingerprint:
        state["posted_sha256"] = fingerprint
        state["posted_rows"] = len(finances)
        state["posted_at"] = result.fetched_at
        if result.last_modified:
            state["extract_modified"] = result.last_modified
