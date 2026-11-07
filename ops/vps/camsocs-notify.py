#!/usr/bin/env python3
"""New listing requests → Slack and WhatsApp through Mya (ENG-104).

Runbook: docs/ops-vps.md "Request notifications".

    camsocs-notify.py [--dry-run]

Run every minute by ``camsocs-notify.timer``. Convex cannot reach the VPS, so
the VPS asks: ``POST <CONVEX_HTTP_URL>/api/pipeline/notify/pending`` with the
channels this host can serve answers the open requests (and broker tests)
still owed on one of them; each is sent, and each channel's outcome goes back
to ``/api/pipeline/notify/ack``. Convex keeps the queue and the retry rules
(convex/notifications.ts): a channel that delivered is never offered again, a
failed one again after two minutes, three tries at most.

- **Slack**: Mya's bot (``SLACK_BOT_TOKEN``) posts to ``SLACK_HOME_CHANNEL``,
  else a DM to the first of ``SLACK_ALLOWED_USERS`` (as camsocs-alert.py).
- **WhatsApp**: Mya's WhatsApp bridge, which listens on 127.0.0.1:3000 inside
  her container only, through ``docker exec <container> curl … /send`` to the
  first number of ``WHATSAPP_ALLOWED_USERS``. Only ``POST /send``: never
  ``GET /messages``, which would take Mya's incoming messages off her queue.
  The bridge records what it sent, so Mya never reads these as input.
- **Credentials**: the env file ``CAMSOCS_NOTIFY_ENV`` names (default the unit's
  systemd credential ``notify-env``, a copy of the root-owned
  ``/etc/camsocs/notify.env`` that install.sh assembles from Mya's env file and
  production's pipeline env): the Slack values, ``WHATSAPP_ALLOWED_USERS``,
  ``CONVEX_HTTP_URL`` and ``PIPELINE_API_KEY``. Nothing else is read.
- **What is sent**: the request is the public's, so Convex sends facts and
  this script checks each one's shape and builds the text itself: the kind
  (one of five), the listing's name, the role, the submitter's *domain*, the
  proposed field names and a preview of at most 280 characters, each
  flattened to one line; for Slack ``&``, ``<`` and ``>`` are escaped and
  ``@`` becomes the full-width at sign (U+FF20), so no mention, link or
  ``<!channel>`` can form. The link is built here from the request's key
  (``lr-``/``nt-`` and hex only) and ``SITE`` — never taken from the answer.
- ``--dry-run`` prints what would be sent and sends and acknowledges nothing.

Standard library only (the host's python3). Exit 0 when the run finished
(failed sends included: Convex records them and the dashboard shows them),
1 when Convex could not be asked or the settings are wrong; the reason goes
to stderr (the journal) and never includes a secret.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api"
SITE = "https://camsocs.uk"
INBOX_PATH = "/dashboard/requests"
CREDENTIAL_NAME = "notify-env"
WANTED_KEYS = (
    "SLACK_BOT_TOKEN",
    "SLACK_HOME_CHANNEL",
    "SLACK_ALLOWED_USERS",
    "WHATSAPP_ALLOWED_USERS",
    "CONVEX_HTTP_URL",
    "PIPELINE_API_KEY",
)
#: Mya's container (docker compose project hermes-agent-vspa) and her bridge.
DEFAULT_CONTAINER = "hermes-agent-vspa-hermes-agent-1"
BRIDGE_SEND = "http://127.0.0.1:3000/send"
#: Production's Convex HTTP origin, and nothing else.
_CONVEX_SITE = re.compile(r"https://[a-z0-9-]{3,63}\.convex\.site")
_CONTAINER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_ID = re.compile(r"(?:lr|nt)-[0-9a-f]{8,40}")
_FIELD = re.compile(r"[A-Za-z][A-Za-z0-9.]{0,39}")
_PHONE = re.compile(r"\+?(\d{7,15})")
KINDS = {
    "claim": "Claim",
    "correct": "Correction",
    "remove": "Removal",
    "object": "Objection",
    "add": "New listing",
}
CHANNELS = ("slack", "whatsapp")
MAX_ITEMS = 10
PREVIEW = 280
HTTP_TIMEOUT = 20
WHATSAPP_TIMEOUT = 45
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f]")

Opener = Callable[..., Any]
Runner = Callable[..., subprocess.CompletedProcess]


#: What "@" becomes in Slack text, so "@here" or "@channel" notifies no one.
FULLWIDTH_AT = "\uff20"


class NotifyError(RuntimeError):
    """A send or a call failed; the message is safe to print and to store."""


# --- settings -----------------------------------------------------------------------------


def read_env(path: Path, keys: Iterable[str]) -> dict[str, str]:
    """``KEY=value`` lines of a dotenv file, only `keys`. Values are never logged."""
    wanted = set(keys)
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip().removeprefix("export ").strip()
        if name not in wanted:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[name] = value
    return values


def whatsapp_chat(settings: Mapping[str, str]) -> str | None:
    """The first of ``WHATSAPP_ALLOWED_USERS`` as a WhatsApp chat id, or None."""
    for entry in re.split(r"[,\s]+", settings.get("WHATSAPP_ALLOWED_USERS", "")):
        match = _PHONE.fullmatch(entry.strip())
        if match:
            return f"{match.group(1)}@s.whatsapp.net"
    return None


def served_channels(settings: Mapping[str, str], docker: str | None) -> list[str]:
    """The channels this host can send on."""
    channels = []
    if settings.get("SLACK_BOT_TOKEN") and (
        settings.get("SLACK_HOME_CHANNEL") or settings.get("SLACK_ALLOWED_USERS")
    ):
        channels.append("slack")
    if docker and whatsapp_chat(settings):
        channels.append("whatsapp")
    return channels


# --- what to say --------------------------------------------------------------------------


def flatten(value: Any, limit: int) -> str:
    """One line of at most `limit` characters from untrusted text."""
    text = _CONTROL.sub(" ", value if isinstance(value, str) else "")
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def slack_escape(text: str) -> str:
    """No link, mention or ``<!channel>`` can form; ``@here`` notifies no one."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("@", FULLWIDTH_AT)
    )


