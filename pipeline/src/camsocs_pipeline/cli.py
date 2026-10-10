"""Command-line entry point (`camsocs`, `pixi run pipeline -- …`).

    camsocs [--env NAME] <command>       NAME selects pipeline/.env.<NAME> (default dev:
                                         pipeline/.env, or CAMSOCS_ENV_FILE); docs/deploy.md
    camsocs status                       resolved config + local state; no network
    camsocs health                       GET /api/pipeline/health with the Bearer key
    camsocs sync [--stages a,b | --group events|full] [--dry-run] [--limit N]
    camsocs harvest [--dry-run] [--limit N]   = sync --group full: every stage, re-derive, report
    camsocs derive                       re-derive statuses, term weeks, stale flags now
    camsocs purge-dev --yes              empty pipeline tables on the DEV deployment
    camsocs worklist [--no-sympa]        rank societies for mailing-list sign-up (CSV)
    camsocs coverage [--before DIR]      field coverage of staged organisations; offline
    camsocs prune-cache [--older-than 90d] [--dry-run]   retention R7 for var/cache + staging

`sync` and `harvest` also take `--env NAME` after the command, as `pixi run
harvest -- --env prod` passes it, and `--summary-json PATH` for a scheduler
(the VPS runner, docs/ops-vps.md).

Commands are thin: parsing and reporting only. Exit codes matter to the cron
that runs `sync`: any failed stage exits non-zero even though the others
committed their work (Bundestracker cli.py) — a cron that sees success because
most of it worked is how a source stays broken.

Nothing here prints a secret: keys are shown only as set/unset.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import click

from camsocs_pipeline import __version__
from camsocs_pipeline.config import (
    DEFAULT_ENV,
    ENV_FILE,
    ConfigError,
    EnvChoice,
    Settings,
    choose_env,
    get_settings,
    load_settings,
)
from camsocs_pipeline.coverage_report import report_path
from camsocs_pipeline.events.common import london_today
from camsocs_pipeline.extract.llm import ModelRefused, assert_model_allowed
from camsocs_pipeline.pipeline.coverage import (
    format_coverage,
    quarantine_counts,
    staged_coverage,
)
from camsocs_pipeline.pipeline.load import (
    ConvexError,
    ConvexLoader,
    StoredFileCache,
    stored_files_path,
)
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import load_state
from camsocs_pipeline.pipeline.sync import STAGE_ORDER, resolve_group, run_sync
from camsocs_pipeline.prune import parse_age, prune_cache, prune_staging
from camsocs_pipeline.resolve.crosswalk import quarantine_path
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.sympa import SympaUnavailable, fetch_soc_lists
from camsocs_pipeline.staging.store import StagingStore
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
@click.option(
    "--env",
    "env_name",
    metavar="NAME",
    help=(
        "Target environment: read pipeline/.env.NAME (dev = pipeline/.env). "
        "Default: CAMSOCS_ENV_FILE if set, else pipeline/.env."
    ),
)
@click.pass_context
def cli(ctx: click.Context, verbose: bool, env_name: str | None) -> None:
    """camsocs — Cambridge societies harvesting pipeline."""
    _configure_logging(verbose)
    ctx.ensure_object(dict)
    if "settings" in ctx.obj:
        # Injected (tests): the environment is whatever the caller says.
        ctx.obj.setdefault("env", EnvChoice(DEFAULT_ENV, ENV_FILE))
        return
    # Read when the command first needs it (`_loaded`), so that `--env` may
    # also follow the command.
    ctx.obj["env_name"] = env_name


def _loaded(ctx: click.Context) -> dict:
    """The command's settings and environment, read once: `--env` before or
    after the command, else `CAMSOCS_ENV_FILE`, else `pipeline/.env`."""
    obj = ctx.find_object(dict)
    if "settings" not in obj:
        env_name = obj.get("env_name")
        try:
            choice = choose_env(env_name)
            settings = get_settings() if env_name is None else load_settings(choice)
        except ConfigError as error:
            raise click.ClickException(str(error)) from error
        obj["env"] = choice
        obj["settings"] = settings
    return obj


def _settings(ctx: click.Context) -> Settings:
    return _loaded(ctx)["settings"]


def _env(ctx: click.Context) -> EnvChoice:
    return _loaded(ctx)["env"]


def _env_after_command(ctx: click.Context, _param: click.Parameter, value: str | None):
    """`--env NAME` after the command (`camsocs sync --group events --env prod`):
    what `pixi run harvest -- --env prod` produces. The same as `--env` before
    the command; two different names are refused."""
    if value is None:
        return None
    obj = ctx.find_object(dict)
    before = obj.get("env_name")
    if before is not None and before != value:
        raise click.BadParameter(f"--env {before} was already given before the command.")
    if "settings" in obj and before is None:
        raise click.BadParameter("the settings were read before --env was given.")
    obj["env_name"] = value
    return value


def _env_option(command):
    return click.option(
        "--env",
        "env_after",
        metavar="NAME",
        expose_value=False,
        is_eager=True,
        callback=_env_after_command,
        help="Target environment, as `camsocs --env NAME` (pipeline/.env.NAME).",
    )(command)


def _summary_option(command):
    return click.option(
        "--summary-json",
        type=click.Path(path_type=Path, dir_okay=False),
        metavar="PATH",
        help="Also write the run's outcome as JSON (stages, warnings, coverage) to PATH.",
    )(command)


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Print the resolved configuration and local state. Makes no network call."""
    settings = _settings(ctx)

    def secret(value) -> str:
        return "set" if value.get_secret_value() else "(unset)"

    rows = [
        ("Environment", _env(ctx).describe()),
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
@click.option(
    "--group",
    metavar="NAME",
    help="A scheduled run's stages instead (stages.GROUPS): events (daily) or full (weekly).",
)
@click.option("--dry-run", is_flag=True, help="No credentials needed; nothing is written.")
@click.option("--limit", type=click.IntRange(min=1), help="Process at most N items per stage.")
@_summary_option
@_env_option
@click.pass_context
def sync(
    ctx: click.Context,
    stages: list[str] | None,
    group: str | None,
    dry_run: bool,
    limit: int | None,
    summary_json: Path | None,
) -> None:
    """Run the pipeline stages. This is what the cron runs."""
    _run(ctx, stages=stages, group=group, dry_run=dry_run, limit=limit, summary=summary_json)


@cli.command()
@click.option("--dry-run", is_flag=True, help="No credentials needed; nothing is written.")
@click.option("--limit", type=click.IntRange(min=1), help="Process at most N items per stage.")
@_summary_option
@_env_option
@click.pass_context
def harvest(
    ctx: click.Context, dry_run: bool, limit: int | None, summary_json: Path | None
) -> None:
    """The full harvest, `sync --group full`: every stage in registry order
    (seed → harvest → resolve → enrich → events → inbox / Instagram /
    termcards → load → report), then a re-derivation, and the coverage report
    var/reports/coverage-<date>.md. What `pixi run harvest` runs."""
    _run(ctx, stages=None, group="full", dry_run=dry_run, limit=limit, summary=summary_json)


def _run(
    ctx: click.Context,
    *,
    stages: list[str] | None,
    group: str | None,
    dry_run: bool,
    limit: int | None,
    summary: Path | None,
) -> None:
    """`sync` and `harvest`: run, print the report, re-derive when the group
    asks for it, write the JSON summary, and exit non-zero on any failure."""
    settings = _settings(ctx)
    extra = {"group": group, "environment": _env(ctx).name}
    try:
        chosen = resolve_group(group) if group is not None else None
        report = run_sync(
            settings=settings, stages=stages, group=chosen, dry_run=dry_run, limit=limit
        )
    except (ConfigError, ConvexError, ValueError) as error:
        _write_summary(summary, {**extra, "ok": False, "error": str(error), "stages": []})
        raise click.ClickException(str(error)) from error
    click.echo(report.summary())
    if chosen is not None and chosen.derive and not dry_run:
        # Statuses and term weeks were derived on ingest; this catches what
        # the clock alone changes, and refreshes the overview's coverage.
        try:
            with _loader(settings) as loader:
                loader.derive()
            click.echo("derive: scheduled")
        except ConvexError as error:
            click.echo(f"warning: derive not scheduled ({error})", err=True)
            report.warnings.append(f"derive not scheduled ({error})")
    path = report_path(settings.reports_dir, london_today())
    written = not dry_run and any(s.name == "report" and s.ok for s in report.stages)
    if written and path.exists():
        click.echo(f"coverage report: {path}")
    _write_summary(summary, _summary(report, extra, path if written else None))
    if not report.ok:
        raise click.ClickException(
            "One or more stages failed — see the report above. Every write is an upsert, "
            "so the next run repairs what this one missed."
        )


def _summary(report: RunReport, extra: dict, coverage_report: Path | None) -> dict:
    payload = {**extra, **report.summary_payload()}
    if payload["coverage"] is not None and coverage_report is not None:
        payload["coverage"]["report"] = str(coverage_report)
    return payload


def _write_summary(path: Path | None, payload: dict) -> None:
    """Write `payload` to `path` whole or not at all (temp file + rename), so a
    reader never sees half a file."""
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", "utf-8")
    temporary.replace(path)


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
    if _env(ctx).name != DEFAULT_ENV:
        # The deployment refuses too; this stops it before any request.
        raise click.ClickException(
            f"Refusing: purge-dev runs against the dev environment only, not {_env(ctx).name}."
        )
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


@cli.command()
@click.option(
    "--before",
    type=click.Path(path_type=Path, exists=True, file_okay=False),
    help="Another staging directory to compare with (a copy taken before a change).",
)
@click.option("--json", "as_json", is_flag=True, help="Print JSON instead of a table.")
@click.pass_context
def coverage(ctx: click.Context, before: Path | None, as_json: bool) -> None:
    """How many listed organisations have each field in staging, and how many
    of those values are found — offline: no Convex read, no network."""
    settings = _settings(ctx)
    current = staged_coverage(StagingStore(settings.staging_dir))
    previous = staged_coverage(StagingStore(before)) if before is not None else None
    quarantine = quarantine_counts(quarantine_path(settings.staging_dir))
    if as_json:
        payload = {"now": current.as_dict(), "quarantine": quarantine}
        if previous is not None:
            payload["before"] = previous.as_dict()
        click.echo(json.dumps(payload, indent=1))
        return
    for line in format_coverage(current, previous):
        click.echo(line)
    click.echo(f"orgType: {', '.join(f'{k} {v}' for k, v in current.org_types.items())}")
    if quarantine is not None:
        click.echo(
            "quarantine: " + ", ".join(f"{name} {count}" for name, count in quarantine.items())
        )


def main() -> None:
    """Console-script entry point."""
    cli(obj={})


if __name__ == "__main__":
    main()
