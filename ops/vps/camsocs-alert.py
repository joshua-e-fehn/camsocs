#!/usr/bin/env python3
"""A Slack DM when a scheduled camsocs harvest fails (decision D5; docs/ops-vps.md "Alerts").

    camsocs-alert.py [--dry-run] <group>

Run by ``camsocs-alert@<group>.service``, which ``camsocs-harvest@<group>.service``
names in ``OnFailure=``. Modelled on the host's ``mya-backup`` ``send_alert``: it
posts through Mya's Slack bot with the Slack Web API. Installed root-owned in
``/usr/local/lib/camsocs-ops/`` from a reviewed commit (``install.sh``), never run
from the checkout the harvest can write.

- **Credentials.** From the env file ``CAMSOCS_ALERT_ENV`` names (default
  ``$CREDENTIALS_DIRECTORY/slack-env``: the unit's systemd credential, a copy of
  the root-owned ``/etc/camsocs/alert.env``, which ``install.sh`` extracts from
  Mya's env file and which holds nothing else) it reads ``SLACK_BOT_TOKEN``,
  ``SLACK_HOME_CHANNEL`` and ``SLACK_ALLOWED_USERS`` — no other key is kept.
- **Where.** ``SLACK_HOME_CHANNEL`` when it is set; otherwise the first user in
  ``SLACK_ALLOWED_USERS``, whose DM ``conversations.open`` opens; then
  ``chat.postMessage``.
- **What.** Structured facts only, never text a harvest read: the group, the
  exit code and how the unit ended (systemd's ``MONITOR_*`` variables for
  ``OnFailure=`` units), and from the status file — written by the harvest, so
  untrusted — only values of a known shape: the phase (one of the runner's
  phases), the commit (hex), the run key, the start and finish times and the
  failed stages' names. Anything else in it (the pipeline's error text, its
  warnings, the log) is not sent: the message names the log's path on the host
  instead. Scraped titles, descriptions and server errors therefore never reach
  Slack (or Mya's channel). The whole message is still masked as a last line
  of defence: Slack, OpenAI-style, GitHub and Google keys, ``Bearer …``,
  ``NAME=value`` for secret-looking names, credentials in URLs, secret-looking
  query parameters and long opaque strings.
- ``--dry-run`` prints the message instead of sending it.

Standard library only (the host's python3). Exit 0 when the message was sent
(or printed), 1 when it was not; the reason goes to stderr (the journal) and
never includes a secret.
"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api"
WANTED_KEYS = ("SLACK_BOT_TOKEN", "SLACK_HOME_CHANNEL", "SLACK_ALLOWED_USERS")
DEFAULT_STATE_DIR = "/var/lib/camsocs"
DEFAULT_LOG_DIR = "/var/log/camsocs"
CREDENTIAL_NAME = "slack-env"
#: Slack accepts far more; an alert this long is already unreadable on a phone.
MAX_MESSAGE_CHARS = 1500
MASK = "***"
#: The phases `camsocs-harvest.sh` records (docs/ops-vps.md, exit codes).
PHASES = frozenset({"done", "lock", "update", "install", "pipeline", "prune", "script", "stopped"})
#: Shapes a status value must have to be shown (the file is the harvest's).
_COMMIT = re.compile(r"[0-9a-f]{7,40}")
_RUN_KEY = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]{0,63}")
_STAGE = re.compile(r"[a-z][a-z0-9_]{0,39}")
_INSTANT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_LOG_FILE = re.compile(r"/var/log/camsocs/\d{4}-\d{2}-\d{2}-[a-z]+\.log")
_MONITOR = re.compile(r"[A-Za-z0-9_-]{1,40}")
#: Failed stages named at most.
MAX_STAGES = 12

#: An environment-style name that says it holds a secret (LLM_API_KEY, SLACK_BOT_TOKEN).
_SECRET_ENV_NAME = r"[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)[A-Z0-9_]*"
#: The same in code and config spellings (api_key, "access_token", client-secret).
_SECRET_WORD = (
    r"(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|bot[_-]?token"
    r"|client[_-]?secret|private[_-]?key|secret|password|passwd|token)"
)
_VALUE = r"(\"[^\"]*\"|'[^']*'|[^\s,;&]+)"
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Credentials in a URL: https://user:pass@host
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"), rf"\1{MASK}@"),
    # Slack, OpenAI-style, GitHub and Google keys.
    (re.compile(r"\bxox[a-z]-[A-Za-z0-9-]{8,}"), MASK),
    (re.compile(r"\bxapp-[A-Za-z0-9-]{8,}"), MASK),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"), MASK),
    (re.compile(r"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}"), MASK),
    (re.compile(r"\bAIza[A-Za-z0-9_-]{30,}"), MASK),
    # Authorization: Bearer <token> (or Basic).
    (re.compile(r"(?i)\b(bearer|basic)\s+[^\s'\"]+"), rf"\1 {MASK}"),
    # NAME=value / NAME: value for secret-looking environment names.
    (re.compile(rf"\b({_SECRET_ENV_NAME}[\"']?\s*[=:]\s*){_VALUE}"), rf"\1{MASK}"),
    # api_key=value, "access_token": "value", password: value.
    (re.compile(rf"(?i)([\"']?\b{_SECRET_WORD}[\"']?\s*[=:]\s*){_VALUE}"), rf"\1{MASK}"),
    # ?token=…&key=… in a URL.
    (
        re.compile(
            r"(?i)([?&](?:[a-z0-9_.-]*(?:key|token|secret|password|auth|sig|signature)"
            r"[a-z0-9_.-]*)=)[^&\s#]+"
        ),
        rf"\1{MASK}",
    ),
)
#: Long opaque strings (hex keys, base64 secrets): 32+ characters of a token
#: alphabet holding both a letter and a digit. An absolute path is left alone.
_OPAQUE = re.compile(r"(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_+/=-])")


class AlertError(RuntimeError):
    """The alert could not be sent; the message is safe to print."""


# --- env files ----------------------------------------------------------------------------


def read_env(path: Path, keys: Iterable[str] | None = None) -> dict[str, str]:
    """``KEY=value`` lines of a dotenv file (``export``, quotes and comments
    allowed); only `keys` when given. Values are never logged."""
    wanted = set(keys) if keys is not None else None
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip().removeprefix("export ").strip()
        if wanted is not None and name not in wanted:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[name] = value
    return values


# --- masking ------------------------------------------------------------------------------


def mask(text: str, known: Iterable[str] = ()) -> str:
    """`text` with everything key- or token-like replaced by ``***``."""
    for value in sorted(set(known), key=len, reverse=True):
        if value:
            text = text.replace(value, MASK)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)

    def opaque(match: re.Match[str]) -> str:
        token = match.group(0)
        if token.startswith("/"):
            return token
        has_letter = any(c.isalpha() for c in token)
        has_digit = any(c.isdigit() for c in token)
        return MASK if has_letter and has_digit else token

    return _OPAQUE.sub(opaque, text)


# --- what to say --------------------------------------------------------------------------


def london_today() -> str:
    """Today's London date, as the runner names its logs (UTC without tzdata)."""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Europe/London")).strftime("%Y-%m-%d")
    except Exception:  # no time-zone data on the host: UTC is a day off at most
        return datetime.now(UTC).strftime("%Y-%m-%d")


