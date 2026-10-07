"""Command-line entry point (`camsocs`, `pixi run pipeline -- …`).

    camsocs status                       resolved config + local state; no network
    camsocs health                       GET /api/pipeline/health with the Bearer key
    camsocs sync [--stages a,b] [--dry-run] [--limit N]

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
from camsocs_pipeline.extract.llm import ModelRefused, assert_model_allowed
from camsocs_pipeline.pipeline.load import ConvexError, ConvexLoader
from camsocs_pipeline.pipeline.state import load_state
from camsocs_pipeline.pipeline.sync import STAGE_ORDER, run_sync

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


def main() -> None:
    """Console-script entry point."""
    cli(obj={})


if __name__ == "__main__":
    main()
