"""Stage `su_directory`: Cambridge SU "Find a Society" — the directory page and
every profile (source-research §1; parsing in `sources/su.py`).

Writes two staging files per run: ``var/staging/su_directory/<run>--su_directory.jsonl``
(one observation per directory entry) and
``var/staging/su_profile/<run>--su_directory.jsonl`` (one per profile). It never
calls Convex and never mints keys; `resolve` does, then `load` posts.

Fetching goes through `PoliteClient` (robots.txt, one request at a time,
≥ 1 s apart, cached under ``var/cache``) with the society purpose
(`sources/policy.py`, D3): logos under the SU's robots-disallowed
``/asset/`` may be fetched, which the directory observation's access note
records as ``robots_override:society``. A profile fetched within
`PROFILE_FRESH_FOR` is read from the cache, so a re-run the same day costs
one request. A dry run touches no network: it replays whatever the cache
holds and stages nothing.

The stage fails (after staging what it read) when the directory cannot be
read or parsed, or when more than `MAX_UNREADABLE_SHARE` of the profiles
could not be fetched — a source that is mostly down must show up as a failed
run, not as a quiet drop in coverage.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from datetime import timedelta

from camsocs_pipeline.models.observation import Observation
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.links import classify_email
from camsocs_pipeline.sources.policy import ROBOTS_OVERRIDE_NOTE, SOCIETY
from camsocs_pipeline.sources.su import (
    DIRECTORY_URL,
    DirectoryEntry,
    Profile,
    directory_observation,
    parse_directory,
    parse_profile,
    profile_observation,
    unavailable_profile_observation,
)

PROFILE_FRESH_FOR = timedelta(hours=20)
MAX_UNREADABLE_SHARE = 0.10

Fetch = Callable[..., FetchResult | None]


def run(ctx: StageContext) -> None:
    with ctx.crawler() as client:
        harvest(ctx, client)


def harvest(ctx: StageContext, client: PoliteClient) -> None:
    fetch: Fetch = _cache_only(client) if ctx.dry_run else _society_fetch(client)

    directory = fetch(DIRECTORY_URL)
    if directory is None:
        ctx.report.notes.append("dry run: the directory is not cached; nothing to replay")
        return
    if not directory.ok:
        raise RuntimeError(
            f"SU directory: {directory.outcome} ({directory.status}) {directory.detail or ''}"
        )
    entries = parse_directory(directory.text, directory.final_url)
    if not entries:
        raise RuntimeError("SU directory: no entries parsed — has the page layout changed?")
    listed = len(entries)
    if ctx.limit is not None:
        entries = entries[: ctx.limit]

    directory_records = []
    for entry in entries:
        allowed, note = _logo_access(ctx, client, entry)
        directory_records.append(
            directory_observation(entry, directory, logo_allowed=allowed, logo_note=note)
        )
    profile_records: list[Observation] = []
    profiles: list[Profile] = []
    unreadable: list[str] = []
    for entry in entries:
        page = fetch(entry.profile_url, fresh_for=PROFILE_FRESH_FOR)
        if page is None:
            unreadable.append(f"{entry.profile_url}: not cached")
            continue
        if page.ok:
            profile = parse_profile(page.text, page.final_url)
            profiles.append(profile)
            profile_records.append(profile_observation(entry, profile, page))
        elif page.outcome in ("not_found", "access_restricted"):
            profile_records.append(unavailable_profile_observation(entry, page))
            unreadable.append(f"{entry.profile_url}: {page.outcome}")
        else:
            unreadable.append(f"{entry.profile_url}: {page.outcome} {page.detail or ''}".strip())

    if ctx.dry_run:
        ctx.report.notes.append("dry run: replayed from cache, nothing staged")
    else:
        part = ctx.report.name
        ctx.report.inserted += ctx.staging.write(
            "su_directory", ctx.run.run_key, directory_records, part=part
        )
        ctx.report.inserted += ctx.staging.write(
            "su_profile", ctx.run.run_key, profile_records, part=part
        )

    ctx.report.skipped += len(unreadable)
    ctx.report.notes.append(
        f"{listed} listed; {len(directory_records)} directory and "
        f"{len(profile_records)} profile observations; {len(unreadable)} profiles unreadable"
    )
    ctx.report.notes.extend(coverage_notes(entries, profiles, profile_records))
    ctx.report.notes.extend(f"  {line}" for line in unreadable[:10])

    if entries and not ctx.dry_run and len(unreadable) > MAX_UNREADABLE_SHARE * len(entries):
        raise RuntimeError(f"{len(unreadable)} of {len(entries)} SU profiles could not be read")


def _cache_only(client: PoliteClient) -> Fetch:
    def fetch(url: str, **_: object) -> FetchResult | None:
        return client.cached(url, purpose=SOCIETY)

    return fetch


def _society_fetch(client: PoliteClient) -> Fetch:
    """The SU's pages about its societies, fetched with the society purpose
    (`sources/policy.py`; profiles are allowed by robots.txt anyway)."""

    def fetch(url: str, *, fresh_for: timedelta | None = None) -> FetchResult:
        return client.fetch(url, fresh_for=fresh_for, purpose=SOCIETY)

    return fetch


def _logo_access(
    ctx: StageContext, client: PoliteClient, entry: DirectoryEntry
) -> tuple[bool | None, str | None]:
    """Whether we may copy the logo, and the override that allows it. §1:
    ``/asset/`` is robots-disallowed; D3 lets an SU asset linked from a
    society's listing be fetched with the society purpose, recorded as
    ``robots_override:society``. Not checked in a dry run, which touches no
    network."""
    if ctx.dry_run or entry.logo_url is None:
        return None, None
    if not client.allows(entry.logo_url, SOCIETY):
        return False, None
    disallowed = client.robots_verdict(entry.logo_url) == "disallowed"
    return True, ROBOTS_OVERRIDE_NOTE if disallowed else None


def coverage_notes(
    entries: list[DirectoryEntry], profiles: list[Profile], records: list[Observation]
) -> list[str]:
    """Share of profiles publishing each channel, the email kinds, and what
    else the profiles yielded."""
    if not profiles:
        return []
    total = len(profiles)

    def share(count: int) -> str:
        return f"{count} ({100 * count / total:.1f}%)"

    emails = [p.email for p in profiles if p.email]
    kinds = Counter(classify_email(email) for email in emails)
    instagram = sum(any(s["platform"] == "instagram" for s in p.socials) for p in profiles)
    facebook = sum(any(s["platform"].startswith("facebook") for s in p.socials) for p in profiles)
    x = sum(any(s["platform"] == "x" for s in p.socials) for p in profiles)
    years = Counter(entry.form_year or "none" for entry in entries)
    yielded = Counter(
        f.field
        for record in records
        for f in record.fields
        if f.field in ("termcardUrl", "mailingList", "chatChannels", "roleEmails") and f.value
    )
    return [
        f"of {total} profiles: email {share(len(emails))}, instagram {share(instagram)}, "
        f"facebook {share(facebook)}, x {share(x)}, "
        f"website {share(sum(bool(p.website) for p in profiles))}, "
        f"short description {share(sum(bool(p.short_description) for p in profiles))}, "
        f"description {share(sum(bool(p.description) for p in profiles))}",
        "email kinds: " + ", ".join(f"{kind} {n}" for kind, n in kinds.most_common()),
        "profiles with " + ", ".join(f"{name} {n}" for name, n in yielded.most_common()),
        "logo form years: " + ", ".join(f"{year} {n}" for year, n in sorted(years.items())),
    ]
