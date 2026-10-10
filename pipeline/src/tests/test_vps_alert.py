"""The VPS runner's alert, status file and systemd units (decision D5,
docs/ops-vps.md): `ops/vps/camsocs-alert.py` builds a masked message and sends
it through the Slack Web API (a fake opener here, never the network),
`ops/vps/camsocs-status.py` writes the status, and the units say what the
runbook says.
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]
OPS = REPO / "ops" / "vps"
#: Fake tokens, assembled at run time so no token-shaped literal sits in the repo
#: (secret scanners flag those, real or not).
TOKEN = "-".join(["xoxb", "1234567890", "0987654321", "AbCdEfGhIjKlMnOpQrStUvWx"])
GITHUB_TOKEN = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789"


def script(name: str) -> ModuleType:
    """Import an ops script (its file name has hyphens) as a module."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), OPS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


alert = script("camsocs-alert")
status_writer = script("camsocs-status")


# --- masking ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, secret",
    [
        (f"posting with {TOKEN}", TOKEN),
        ("LLM_API_KEY=sk-live-abcdefghijklmnopqrstu", "sk-live-abcdefghijklmnopqrstu"),
        ('PIPELINE_API_KEY: "3f9a1c00ff"', "3f9a1c00ff"),
        ("Authorization: Bearer abc.def.ghi", "abc.def.ghi"),
        ("https://joshua:hunter2@example.org/feed.ics", "hunter2"),
        ("GET https://example.org/x?access_token=EAAB123&page=2", "EAAB123"),
        ('{"api_key": "plain-words"}', "plain-words"),
        ("password: correct-horse", "correct-horse"),
        (GITHUB_TOKEN, GITHUB_TOKEN),
        (
            "key " + "0123456789abcdef" * 4,  # openssl rand -hex 32
            "0123456789abcdef" * 4,
        ),
        ("token rotated: Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==", "Zm9vYmFyYmF6cXV4MTIz"),
    ],
)
def test_anything_key_or_token_like_is_masked(text: str, secret: str) -> None:
    masked = alert.mask(text)
    assert secret not in masked
    assert alert.MASK in masked


def test_ordinary_log_lines_stay_readable() -> None:
    lines = [
        "03:41:07 INFO     camsocs_pipeline.staging.store: staged 235 records → "
        "/opt/camsocs/var/staging/camdram.events/20261010T024104Z-f99a3d.jsonl",
        "  calendar_feeds: 219 new, 0 updated, 0 unchanged, 0 skipped",
        "    26 of 26 feeds read (22 disallowed by robots.txt, read as society content, D3)",
        "  keyed: 5 monkey=3 author: the society",
        "Error: One or more stages failed — see the report above.",
    ]
    for line in lines:
        assert alert.mask(line) == line


def test_known_secret_values_are_masked_wherever_they_appear(tmp_path: Path) -> None:
    env = tmp_path / ".env.prod"
    env.write_text(
        "# production\n"
        "CONVEX_HTTP_URL=https://cheerful-bandicoot-511.convex.site\n"
        "PIPELINE_API_KEY='shortish-key-1'\n"
        'export META_ACCESS_TOKEN="EAAGm0PX4ZCpsBA"\n'
    )
    known = alert.secret_values([env, tmp_path / "missing"])
    assert known == {"shortish-key-1", "EAAGm0PX4ZCpsBA"}, "URLs are not secrets"
    assert alert.mask("sent shortish-key-1 and EAAGm0PX4ZCpsBA", known) == "sent *** and ***"


