#!/usr/bin/env python3
"""A Slack DM when a scheduled camsocs harvest fails (decision D5; docs/ops-vps.md "Alerts").

    camsocs-alert.py [--dry-run] <group>

Run by ``camsocs-alert@<group>.service``, which ``camsocs-harvest@<group>.service``
names in ``OnFailure=``. Modelled on the host's ``mya-backup`` ``send_alert``: it
posts through Mya's Slack bot with the Slack Web API.

- **Credentials.** From the env file ``CAMSOCS_ALERT_ENV`` names (Mya's Hermes
  ``.env``, which the unit hands over read-only as a systemd credential; default
  ``$CREDENTIALS_DIRECTORY/slack-env``) it reads ``SLACK_BOT_TOKEN``,
  ``SLACK_HOME_CHANNEL`` and ``SLACK_ALLOWED_USERS`` — no other key is kept.
- **Where.** ``SLACK_HOME_CHANNEL`` when it is set; otherwise the first user in
  ``SLACK_ALLOWED_USERS``, whose DM ``conversations.open`` opens; then
  ``chat.postMessage``.
- **What.** The group, the exit code and how the unit ended (systemd's
  ``MONITOR_*`` variables for ``OnFailure=`` units), the phase that failed, the
  failed stages and the last 20 lines of the run's log — all masked: Slack,
  OpenAI-style, GitHub and Google keys, ``Bearer …``, ``NAME=value`` for any
  environment name with KEY, TOKEN, SECRET, PASSWORD or AUTH in it (and
  ``api_key=``, ``"access_token":``, ``password:`` …), credentials in URLs,
  secret-looking query parameters, long opaque strings (32+ characters with
  letters and digits, absolute paths excepted), and the literal values of such
  keys in the env files ``CAMSOCS_SECRET_FILES`` lists (``:``-separated).
- ``--dry-run`` prints the masked message instead of sending it.

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
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api"
WANTED_KEYS = ("SLACK_BOT_TOKEN", "SLACK_HOME_CHANNEL", "SLACK_ALLOWED_USERS")
DEFAULT_STATE_DIR = "/var/lib/camsocs"
DEFAULT_LOG_DIR = "/var/log/camsocs"
CREDENTIAL_NAME = "slack-env"
TAIL_LINES = 20
#: Slack accepts far more; an alert this long is already unreadable on a phone.
MAX_MESSAGE_CHARS = 3500
MAX_LINE_CHARS = 300
MASK = "***"

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


def secret_values(paths: Iterable[Path]) -> set[str]:
    """The values of secret-looking keys in env files (missing files are skipped)."""
    name = re.compile(rf"(?i)^{_SECRET_ENV_NAME}$")
    found: set[str] = set()
    for path in paths:
        try:
            values = read_env(path)
        except OSError:
            continue
        found.update(v for k, v in values.items() if name.match(k) and len(v) >= 8)
    return found


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


def load_status(state_dir: Path, group: str) -> dict[str, Any]:
    path = state_dir / f"status-{group}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def find_log(log_dir: Path, group: str, status: Mapping[str, Any]) -> Path | None:
    """The run's log: the status file's, else the group's newest."""
    named = status.get("logFile")
    if isinstance(named, str) and named and Path(named).is_file():
        return Path(named)
    logs = sorted(log_dir.glob(f"*-{group}.log"), key=lambda p: p.stat().st_mtime)
    return logs[-1] if logs else None


def tail(path: Path | None, count: int = TAIL_LINES) -> list[str]:
    if path is None:
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [
        line if len(line) <= MAX_LINE_CHARS else line[: MAX_LINE_CHARS - 1] + "…"
        for line in lines[-count:]
    ]


def build_message(
    group: str,
    *,
    environ: Mapping[str, str],
    status: Mapping[str, Any],
    log_path: Path | None,
    lines: list[str],
    host: str,
    known_secrets: Iterable[str] = (),
) -> str:
    """The alert text (Slack mrkdwn), masked as a whole."""
    result = environ.get("MONITOR_SERVICE_RESULT") or "failed"
    exit_code = environ.get("MONITOR_EXIT_CODE") or ""
    exit_status = environ.get("MONITOR_EXIT_STATUS") or str(status.get("exitCode", "?"))
    head = f":rotating_light: camsocs harvest *{group}* failed on {host}"
    facts = [f"exit status {exit_status}" + (f" ({exit_code}, {result})" if exit_code else "")]
    invocation = environ.get("MONITOR_INVOCATION_ID")
    current = bool(status) and (
        not invocation or not status.get("invocationId") or status["invocationId"] == invocation
    )
    if current:
        facts.append(f"phase: {status.get('phase', '?')}")
        if status.get("commit"):
            facts.append(f"commit {status['commit']}")
        if status.get("runKey"):
            facts.append(f"run {status['runKey']}")
    body = [head, " · ".join(facts)]
    if current and status.get("startedAt"):
        body.append(f"started {status['startedAt']}, finished {status.get('finishedAt', '?')}")
    if current and status.get("failedStages"):
        body.append("failed stages: " + ", ".join(str(s) for s in status["failedStages"]))
    if current and status.get("error"):
        body.append(f"error: {status['error']}")
    if status and not current:
        body.append("(the status file is from an earlier run: this one ended before writing it)")
    footer = (
        f"Status: {DEFAULT_STATE_DIR}/status-{group}.json · "
        f"journalctl -u camsocs-harvest@{group} · docs/ops-vps.md"
    )
    # A fence inside a log line would end the code block.
    shown = [line.replace("```", "'''") for line in lines]
    while True:
        if shown:
            block = "\n".join(shown)
            log_part = f"Last {len(shown)} lines of {log_path}:\n```\n{block}\n```"
        else:
            log_part = "(the log lines are too long to show)" if lines else "No log lines found."
        text = mask("\n".join([*body, log_part, footer]), known_secrets)
        if len(text) <= MAX_MESSAGE_CHARS or not shown:
            return text[:MAX_MESSAGE_CHARS]
        # Too long for a phone: the oldest lines go first.
        shown = shown[1:]


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
    log_dir = Path(environ.get("CAMSOCS_LOG_DIR") or DEFAULT_LOG_DIR)
    status = load_status(state_dir, group)
    log_path = find_log(log_dir, group, status)

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
    secret_files = [Path(p) for p in (environ.get("CAMSOCS_SECRET_FILES") or "").split(":") if p]
    known = secret_values(secret_files)
    known.update(v for v in (settings.get("SLACK_BOT_TOKEN"),) if v)

    text = build_message(
        group,
        environ=environ,
        status=status,
        log_path=log_path,
        lines=tail(log_path),
        host=socket.gethostname(),
        known_secrets=known,
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