def load_status(state_dir: Path, group: str) -> dict[str, Any]:
    path = state_dir / f"status-{group}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _shaped(value: Any, pattern: re.Pattern[str]) -> str | None:
    """`value` when it is a string of exactly `pattern`'s shape, else None."""
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def log_path(group: str, status: Mapping[str, Any], today: str) -> str:
    """Where the run's log is on the host: the status file's path when it has
    the runner's own shape, else the day's log of the group."""
    return _shaped(status.get("logFile"), _LOG_FILE) or f"{DEFAULT_LOG_DIR}/{today}-{group}.log"


def build_message(
    group: str,
    *,
    environ: Mapping[str, str],
    status: Mapping[str, Any],
    host: str,
    today: str,
    known_secrets: Iterable[str] = (),
) -> str:
    """The alert text (Slack mrkdwn): structured facts only (module
    docstring), masked as a whole."""
    result = _shaped(environ.get("MONITOR_SERVICE_RESULT"), _MONITOR) or "failed"
    exit_code = _shaped(environ.get("MONITOR_EXIT_CODE"), _MONITOR) or ""
    exit_status = _shaped(environ.get("MONITOR_EXIT_STATUS"), _MONITOR)
    if exit_status is None:
        code = status.get("exitCode")
        exit_status = str(code) if isinstance(code, int) and not isinstance(code, bool) else "?"
    head = f":rotating_light: camsocs harvest *{group}* failed on {host}"
    facts = [f"exit status {exit_status}" + (f" ({exit_code}, {result})" if exit_code else "")]
    invocation = environ.get("MONITOR_INVOCATION_ID")
    current = bool(status) and (
        not invocation or not status.get("invocationId") or status["invocationId"] == invocation
    )
    body = [head]
    if current:
        phase = status.get("phase")
        facts.append(f"phase: {phase if phase in PHASES else '?'}")
        if commit := _shaped(status.get("commit"), _COMMIT):
            facts.append(f"commit {commit}")
        if run_key := _shaped(status.get("runKey"), _RUN_KEY):
            facts.append(f"run {run_key}")
    body.append(" · ".join(facts))
    if current:
        started = _shaped(status.get("startedAt"), _INSTANT)
        finished = _shaped(status.get("finishedAt"), _INSTANT)
        if started:
            body.append(f"started {started}, finished {finished or '?'}")
        stages = status.get("failedStages")
        names = [
            name for name in (stages if isinstance(stages, list) else []) if _shaped(name, _STAGE)
        ]
        if names:
            shown = ", ".join(names[:MAX_STAGES])
            more = f" and {len(names) - MAX_STAGES} more" if len(names) > MAX_STAGES else ""
            body.append(f"failed stages: {shown}{more}")
    elif status:
        body.append("(the status file is from an earlier run: this one ended before writing it)")
    body.append(
        f"Log on the host: {log_path(group, status if current else {}, today)} · "
        f"status: {DEFAULT_STATE_DIR}/status-{group}.json · "
        f"journalctl -u camsocs-harvest@{group} · docs/ops-vps.md"
    )
    return mask("\n".join(body), known_secrets)[:MAX_MESSAGE_CHARS]