def test_only_the_slack_keys_are_read_from_myas_env_file(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text(
        "OPENAI_API_KEY=sk-not-ours\n"
        f'SLACK_BOT_TOKEN="{TOKEN}"\n'
        "export SLACK_ALLOWED_USERS=U0AAA,U0BBB  # owners\n"
        "SLACK_HOME_CHANNEL=\n"
    )
    settings = alert.read_env(env, alert.WANTED_KEYS)
    assert settings == {
        "SLACK_BOT_TOKEN": TOKEN,
        "SLACK_ALLOWED_USERS": "U0AAA,U0BBB",
        "SLACK_HOME_CHANNEL": "",
    }


# --- the message ------------------------------------------------------------------------


def message(tmp_path: Path, *, environ: dict[str, str] | None = None, **status) -> str:
    log = tmp_path / "2026-10-10-events.log"
    log.write_text(
        "\n".join(f"line {n}" for n in range(1, 31))
        + f"\nhttpx error with Authorization: Bearer {TOKEN}\n"
        + "``` a fence in the log\n"
    )
    base = {
        "group": "events",
        "exitCode": 1,
        "phase": "pipeline",
        "commit": "0123456789ab",
        "runKey": "20261010T033000Z-abcdef",
        "startedAt": "2026-10-10T03:30:00Z",
        "finishedAt": "2026-10-10T03:52:10Z",
        "failedStages": ["calendar_feeds"],
        "invocationId": "inv-1",
        "logFile": str(log),
    }
    full_status = base | status
    return alert.build_message(
        "events",
        environ=environ
        or {
            "MONITOR_SERVICE_RESULT": "exit-code",
            "MONITOR_EXIT_CODE": "exited",
            "MONITOR_EXIT_STATUS": "1",
            "MONITOR_INVOCATION_ID": "inv-1",
        },
        status=full_status,
        log_path=log,
        lines=alert.tail(log),
        host="srv1608974",
        known_secrets=[TOKEN],
    )


def test_the_message_names_the_group_the_exit_and_the_last_twenty_lines(tmp_path: Path) -> None:
    text = message(tmp_path)

    assert "camsocs harvest *events* failed on srv1608974" in text
    assert "exit status 1 (exited, exit-code)" in text
    assert "phase: pipeline" in text and "commit 0123456789ab" in text
    assert "failed stages: calendar_feeds" in text
    assert "Last 20 lines of" in text
    # 32 lines in the log: the last 20 start at line 13.
    assert "line 13\n" in text and "line 12\n" not in text, "only the last 20 lines"
    assert TOKEN not in text and "Bearer ***" in text
    assert text.count("```") == 2, "a fence in the log cannot end the code block"


def test_a_status_file_from_an_earlier_run_is_not_presented_as_this_ones(
    tmp_path: Path,
) -> None:
    text = message(tmp_path, invocationId="inv-0")
    assert "from an earlier run" in text
    assert "phase: pipeline" not in text and "failed stages" not in text


# --- sending ----------------------------------------------------------------------------


class FakeSlack:
    """Stands in for urllib's urlopen: records requests, answers like Slack."""

    def __init__(self, answers: dict[str, dict]) -> None:
        self.answers = answers
        self.requests: list[tuple[str, dict, dict]] = []

    def __call__(self, request, timeout: float):
        method = request.full_url.rsplit("/", 1)[-1]
        self.requests.append((method, json.loads(request.data), dict(request.header_items())))
        return io.BytesIO(json.dumps(self.answers[method]).encode())


def test_without_a_home_channel_the_first_allowed_user_gets_a_dm() -> None:
    slack = FakeSlack(
        {
            "conversations.open": {"ok": True, "channel": {"id": "D0DM"}},
            "chat.postMessage": {"ok": True},
        }
    )
    settings = {"SLACK_BOT_TOKEN": TOKEN, "SLACK_ALLOWED_USERS": "U0AAA, U0BBB"}

    assert alert.send(settings, "hello", slack) == "D0DM"

    [(opened, first, headers), (posted, second, _)] = slack.requests
    assert (opened, first) == ("conversations.open", {"users": "U0AAA"})
    assert posted == "chat.postMessage" and second["channel"] == "D0DM"
    assert second["text"] == "hello"
    assert headers["Authorization"] == f"Bearer {TOKEN}"


def test_the_home_channel_wins_when_it_is_set() -> None:
    slack = FakeSlack({"chat.postMessage": {"ok": True}})
    settings = {
        "SLACK_BOT_TOKEN": TOKEN,
        "SLACK_HOME_CHANNEL": "C0HOME",
        "SLACK_ALLOWED_USERS": "U0AAA",
    }
    assert alert.send(settings, "hello", slack) == "C0HOME"
    assert [method for method, _, _ in slack.requests] == ["chat.postMessage"]


def test_slacks_refusal_is_reported_without_the_token() -> None:
    slack = FakeSlack({"chat.postMessage": {"ok": False, "error": "not_in_channel"}})
    with pytest.raises(alert.AlertError, match="not_in_channel") as raised:
        alert.send({"SLACK_BOT_TOKEN": TOKEN, "SLACK_HOME_CHANNEL": "C0"}, "x", slack)
    assert TOKEN not in str(raised.value)


def test_main_reads_the_credential_masks_and_sends(tmp_path: Path, capsys) -> None:
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    (credentials / "slack-env").write_text(
        f"SLACK_BOT_TOKEN={TOKEN}\nSLACK_ALLOWED_USERS=U0AAA\nOTHER_SECRET=abc\n"
    )
    state = tmp_path / "state"
    state.mkdir()
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "2026-10-10-full.log").write_text("stage failed\nLLM_API_KEY=sk-abcdefghijklmnopq\n")
    (state / "status-full.json").write_text(json.dumps({"phase": "update", "exitCode": 10}))
    slack = FakeSlack(
        {
            "conversations.open": {"ok": True, "channel": {"id": "D0DM"}},
            "chat.postMessage": {"ok": True},
        }
    )
    environ = {
        "CREDENTIALS_DIRECTORY": str(credentials),
        "CAMSOCS_STATE_DIR": str(state),
        "CAMSOCS_LOG_DIR": str(logs),
        "MONITOR_EXIT_STATUS": "10",
    }

    assert alert.main(["full"], environ, slack) == 0

    text = slack.requests[-1][1]["text"]
    assert "*full* failed" in text and "phase: update" in text and "stage failed" in text
    assert "sk-abcdefghijklmnopq" not in text
    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err


