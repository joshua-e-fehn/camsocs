"""Command-line entry point (`camsocs`, `pixi run pipeline -- …`).

    camsocs status                       resolved config + local state; no network
    camsocs health                       GET /api/pipeline/health with the Bearer key
    camsocs sync [--stages a,b] [--dry-run] [--limit N]
    camsocs harvest [--dry-run] [--limit N]   every stage in order, re-derive, coverage report
    camsocs derive                       re-derive statuses, term weeks, stale flags now
    camsocs purge-dev --yes              empty pipeline tables on the DEV deployment
    camsocs worklist [--no-sympa]        rank societies for mailing-list sign-up (CSV)
    camsocs prune-cache [--older-than 90d] [--dry-run]   retention R7 for var/cache + staging

Commands are thin: parsing and reporting only. Exit codes matter to the cron
that runs `sync`: any failed stage exits non-zero even though the others
committed their work (Bundestracker cli.py) — a cron that sees success because
most of it worked is how a source stays broken.

Nothing here prints a secret: keys are shown only as set/unset.
"""

from __future__ import annotations

import logging
import sys

import click

from camsocs_pipeline import __version__
from camsocs_pipeline.config import ConfigError, Settings, get_settings
from camsocs_pipeline.coverage_report import report_path
from camsocs_pipeline.events.common import london_today
from camsocs_pipeline.extract.llm import ModelRefused, assert_model_allowed
from camsocs_pipeline.pipeline.load import (
    ConvexError,
    ConvexLoader,
    StoredFileCache,
    stored_files_path,
)
from camsocs_pipeline.pipeline.state import load_state
from camsocs_pipeline.pipeline.sync import STAGE_ORDER, run_sync
from camsocs_pipeline.prune import parse_age, prune_cache, prune_staging
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.sympa import SympaUnavailable, fetch_soc_lists
from camsocs_pipeline.worklist import (
    SympaMatcher,
    rank_organisations,
    write_sympa_lists,
    write_worklist,
)

logger = logging.getLogger("camsocs_pipeline")


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    # httpx logs every request URL at INFO; keep that for --verbose only.
    if not verbose:
        logging.getLogger("httpx").setLevel(logging.WARNING)


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
@click.version_option(__version__, prog_name="camsocs")
@click.option("-v", "--verbose", is_flag=True, help="Debug-level logging.")
@click.pass_context
def cli(ctx: click.Context, verbose: bool) -> None:
    """camsocs — Cambridge societies harvesting pipeline."""
    _configure_logging(verbose)
    ctx.ensure_object(dict)
    ctx.obj.setdefault("settings", get_settings())