# --- Slack --------------------------------------------------------------------------------

Opener = Callable[..., Any]


def slack_call(method: str, token: str, payload: dict[str, Any], opener: Opener) -> dict:
    """POST one Slack Web API method; its JSON answer, or `AlertError` with Slack's
    own error code (never the token)."""
    request = urllib.request.Request(
        f"{SLACK_API}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with opener(request, timeout=20) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise AlertError(f"{method}: {type(error).__name__}: {mask(str(error), [token])}") from None
    if not isinstance(answer, dict) or not answer.get("ok"):
        code = answer.get("error", "no answer") if isinstance(answer, dict) else "no answer"
        raise AlertError(f"{method}: Slack answered {code}")
    return answer


def destination(settings: Mapping[str, str]) -> tuple[str, str]:
    """``("channel", id)`` for ``SLACK_HOME_CHANNEL``, else ``("user", id)`` for
    the first of ``SLACK_ALLOWED_USERS``."""
    home = settings.get("SLACK_HOME_CHANNEL", "").strip()
    if home:
        return "channel", home
    users = [u for u in re.split(r"[,\s]+", settings.get("SLACK_ALLOWED_USERS", "")) if u]
    if users:
        return "user", users[0]
    raise AlertError("neither SLACK_HOME_CHANNEL nor SLACK_ALLOWED_USERS is set")


def send(settings: Mapping[str, str], text: str, opener: Opener) -> str:
    """Post `text`; returns the channel id it went to."""
    token = settings.get("SLACK_BOT_TOKEN", "").strip()
    if not token:
        raise AlertError("SLACK_BOT_TOKEN is not set")
    kind, target = destination(settings)
    channel = target
    if kind == "user":
        opened = slack_call("conversations.open", token, {"users": target}, opener)
        channel = (opened.get("channel") or {}).get("id") or ""
        if not channel:
            raise AlertError("conversations.open: no channel id in the answer")
    slack_call(
        "chat.postMessage",
        token,
        {"channel": channel, "text": text, "unfurl_links": False, "unfurl_media": False},
        opener,
    )
    return channel


# --- entry point --------------------------------------------------------------------------


def main(
    argv: list[str] | None = None,
    environ: Mapping[str, str] | None = None,
    opener: Opener = urllib.request.urlopen,
) -> int:
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    dry_run = "--dry-run" in argv
    args = [a for a in argv if a != "--dry-run"]
    if len(args) != 1 or not args[0].isidentifier():
        print("usage: camsocs-alert.py [--dry-run] <group>", file=sys.stderr)
        return 64
    group = args[0]

    state_dir = Path(environ.get("CAMSOCS_STATE_DIR") or DEFAULT_STATE_DIR)
    status = load_status(state_dir, group)

    env_path = environ.get("CAMSOCS_ALERT_ENV") or str(
        Path(environ.get("CREDENTIALS_DIRECTORY") or "/nonexistent") / CREDENTIAL_NAME
    )
    try:
        settings = read_env(Path(env_path), WANTED_KEYS)
    except OSError as error:
        settings = {}
        if not dry_run:
            print(f"camsocs-alert: cannot read {env_path} ({error.strerror})", file=sys.stderr)
            return 1

    text = build_message(
        group,
        environ=environ,
        status=status,
        host=socket.gethostname(),
        today=london_today(),
        known_secrets=[v for v in (settings.get("SLACK_BOT_TOKEN"),) if v],
    )
    if dry_run:
        print(text)
        return 0
    try:
        channel = send(settings, text, opener)
    except AlertError as error:
        print(f"camsocs-alert: not sent: {error}", file=sys.stderr)
        return 1
    print(f"camsocs-alert: sent to {channel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