def test_main_without_its_env_file_fails_and_says_where_it_looked(tmp_path, capsys) -> None:
    environ = {"CAMSOCS_ALERT_ENV": str(tmp_path / "nope.env"), "CAMSOCS_STATE_DIR": str(tmp_path)}
    assert alert.main(["events"], environ, FakeSlack({})) == 1
    assert "nope.env" in capsys.readouterr().err


def test_a_dry_run_prints_the_message_and_sends_nothing(tmp_path: Path, capsys) -> None:
    environ = {"CAMSOCS_ALERT_ENV": str(tmp_path / "none"), "CAMSOCS_STATE_DIR": str(tmp_path)}
    slack = FakeSlack({})
    assert alert.main(["--dry-run", "events"], environ, slack) == 0
    assert slack.requests == []
    assert "camsocs harvest *events* failed" in capsys.readouterr().out


# --- the status file --------------------------------------------------------------------


def test_the_status_file_is_written_whole_from_the_run_summary(tmp_path: Path) -> None:
    summary = tmp_path / "run-events.json"
    summary.write_text(
        json.dumps(
            {
                "runKey": "r1",
                "summary": ["load: 3 new"],
                "warnings": ["_resolved was last staged 9 days ago"],
                "stages": [{"name": "load", "status": "failed"}],
                "coverage": {"listed": 793},
            }
        )
    )
    code = status_writer.main(
        [
            "--state-dir",
            str(tmp_path / "state"),
            "--group",
            "events",
            "--started",
            "2026-10-10T03:30:00Z",
            "--finished",
            "2026-10-10T03:40:00Z",
            "--exit-code",
            "1",
            "--phase",
            "pipeline",
            "--commit",
            "0123456789ab",
            "--log",
            "/var/log/camsocs/2026-10-10-events.log",
            "--run-summary",
            str(summary),
        ]
    )
    assert code == 0
    written = json.loads((tmp_path / "state" / "status-events.json").read_text())
    assert written == json.loads((tmp_path / "state" / "status.json").read_text())
    assert written["result"] == "failed" and written["failedStages"] == ["load"]
    assert written["summary"] == ["load: 3 new"] and written["coverage"] == {"listed": 793}
    assert written["warnings"] == ["_resolved was last staged 9 days ago"]
    assert not list((tmp_path / "state").glob(".*.tmp"))


@pytest.mark.parametrize(
    "code, result", [(0, "ok"), (1, "failed"), (10, "failed"), (124, "timed_out"), (143, "stopped")]
)
def test_exit_codes_have_names(code: int, result: str) -> None:
    assert status_writer.result_of(code) == result


def test_a_missing_or_broken_run_summary_leaves_the_run_fields_empty(tmp_path: Path) -> None:
    broken = tmp_path / "run.json"
    broken.write_text("{not json")
    assert status_writer.read_run_summary(broken) == {}
    assert status_writer.read_run_summary(tmp_path / "absent.json") == {}


# --- systemd units, logrotate and the installer -------------------------------------------


def unit(name: str) -> dict[str, list[str]]:
    """``Section.Key`` → every value it is given (systemd allows repeats)."""
    values: dict[str, list[str]] = {}
    section = ""
    for raw in (OPS / "systemd" / name).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("["):
            section = line.strip("[]")
            continue
        key, _, value = line.partition("=")
        values.setdefault(f"{section}.{key}", []).append(value)
    return values