def checked(item: Any, served: Iterable[str]) -> dict[str, Any] | None:
    """The item's facts when every one has its shape, else None (skipped)."""
    if not isinstance(item, dict):
        return None
    item_id = item.get("id")
    kind = item.get("kind")
    if not isinstance(item_id, str) or not _ID.fullmatch(item_id) or kind not in KINDS:
        return None
    channels = [c for c in item.get("channels") or [] if c in served]
    fields = [f for f in item.get("fields") or [] if isinstance(f, str) and _FIELD.fullmatch(f)]
    return {
        "id": item_id,
        "test": item.get("test") is True,
        "kind": kind,
        "listing": flatten(item.get("listing"), 120) or "—",
        "role": flatten(item.get("role"), 60),
        "domain": flatten(item.get("fromDomain"), 100) or "?",
        "fields": fields[:10],
        "preview": flatten(item.get("preview"), PREVIEW),
        "channels": channels,
    }


def link(item_id: str) -> str:
    return f"{SITE}{INBOX_PATH}?request={item_id}"


def slack_text(facts: Mapping[str, Any]) -> str:
    tag = "[TEST] " if facts["test"] else ""
    who = f"{slack_escape(facts['role'])}, someone" if facts["role"] else "Someone"
    lines = [
        (
            f":inbox_tray: *{tag}New CAMsocs request* · {KINDS[facts['kind']]}: "
            f"{slack_escape(facts['listing'])}"
        ),
        f"{who} at {slack_escape(facts['domain'])} (address unverified)",
    ]
    if facts["fields"]:
        lines.append(f"Proposed: {', '.join(facts['fields'])}")
    if facts["preview"]:
        lines.append(f"> {slack_escape(facts['preview'])}")
    lines.append(f"<{link(facts['id'])}|Open the request>")
    return "\n".join(lines)


def whatsapp_text(facts: Mapping[str, Any]) -> str:
    tag = "[TEST] " if facts["test"] else ""
    who = f"{facts['role']}, " if facts["role"] else ""
    lines = [
        f"📥 {tag}New CAMsocs request",
        f"{KINDS[facts['kind']]}: {facts['listing']}",
        f"From {who}someone at {facts['domain']} (unverified)",
    ]
    if facts["fields"]:
        lines.append(f"Proposed: {', '.join(facts['fields'])}")
    if facts["preview"]:
        lines.append(f"“{facts['preview']}”")
    lines.append(link(facts["id"]))
    return "\n".join(lines)


# --- Convex -------------------------------------------------------------------------------