def _settings(ctx: click.Context) -> Settings:
    return ctx.obj["settings"]


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Print the resolved configuration and local state. Makes no network call."""
    settings = _settings(ctx)

    def secret(value) -> str:
        return "set" if value.get_secret_value() else "(unset)"

    rows = [
        ("Convex HTTP", _convex_http_url(settings)),
        ("Pipeline key", secret(settings.pipeline_api_key)),
        ("LLM base URL", settings.llm_base_url or "(unset)"),
        ("LLM key", secret(settings.llm_api_key)),
        ("LLM bulk model", _model(settings.llm_model_bulk)),
        ("LLM strong model", _model(settings.llm_model_strong)),
        ("LLM concurrency", str(settings.llm_concurrency)),
        ("Meta IG user", settings.meta_ig_user_id or "(unset)"),
        ("Meta token", secret(settings.meta_access_token)),
        ("User-Agent", _user_agent(settings)),
        ("Host interval", f"{settings.min_host_interval}s (robots Crawl-delay may raise it)"),
        ("Cache dir", str(settings.cache_dir)),
        ("Stages", ", ".join(STAGE_ORDER)),
        ("State file", str(settings.state_path)),
    ]
    state = load_state(settings.state_path)
    if state.last_run_key:
        verdict = "ok" if state.last_run_ok else "FAILED"
        rows.append(("Last run", f"{state.last_run_key} at {state.last_run_at} ({verdict})"))
    else:
        rows.append(("Last run", "(never)"))
    rows.extend(
        (f"  {name}", f"last ok {when}") for name, when in sorted(state.stage_last_success.items())
    )

    click.echo(f"camsocs {__version__}")
    width = max(len(label) for label, _ in rows) + 1
    for label, value in rows:
        click.echo(f"  {label + ':':<{width}} {value}")


def _convex_http_url(settings: Settings) -> str:
    try:
        return settings.require_convex_http_url()
    except ConfigError:
        return "(unset)"


def _model(model: str) -> str:
    if not model:
        return "(unset)"
    try:
        return assert_model_allowed(model)
    except ModelRefused:
        return f"{model} — REFUSED (claude* models are not allowed)"


def _user_agent(settings: Settings) -> str:
    try:
        return settings.require_user_agent()
    except ConfigError as error:
        return f"(invalid: {error})" if settings.user_agent else "(unset)"


@cli.command()
@click.pass_context
def health(ctx: click.Context) -> None:
    """Check that the ingestion key opens /api/pipeline/health on the deployment."""
    settings = _settings(ctx)
    try:
        url = settings.require_convex_http_url()
        key = settings.require_pipeline_api_key()
        with ConvexLoader(url, key) as loader:
            ok = loader.health()
    except (ConfigError, ConvexError) as error:
        raise click.ClickException(str(error)) from error
    if not ok:
        raise click.ClickException(f"{url}/api/pipeline/health did not answer ok")
    click.echo(f"ok — {url}/api/pipeline/health accepted the pipeline key")


def _parse_stages(_ctx: click.Context, _param: click.Parameter, value: str | None):
    if value is None:
        return None
    names = [name.strip() for name in value.split(",") if name.strip()]
    return names or None


@cli.command()
@click.option(
    "--stages",
    callback=_parse_stages,
    metavar="A,B",
    help=f"Comma-separated subset of: {', '.join(STAGE_ORDER)}. Default: all.",
)
@click.option("--dry-run", is_flag=True, help="No credentials needed; nothing is written.")
@click.option("--limit", type=click.IntRange(min=1), help="Process at most N items per stage.")
@click.pass_context
def sync(ctx: click.Context, stages: list[str] | None, dry_run: bool, limit: int | None) -> None:
    """Run the pipeline stages. This is what the cron runs."""
    settings = _settings(ctx)
    try:
        report = run_sync(settings=settings, stages=stages, dry_run=dry_run, limit=limit)
    except (ConfigError, ConvexError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    click.echo(report.summary())
    if not report.ok:
        raise click.ClickException(
            "One or more stages failed — see the report above. Every write is an upsert, "
            "so the next run repairs what this one missed."
        )


@cli.command()
@click.option("--dry-run", is_flag=True, help="No credentials needed; nothing is written.")
@click.option("--limit", type=click.IntRange(min=1), help="Process at most N items per stage.")
@click.pass_context
def harvest(ctx: click.Context, dry_run: bool, limit: int | None) -> None:
    """The full harvest: every stage in registry order (seed → harvest →
    resolve → enrich → events → inbox / Instagram / termcards → load →
    report), then a re-derivation, and the coverage report
    var/reports/coverage-<date>.md. What `pixi run harvest` runs."""
    settings = _settings(ctx)
    try:
        report = run_sync(settings=settings, stages=None, dry_run=dry_run, limit=limit)
    except (ConfigError, ConvexError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    click.echo(report.summary())
    if not dry_run:
        # Statuses and term weeks were derived on ingest; this catches what
        # the clock alone changes, and refreshes the overview's coverage.
        try:
            with _loader(settings) as loader:
                loader.derive()
            click.echo("derive: scheduled")
        except ConvexError as error:
            click.echo(f"warning: derive not scheduled ({error})", err=True)
        path = report_path(settings.reports_dir, london_today())
        if any(s.name == "report" and s.ok for s in report.stages) and path.exists():
            click.echo(f"coverage report: {path}")
    if not report.ok:
        raise click.ClickException(
            "One or more stages failed — see the report above. Every write is an upsert, "
            "so the next run repairs what this one missed."
        )


@cli.command("prune-cache")
@click.option(
    "--older-than",
    default="90d",
    show_default=True,
    metavar="AGE",
    help="Delete what is older than this: 90d, 12w or 36h.",
)
@click.option("--dry-run", is_flag=True, help="Count what would go; delete nothing.")
@click.option(
    "--staging/--no-staging",
    default=True,
    show_default=True,
    help="Also delete superseded staging files (the latest of each part always stays).",
)
@click.pass_context
def prune_cache_command(ctx: click.Context, older_than: str, dry_run: bool, staging: bool) -> None:
    """Delete raw pages, images and LLM replies in var/cache (and superseded
    staged observations) older than --older-than — the retention schedule's
    R7 (docs/compliance/retention.md)."""
    settings = _settings(ctx)
    try:
        age = parse_age(older_than)
    except ValueError as error:
        raise click.BadParameter(str(error), param_hint="--older-than") from error
    result = prune_cache(settings.cache_dir, age, dry_run=dry_run)
    click.echo(f"cache {settings.cache_dir}: {result.summary(dry_run)}")
    if staging:
        staged = prune_staging(settings.staging_dir, age, dry_run=dry_run)
        click.echo(f"staging {settings.staging_dir}: {staged.summary(dry_run)}")


def _loader(settings: Settings) -> ConvexLoader:
    try:
        return ConvexLoader(settings.require_convex_http_url(), settings.require_pipeline_api_key())
    except ConfigError as error:
        raise click.ClickException(str(error)) from error


@cli.command()
@click.pass_context
def derive(ctx: click.Context) -> None:
    """Re-derive organisation statuses, events' term weeks and stale people now
    (the daily cron does the same)."""
    try:
        with _loader(_settings(ctx)) as loader:
            loader.derive()
    except ConvexError as error:
        raise click.ClickException(str(error)) from error
    click.echo("ok — derivation scheduled")


@cli.command("purge-dev")
@click.option("--yes", is_flag=True, help="Confirm: delete every pipeline-owned row on dev.")
@click.pass_context
def purge_dev(ctx: click.Context, yes: bool) -> None:
    """Empty every pipeline-owned table on the dev deployment, before a full
    harvest. The deployment itself refuses unless it is the dev deployment;
    the run log, inbox, listing requests and broker-owned rows are kept."""
    if not yes:
        raise click.ClickException("Refusing without --yes.")
    settings = _settings(ctx)
    try:
        with _loader(settings) as loader:
            deleted = loader.purge_dev()
            # The deployment's stored files went too: forget their ids.
            cache = StoredFileCache.load(stored_files_path(settings.staging_dir), loader.base_url)
            cache.clear()
            cache.save()
    except ConvexError as error:
        raise click.ClickException(str(error)) from error
    total = sum(deleted.values())
    detail = ", ".join(f"{table} {count}" for table, count in sorted(deleted.items()))
    click.echo(f"ok — deleted {total} rows" + (f" ({detail})" if detail else ""))


@cli.command()
@click.option("--no-sympa", is_flag=True, help="Skip the public Sympa list search.")
@click.pass_context
def worklist(ctx: click.Context, no_sympa: bool) -> None:
    """Rank organisations for mailing-list sign-up (PLAN.md J4) and write
    var/reports/mailing-list-worklist.csv (+ sympa-soc-lists.csv)."""
    settings = _settings(ctx)
    try:
        with _loader(settings) as loader:
            organisations = loader.worklist()
    except ConvexError as error:
        raise click.ClickException(str(error)) from error

    lists = []
    if not no_sympa:
        try:
            with PoliteClient(
                user_agent=settings.require_user_agent(),
                cache_dir=settings.cache_dir,
                min_interval=settings.min_host_interval,
            ) as client:
                lists = fetch_soc_lists(client)
        except (SympaUnavailable, ConfigError) as error:
            click.echo(f"warning: public Sympa lists not read ({error})", err=True)
    matcher = SympaMatcher(lists)
    public = matcher.assign(organisations)

    inbox = load_state(settings.state_path).stage_data.get("inbox", {})
    rows = rank_organisations(
        organisations,
        public_lists=public,
        receiving_orgs=inbox.get("org_last_mail", {}).keys(),
        receiving_lists=inbox.get("lists_seen", {}).keys(),
    )
    path = write_worklist(rows, settings.reports_dir)
    click.echo(f"{len(rows)} organisations ranked of {len(organisations)} → {path}")
    if lists:
        sympa_path = write_sympa_lists(matcher, settings.reports_dir)
        click.echo(f"{len(lists)} public soc- lists, {len(matcher.matched)} matched → {sympa_path}")


def main() -> None:
    """Console-script entry point."""
    cli(obj={})


if __name__ == "__main__":
    main()