def test_the_harvest_unit_runs_the_script_as_camsocs_hardened() -> None:
    harvest = unit("camsocs-harvest@.service")
    assert harvest["Service.Type"] == ["oneshot"]
    assert harvest["Service.User"] == ["camsocs"]
    assert harvest["Service.ExecStart"] == ["/opt/camsocs/ops/vps/camsocs-harvest.sh %i"]
    assert harvest["Unit.OnFailure"] == ["camsocs-alert@%i.service"]
    assert harvest["Service.ProtectSystem"] == ["strict"]
    assert harvest["Service.NoNewPrivileges"] == ["yes"]
    assert harvest["Service.PrivateTmp"] == ["yes"]
    writable = harvest["Service.ReadWritePaths"][0].split()
    assert writable == ["/opt/camsocs", "/var/lib/camsocs", "/var/log/camsocs"]
    assert "-/docker" in harvest["Service.InaccessiblePaths"][0].split()


def test_the_alert_unit_gets_myas_env_file_as_a_credential() -> None:
    sender = unit("camsocs-alert@.service")
    assert sender["Service.User"] == ["camsocs"]
    assert sender["Service.ExecStart"] == [
        "/usr/bin/python3 -I /opt/camsocs/ops/vps/camsocs-alert.py %i"
    ]
    assert sender["Service.LoadCredential"] == ["slack-env:/docker/hermes-agent-vspa/data/.env"]
    assert "CAMSOCS_ALERT_ENV=%d/slack-env" in sender["Service.Environment"]
    assert sender["Service.ProtectSystem"] == ["strict"]
    assert "Service.ReadWritePaths" not in sender, "the alert writes nothing"


@pytest.mark.parametrize(
    "timer, calendar, group",
    [
        ("camsocs-harvest-events.timer", "*-*-* 04:30:00 Europe/London", "events"),
        ("camsocs-harvest-full.timer", "Sun *-*-* 02:00:00 Europe/London", "full"),
    ],
)
def test_the_timers_fire_in_london_time_and_catch_up(timer: str, calendar: str, group: str) -> None:
    values = unit(timer)
    assert values["Timer.OnCalendar"] == [calendar]
    assert values["Timer.Persistent"] == ["true"]
    assert values["Timer.Unit"] == [f"camsocs-harvest@{group}.service"]
    assert values["Install.WantedBy"] == ["timers.target"]


def test_the_script_limits_are_two_and_six_hours() -> None:
    text = (OPS / "camsocs-harvest.sh").read_text()
    assert 'LIMIT="${CAMSOCS_TIMEOUT_EVENTS:-2h}"' in text
    assert 'LIMIT="${CAMSOCS_TIMEOUT_FULL:-6h}"' in text


def test_logs_go_after_ninety_days_as_the_camsocs_user() -> None:
    text = (OPS / "logrotate" / "camsocs").read_text()
    assert "/var/log/camsocs/*.log {" in text
    for directive in ("su camsocs camsocs", "minage 90", "rotate 0", "missingok", "nocreate"):
        assert directive in text


def test_the_installer_pins_pixi_and_installs_every_unit_from_the_checkout() -> None:
    text = (OPS / "install.sh").read_text()
    assert 'PIXI_VERSION="0.73.0"' in text
    assert re.search(r'PIXI_SHA256="[0-9a-f]{64}"', text)
    assert "sha256sum --check" in text
    assert '"$ROOT"/ops/vps/systemd/*' in text
    for timer in ("camsocs-harvest-events.timer", "camsocs-harvest-full.timer"):
        assert timer in text
    # It leaves Docker, Mya's container and cliproxy alone.
    commands = [
        line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")
    ]
    assert not any(re.search(r"(^|[\s;&|(])(docker|docker-compose)\s", line) for line in commands)
    assert "config.yaml" not in text and "8317" not in " ".join(
        line for line in commands if "LLM_BASE_URL" not in line
    )


def test_a_long_log_loses_its_oldest_lines_not_the_end_of_the_message(tmp_path: Path) -> None:
    log = tmp_path / "2026-10-10-events.log"
    log.write_text("\n".join(f"{n:02d} " + "x" * 280 for n in range(20)) + "\n")
    text = alert.build_message(
        "events",
        environ={},
        status={},
        log_path=log,
        lines=alert.tail(log),
        host="h",
    )
    assert len(text) <= alert.MAX_MESSAGE_CHARS
    assert text.count("```") == 2 and text.rstrip().endswith("docs/ops-vps.md")
    assert "19 xxx" in text and "00 xxx" not in text