def convex_call(settings: Mapping[str, str], path: str, body: dict, opener: Opener) -> Any:
    base = settings.get("CONVEX_HTTP_URL", "").rstrip("/")
    key = settings.get("PIPELINE_API_KEY", "")
    if not _CONVEX_SITE.fullmatch(base) or not key:
        raise NotifyError(
            "CONVEX_HTTP_URL (https://<name>.convex.site) or PIPELINE_API_KEY is not set"
        )
    request = urllib.request.Request(
        f"{base}/api/pipeline/{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with opener(request, timeout=HTTP_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise NotifyError(f"{path}: HTTP {error.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise NotifyError(f"{path}: {type(error).__name__}") from None


# --- senders ------------------------------------------------------------------------------


def slack_call(method: str, token: str, payload: dict[str, Any], opener: Opener) -> dict:
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
        with opener(request, timeout=HTTP_TIMEOUT) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise NotifyError(f"slack {type(error).__name__}") from None
    if not isinstance(answer, dict) or not answer.get("ok"):
        code = answer.get("error", "no answer") if isinstance(answer, dict) else "no answer"
        raise NotifyError(f"slack {flatten(str(code), 40)}")
    return answer


class Slack:
    """Posts to the home channel, else a DM to the first allowed user (opened once)."""

    def __init__(self, settings: Mapping[str, str], opener: Opener) -> None:
        self.token = settings.get("SLACK_BOT_TOKEN", "")
        self.home = settings.get("SLACK_HOME_CHANNEL", "").strip()
        users = [u for u in re.split(r"[,\s]+", settings.get("SLACK_ALLOWED_USERS", "")) if u]
        self.user = users[0] if users else ""
        self.opener = opener
        self.channel = self.home or None

    def send(self, text: str) -> None:
        if self.channel is None:
            opened = slack_call("conversations.open", self.token, {"users": self.user}, self.opener)
            self.channel = (opened.get("channel") or {}).get("id") or None
            if not self.channel:
                raise NotifyError("slack no channel")
        slack_call(
            "chat.postMessage",
            self.token,
            {"channel": self.channel, "text": text, "unfurl_links": False, "unfurl_media": False},
            self.opener,
        )


def whatsapp_send(
    docker: str, container: str, chat_id: str, text: str, runner: Runner = subprocess.run
) -> None:
    """``POST /send`` on Mya's bridge, inside her container; the body on stdin."""
    body = json.dumps({"chatId": chat_id, "message": text})
    command = [
        docker, "exec", "-i", container,
        "curl", "-sS", "-m", "30", "-X", "POST",
        "-H", "Content-Type: application/json", "--data-binary", "@-", BRIDGE_SEND,
    ]  # fmt: skip
    try:
        done = runner(
            command,
            input=body,
            capture_output=True,
            text=True,
            timeout=WHATSAPP_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise NotifyError("whatsapp timeout") from None
    except OSError as error:
        raise NotifyError(f"whatsapp {type(error).__name__}") from None
    if done.returncode != 0:
        raise NotifyError(f"whatsapp exit {done.returncode}")
    try:
        answer = json.loads(done.stdout or "{}")
    except ValueError:
        raise NotifyError("whatsapp bad answer") from None
    if not isinstance(answer, dict) or answer.get("success") is not True:
        raise NotifyError("whatsapp not sent")


# --- one run ------------------------------------------------------------------------------


def run(
    settings: Mapping[str, str],
    *,
    container: str,
    docker: str | None,
    opener: Opener,
    runner: Runner = subprocess.run,
    dry_run: bool = False,
    out: Callable[[str], None] = print,
) -> int:
    served = served_channels(settings, docker)
    if not served:
        print(
            "camsocs-notify: no channel can be served (Slack or WhatsApp settings)", file=sys.stderr
        )
        return 1
    try:
        answer = convex_call(settings, "notify/pending", {"channels": served}, opener)
    except NotifyError as error:
        print(f"camsocs-notify: {error}", file=sys.stderr)
        return 1
    items = answer.get("items") if isinstance(answer, dict) else None
    slack = Slack(settings, opener)
    chat_id = whatsapp_chat(settings)
    for raw in (items if isinstance(items, list) else [])[:MAX_ITEMS]:
        facts = checked(raw, served)
        if facts is None:
            print("camsocs-notify: skipped an item of the wrong shape", file=sys.stderr)
            continue
        results = []
        for channel in facts["channels"]:
            if dry_run:
                out(
                    f"--- {channel} {facts['id']}\n"
                    + (slack_text(facts) if channel == "slack" else whatsapp_text(facts))
                )
                continue
            try:
                if channel == "slack":
                    slack.send(slack_text(facts))
                else:
                    assert docker is not None and chat_id is not None
                    whatsapp_send(docker, container, chat_id, whatsapp_text(facts), runner)
                results.append({"channel": channel, "ok": True})
            except NotifyError as error:
                results.append({"channel": channel, "ok": False, "error": str(error)[:80]})
        if results:
            sent = ", ".join(f"{r['channel']} {'ok' if r['ok'] else r['error']}" for r in results)
            out(f"camsocs-notify: {facts['id']}: {sent}")
            try:
                convex_call(settings, "notify/ack", {"id": facts["id"], "results": results}, opener)
            except NotifyError as error:
                print(f"camsocs-notify: ack failed: {error}", file=sys.stderr)
    return 0


def main(
    argv: list[str] | None = None,
    environ: Mapping[str, str] | None = None,
    opener: Opener = urllib.request.urlopen,
) -> int:
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    if any(a != "--dry-run" for a in argv):
        print("usage: camsocs-notify.py [--dry-run]", file=sys.stderr)
        return 64
    env_path = environ.get("CAMSOCS_NOTIFY_ENV") or str(
        Path(environ.get("CREDENTIALS_DIRECTORY") or "/nonexistent") / CREDENTIAL_NAME
    )
    try:
        settings = read_env(Path(env_path), WANTED_KEYS)
    except OSError as error:
        print(f"camsocs-notify: cannot read {env_path} ({error.strerror})", file=sys.stderr)
        return 1
    container = environ.get("CAMSOCS_MYA_CONTAINER") or DEFAULT_CONTAINER
    if not _CONTAINER.fullmatch(container):
        print("camsocs-notify: CAMSOCS_MYA_CONTAINER is not a container name", file=sys.stderr)
        return 1
    return run(
        settings,
        container=container,
        docker=shutil.which("docker"),
        opener=opener,
        dry_run="--dry-run" in argv,
    )


if __name__ == "__main__":
    sys.exit(main())
